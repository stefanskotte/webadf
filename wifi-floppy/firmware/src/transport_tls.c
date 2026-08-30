// The real transport_t: mbedTLS over lwIP's altcp layer
// (LWIP_ALTCP_TLS_MBEDTLS -- see lwipopts.h). Device-only: test/run.sh
// excludes this file by name from the host build, so unlike
// test/transport_fake.c there is no host test exercising it directly.
// What stands in for that here is (a) the cross-build succeeding, and
// (b) matching transport.h's documented vtable semantics exactly, since
// every caller (device_client.c) was written and tested against
// transport_fake.c's behaviour for those same semantics.
//
// Concurrency model: NO_SYS=1, pico_cyw43_arch_lwip_threadsafe_background.
// lwIP's own processing (including every callback below) runs on a
// low-priority IRQ-driven context; this file's blocking calls are plain
// busy-wait loops (sleep_ms polling a flag with a deadline), same pattern
// http_fetch.c already uses for its raw-TCP fetch. Critically, the
// cyw43_arch_lwip_begin()/end() pair is a lock: it must only ever wrap a
// direct, synchronous lwIP/altcp call, never a sleep_ms() wait loop -- doing
// the latter would stop the background context from ever running, so the
// wait would never end.
#include "transport.h"
#include "tls_guard.h"
#include "sntp_time.h"
#include "roots.h"

#include "pico/cyw43_arch.h"
#include "pico/time.h"
#include "lwip/altcp.h"
#include "lwip/altcp_tls.h"
#include "lwip/dns.h"
#include "lwip/ip_addr.h"
#include "lwip/pbuf.h"
#include "mbedtls/ssl.h"

#include <string.h>

// transport.h only promises "negative on failure". Distinct codes cost
// nothing and let a future log line (task 10+) say *why* a fetch never
// started without instrumenting every call site.
#define TLS_ERR_TIME_UNSET          (-100) // sntp_time_valid() was false;
                                            // no handshake was attempted at
                                            // all -- see task-9-brief.md:
                                            // staying diskless beats
                                            // skipping expiry validation.
#define TLS_ERR_DNS                 (-101)
#define TLS_ERR_DNS_TIMEOUT         (-102)
#define TLS_ERR_TLS_CONFIG          (-103)
#define TLS_ERR_CONNECT             (-104)
#define TLS_ERR_HANDSHAKE_TIMEOUT   (-105)

#define DNS_TIMEOUT_MS       10000u
#define CONNECT_TIMEOUT_MS   15000u
#define WRITE_TIMEOUT_MS     10000u

typedef struct {
    struct altcp_pcb *pcb;

    volatile bool connected; // handshake done *and verified*: the SDK's
                              // mbedtls port only calls the "connected"
                              // callback passed to altcp_connect() once
                              // mbedtls_ssl_handshake() has returned
                              // success (altcp_tls_mbedtls.c: "upper
                              // connected is called when handshake is
                              // done") -- a failed verification under
                              // ALTCP_MBEDTLS_AUTHMODE_REQUIRED never gets
                              // here, it goes through on_err() instead.
    volatile bool closed;    // remote clean close, or an error below
    volatile int  err;       // 0, or a snapshot of the lwIP err_t seen

    volatile bool dns_done;
    volatile bool dns_ok;
    ip_addr_t     remote_ip;

    struct pbuf *rx_head;    // queued decrypted bytes not yet handed to
                              // the caller of read()
    uint16_t     rx_off;     // bytes already consumed out of rx_head
} tls_conn_t;

// mbedtls_config.h sets MBEDTLS_PLATFORM_MS_TIME_ALT because mbedtls's own
// default mbedtls_ms_time() only has a body for POSIX/Win32 and #errors on
// bare metal. This is a monotonic millisecond counter (handshake/session
// timing), unrelated to sntp_time.c's wall-clock time() -- no wall time is
// needed here at all.
mbedtls_ms_time_t mbedtls_ms_time(void) {
    return (mbedtls_ms_time_t)to_ms_since_boot(get_absolute_time());
}

static tls_conn_t g_conn;

// Created once, on first use, and never freed: the parsed root bundle and
// mbedtls_ssl_config it holds are immutable and connection-independent, so
// there is no reason to re-parse roots.h's 5-certificate PEM bundle (and
// reseed ctr_drbg) on every single connect() cycle. This device runs one
// process for its whole life between resets; leaking one static config for
// that lifetime is the normal embedded trade here, not an actual leak.
static struct altcp_tls_config *g_tls_config;

static void dns_found_cb(const char *name, const ip_addr_t *ipaddr, void *arg) {
    (void)name;
    tls_conn_t *c = (tls_conn_t *)arg;
    if (ipaddr) {
        c->remote_ip = *ipaddr;
        c->dns_ok = true;
    }
    c->dns_done = true;
}

static err_t on_connected(void *arg, struct altcp_pcb *pcb, err_t err) {
    (void)pcb;
    tls_conn_t *c = (tls_conn_t *)arg;
    if (err == ERR_OK) {
        c->connected = true;
    } else {
        c->err = (int)err;
        c->closed = true;
    }
    return ERR_OK;
}

static err_t on_recv(void *arg, struct altcp_pcb *pcb, struct pbuf *p, err_t err) {
    tls_conn_t *c = (tls_conn_t *)arg;
    if (err != ERR_OK) {
        if (p) pbuf_free(p);
        c->err = (int)err;
        c->closed = true;
        return ERR_OK;
    }
    if (!p) {
        c->closed = true; // remote closed cleanly (TLS close_notify or FIN)
        return ERR_OK;
    }
    altcp_recved(pcb, p->tot_len);
    if (c->rx_head) {
        pbuf_cat(c->rx_head, p);
    } else {
        c->rx_head = p;
        c->rx_off = 0;
    }
    return ERR_OK;
}

static void on_err(void *arg, err_t err) {
    tls_conn_t *c = (tls_conn_t *)arg;
    // lwIP has already freed the pcb by the time this fires. Every other
    // function below checks c->pcb before touching it, specifically so
    // none of them ever act on this now-dangling pointer.
    c->pcb = NULL;
    c->err = (int)err;
    c->closed = true;
}

// Deregister every callback before closing, so a pcb lingering in lwIP's
// own teardown (TIME_WAIT-equivalent) can never call back into a `c` that
// this transport has since reused for the next connect(). Same pattern
// http_fetch.c already uses (tcp_arg/tcp_recv(..., NULL) before tcp_close).
static void detach_and_close(struct altcp_pcb *pcb) {
    cyw43_arch_lwip_begin();
    altcp_arg(pcb, NULL);
    altcp_recv(pcb, NULL);
    altcp_err(pcb, NULL);
    altcp_close(pcb);
    cyw43_arch_lwip_end();
}

static int tls_connect(struct transport *t, const char *host, int port) {
    tls_conn_t *c = (tls_conn_t *)t->impl;
    if (c->rx_head) pbuf_free(c->rx_head);
    memset(c, 0, sizeof *c);

    // The single most important check in this file: refuse to even try a
    // handshake without a trustworthy clock. mbedtls verifies certificate
    // notBefore/notAfter against mbedtls_time() (-> time(), via
    // MBEDTLS_HAVE_TIME_DATE); before the first successful SNTP sync,
    // time() reads back an arbitrary post-boot value, which would make
    // expiry checking either meaninglessly always-pass or always-fail.
    if (!sntp_time_valid()) return TLS_ERR_TIME_UNSET;

    cyw43_arch_lwip_begin();
    err_t derr = dns_gethostbyname(host, &c->remote_ip, dns_found_cb, c);
    cyw43_arch_lwip_end();
    if (derr == ERR_OK) {
        c->dns_ok = true;
        c->dns_done = true;
    } else if (derr == ERR_INPROGRESS) {
        absolute_time_t deadline = make_timeout_time_ms(DNS_TIMEOUT_MS);
        while (!c->dns_done &&
               absolute_time_diff_us(get_absolute_time(), deadline) > 0) {
            sleep_ms(1);
        }
        if (!c->dns_done) return TLS_ERR_DNS_TIMEOUT;
    } else {
        return TLS_ERR_DNS;
    }
    if (!c->dns_ok) return TLS_ERR_DNS;

    if (!g_tls_config) {
        g_tls_config = altcp_tls_create_config_client(
            (const uint8_t *)root_ca_pem, root_ca_pem_len);
        if (!g_tls_config) return TLS_ERR_TLS_CONFIG;
    }

    cyw43_arch_lwip_begin();
    c->pcb = altcp_tls_new(g_tls_config, IPADDR_TYPE_V4);
    if (!c->pcb) {
        cyw43_arch_lwip_end();
        return TLS_ERR_TLS_CONFIG;
    }
    altcp_arg(c->pcb, c);
    altcp_recv(c->pcb, on_recv);
    altcp_err(c->pcb, on_err);

    // altcp_tls's mbedTLS port (altcp_tls_mbedtls.c) never sets SNI or
    // checks the peer hostname on its own -- ALTCP_MBEDTLS_AUTHMODE_REQUIRED
    // verifies the chain up to a trusted root but, without this, would
    // happily accept a perfectly valid certificate for a *different* host.
    // altcp_tls_context() returns the mbedtls_ssl_context* backing this pcb.
    mbedtls_ssl_context *ssl = (mbedtls_ssl_context *)altcp_tls_context(c->pcb);
    if (!ssl || mbedtls_ssl_set_hostname(ssl, host) != 0) {
        struct altcp_pcb *pcb = c->pcb;
        c->pcb = NULL;
        cyw43_arch_lwip_end();
        detach_and_close(pcb);
        return TLS_ERR_TLS_CONFIG;
    }

    err_t cerr = altcp_connect(c->pcb, &c->remote_ip, (u16_t)port, on_connected);
    cyw43_arch_lwip_end();
    if (cerr != ERR_OK) {
        struct altcp_pcb *pcb = c->pcb;
        c->pcb = NULL;
        detach_and_close(pcb);
        return TLS_ERR_CONNECT;
    }

    // Waits for the *full* TLS handshake, not just the TCP three-way
    // handshake: see on_connected()'s comment above.
    absolute_time_t deadline = make_timeout_time_ms(CONNECT_TIMEOUT_MS);
    while (!c->connected && !c->closed &&
           absolute_time_diff_us(get_absolute_time(), deadline) > 0) {
        sleep_ms(1);
    }
    if (c->connected) return 0;

    if (c->pcb) {
        struct altcp_pcb *pcb = c->pcb;
        c->pcb = NULL;
        detach_and_close(pcb);
    }
    return c->closed ? TLS_ERR_CONNECT : TLS_ERR_HANDSHAKE_TIMEOUT;
}

// transport.h: "Returns bytes accepted. ... a SHORT WRITE IS LEGAL and the
// client already loops on it." device_client.c treats any w <= 0 as a hard
// failure (it does not retry a zero), so unlike a raw POSIX socket this
// must block until it can accept at least one byte, rather than ever
// returning 0 for transient backpressure.
static int tls_write(struct transport *t, const uint8_t *b, int n) {
    tls_conn_t *c = (tls_conn_t *)t->impl;
    if (!c->pcb || c->closed || n <= 0) return -1;

    absolute_time_t deadline = make_timeout_time_ms(WRITE_TIMEOUT_MS);
    u16_t avail;
    for (;;) {
        if (!c->pcb || c->closed) return -1;
        cyw43_arch_lwip_begin();
        avail = altcp_sndbuf(c->pcb);
        cyw43_arch_lwip_end();
        if (avail > 0) break;
        if (absolute_time_diff_us(get_absolute_time(), deadline) <= 0) return -1;
        sleep_ms(1);
    }

    int to_write = (avail < (u16_t)n) ? (int)avail : n;
    cyw43_arch_lwip_begin();
    err_t werr = altcp_write(c->pcb, b, (u16_t)to_write, TCP_WRITE_FLAG_COPY);
    if (werr == ERR_OK) altcp_output(c->pcb);
    cyw43_arch_lwip_end();
    if (werr != ERR_OK) return -1;
    return to_write;
}

// transport.h: "Returns bytes read, 0 on clean close, negative on
// error/timeout." DC_POLL_TIMEOUT_MS is 30s and the server holds a poll
// open for 25s, so timeout_ms must be honoured to the millisecond, not
// approximated -- too short breaks a legitimately long poll, too long (or
// unbounded) breaks the retry/backoff loop above this transport.
static int tls_read(struct transport *t, uint8_t *b, int cap, int timeout_ms) {
    tls_conn_t *c = (tls_conn_t *)t->impl;
    if (cap <= 0) return 0;

    absolute_time_t deadline =
        make_timeout_time_ms(timeout_ms > 0 ? (uint32_t)timeout_ms : 0);
    while (!c->rx_head) {
        if (c->closed) return c->err ? -1 : 0;
        if (absolute_time_diff_us(get_absolute_time(), deadline) <= 0) return -1;
        sleep_ms(1);
    }

    int copied = 0;
    while (cap > 0 && c->rx_head) {
        struct pbuf *head = c->rx_head;
        int avail_here = (int)head->len - (int)c->rx_off;
        int n = (avail_here < cap) ? avail_here : cap;
        memcpy(b + copied, (const uint8_t *)head->payload + c->rx_off, (size_t)n);
        copied += n;
        cap -= n;
        c->rx_off = (uint16_t)(c->rx_off + n);
        if (c->rx_off >= head->len) {
            struct pbuf *rest = head->next;
            if (rest) pbuf_ref(rest); // keep 'rest' alive: pbuf_free below
                                       // only walks/frees while ref hits 0
            pbuf_free(head);
            c->rx_head = rest;
            c->rx_off = 0;
        }
    }
    return copied;
}

static void tls_close(struct transport *t) {
    tls_conn_t *c = (tls_conn_t *)t->impl;
    if (c->pcb) {
        struct altcp_pcb *pcb = c->pcb;
        c->pcb = NULL;
        detach_and_close(pcb);
    }
    if (c->rx_head) {
        pbuf_free(c->rx_head);
        c->rx_head = NULL;
    }
}

static transport_t g_transport = {
    .connect = tls_connect,
    .write   = tls_write,
    .read    = tls_read,
    .close   = tls_close,
    .impl    = &g_conn,
};

// The real transport_t for device use (task 10 wires this into
// device_client_t in place of test/transport_fake.c's fake_transport()).
transport_t *tls_transport(void) {
    return &g_transport;
}
