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
//
// Review round 1 finding (Critical, C2): an earlier version of this file
// read/mutated `rx_head`/`rx_off` and called pbuf_free() on them from
// tls_read()/tls_connect()/tls_close() *outside* that lock, while on_recv()
// (which runs on the background context) writes the very same fields. The
// window between freeing a pbuf and re-pointing rx_head at its successor
// was wide enough for on_recv() to run pbuf_cat() on now-freed memory and
// then have its own new data silently orphaned. Every read, mutation, and
// free of rx_head/rx_off below is now inside cyw43_arch_lwip_begin/end, so
// it can never interleave with on_recv() -- only the "is there anything to
// do yet" poll before the lock stays unlocked (same as the plain volatile
// bool polls in tls_connect()/tls_write() below), since a stale read there
// just means one extra 1ms loop iteration, not a memory-safety bug.
#include "transport.h"
#include "tls_guard.h"
#include "sntp_time.h"
#include "roots.h"

#include "pico/cyw43_arch.h"
#include "pico/time.h"
#include "wf_log.h"
#include "mbedtls/x509_crt.h"   // root-CA parse probe, see tls_connect()
#include "lwip/stats.h"          // 3z: pbuf/heap counters at the stall
#include "lwip/priv/altcp_priv.h" // 3z: reach the inner TCP pcb for rcv_wnd
#include "lwip/tcp.h"
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
#define TLS_ERR_BAD_ARG             (-106) // read() called with cap <= 0

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

    // Bumped once at the top of every tls_connect() call. dns_found_cb()
    // captures the generation a lookup was issued under (via g_dns_token,
    // below) and drops the result if this has since moved on -- review
    // round 1 finding (Minor): dns_gethostbyname() has no cancel API, so a
    // lookup that fires after tls_connect() already gave up on it
    // (TLS_ERR_DNS_TIMEOUT) or after this static struct has been reused
    // for a new attempt must not be allowed to write into whichever
    // attempt is live *now*.
    volatile uint32_t gen;

    struct pbuf *rx_head;    // queued decrypted bytes not yet handed to
                              // the caller of read() -- every access is
                              // under cyw43_arch_lwip_begin/end, see the
                              // file-header comment above.
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

// dns_gethostbyname()'s callback carries only the `arg` we hand it, and
// there is exactly one lookup in flight at a time (one connection at a
// time, matching this transport's single static tls_conn_t design) -- so
// one static token is enough. Set immediately before every
// dns_gethostbyname() call; see the `gen` comment on tls_conn_t above.
typedef struct {
    tls_conn_t *c;
    uint32_t    gen;
} dns_token_t;
static dns_token_t g_dns_token;

// Created once, on first use, and never freed: the parsed root bundle and
// mbedtls_ssl_config it holds are immutable and connection-independent, so
// there is no reason to re-parse roots.h's 5-certificate PEM bundle (and
// reseed ctr_drbg) on every single connect() cycle. This device runs one
// process for its whole life between resets; leaking one static config for
// that lifetime is the normal embedded trade here, not an actual leak.
static struct altcp_tls_config *g_tls_config;

static void dns_found_cb(const char *name, const ip_addr_t *ipaddr, void *arg) {
    (void)name;
    dns_token_t *tok = (dns_token_t *)arg;
    tls_conn_t *c = tok->c;
    if (tok->gen != c->gen) return; // stale: belongs to an attempt this
                                     // transport has already moved past.
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

// Runs on the background context. Every field it touches (`rx_head`,
// `rx_off` via the other functions below, `closed`, `err`) is either only
// ever written here and polled (not mutated) elsewhere as a plain volatile
// bool, or -- for rx_head/rx_off specifically -- only ever mutated
// elsewhere inside cyw43_arch_lwip_begin/end, which is what makes it safe
// for this callback (itself running under that same lock, implicitly, as
// part of lwIP's own dispatch) to touch them without a separate lock of
// its own.
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
    // NO altcp_recved() HERE -- see tls_read(), which calls it for the bytes
    // it actually hands to the application. Crediting the window on ARRIVAL
    // tells TCP "consumed" for data nobody has read yet, so the peer is never
    // throttled and the pbuf_cat chain below grows without bound. That is
    // invisible while every response is a few hundred bytes of poll JSON, and
    // wrong on the first big one. NOTE, recorded honestly: moving the credit
    // here did NOT fix the 2 MB image fetch (2026-09-10) -- that stalls at a
    // variable 43-57 KB and is still unexplained at the time of writing. This
    // change stands on its own terms regardless: crediting a window for bytes
    // no one has read is incorrect flow control and would bite under memory
    // pressure. Do not read it as the fix for the fetch stall.
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
// own teardown can never call back into a `c` that this transport has
// since reused for the next connect(). Same pattern http_fetch.c already
// uses (tcp_arg/tcp_recv(..., NULL) before tcp_close).
//
// Review round 1 finding (Important, I3): altcp_close()'s return value was
// previously ignored. altcp_close() can fail (ERR_MEM, if it can't queue
// the FIN) and leaves the pcb allocated -- with its callbacks already
// NULL'd, nothing would ever free it, and on a 25-30s poll loop that
// eventually exhausts MEMP_NUM_TCP_PCB and silently stops fetching. The
// SDK's own altcp_tls_mbedtls.c (around its close path) falls back to
// altcp_abort() when altcp_close() doesn't return ERR_OK; matched here.
static void detach_and_close(struct altcp_pcb *pcb) {
    cyw43_arch_lwip_begin();
    altcp_arg(pcb, NULL);
    altcp_recv(pcb, NULL);
    altcp_err(pcb, NULL);
    if (altcp_close(pcb) != ERR_OK) {
        altcp_abort(pcb);
    }
    cyw43_arch_lwip_end();
}

// Every failure exit below goes through this. tls_connect() already
// distinguishes seven causes -- clock, DNS, DNS timeout, config, connect,
// handshake timeout, bad arg -- and dc_register() then flattens ALL of them
// into DC_REG_RETRY, so from the console a dead root CA and an unplugged
// router looked identical (`register failed (rr=1)`). `detail` carries
// whatever the specific site knows: an lwIP err_t, or the err snapshot
// on_err() captured.
static int tls_fail(int code, const char *why, int detail) {
    wf_logf(WF_WARN, "tls: %s (code %d, detail %d)", why, code, detail);
    return code;
}

static int tls_connect(struct transport *t, const char *host, int port) {
    tls_conn_t *c = (tls_conn_t *)t->impl;
    uint32_t next_gen = c->gen + 1;

    cyw43_arch_lwip_begin();
    if (c->rx_head) {
        pbuf_free(c->rx_head);
        c->rx_head = NULL;
    }
    cyw43_arch_lwip_end();

    memset(c, 0, sizeof *c);
    c->gen = next_gen; // must survive the memset above

    // The single most important check in this file: refuse to even try a
    // handshake without a trustworthy clock. mbedtls verifies certificate
    // notBefore/notAfter against mbedtls_time() (-> time(), via
    // MBEDTLS_HAVE_TIME_DATE); before the first successful SNTP sync,
    // time() reads back an arbitrary post-boot value, which would make
    // expiry checking either meaninglessly always-pass or always-fail.
    if (!sntp_time_valid())
        return tls_fail(TLS_ERR_TIME_UNSET, "no clock, refusing handshake", 0);

    g_dns_token.c = c;
    g_dns_token.gen = c->gen;
    cyw43_arch_lwip_begin();
    err_t derr = dns_gethostbyname(host, &c->remote_ip, dns_found_cb, &g_dns_token);
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
        if (!c->dns_done)
            return tls_fail(TLS_ERR_DNS_TIMEOUT, "DNS timed out", DNS_TIMEOUT_MS);
    } else {
        return tls_fail(TLS_ERR_DNS, "DNS call refused", (int)derr);
    }
    if (!c->dns_ok) return tls_fail(TLS_ERR_DNS, "DNS did not resolve", 0);

    if (!g_tls_config) {
        g_tls_config = altcp_tls_create_config_client(
            (const uint8_t *)root_ca_pem, root_ca_pem_len);
        if (!g_tls_config) {
            // altcp_tls_create_config_client() reports failure as NULL and
            // nothing else, which is not enough to act on: a bundle whose
            // certs cannot be parsed and a heap too small to hold them look
            // identical. So parse the SAME buffer directly and report what
            // mbedtls actually said. Note mbedtls_x509_crt_parse() is
            // permissive -- a POSITIVE return is the number of certs in the
            // bundle that failed while others succeeded, and lwIP rejects the
            // whole config on any non-zero, so one bad cert kills all of it.
            static mbedtls_x509_crt probe;
            mbedtls_x509_crt_init(&probe);
            int pret = mbedtls_x509_crt_parse(
                &probe, (const unsigned char *)root_ca_pem, root_ca_pem_len);
            mbedtls_x509_crt_free(&probe);
            wf_logf(WF_ERR, "tls: root CA parse -> %d (>0 = certs rejected, "
                    "<0 = mbedtls error, 0 = bundle is fine so this is heap)",
                    pret);
            return tls_fail(TLS_ERR_TLS_CONFIG,
                            "altcp_tls_create_config_client failed",
                            (int)root_ca_pem_len);
        }
    }

    cyw43_arch_lwip_begin();
    c->pcb = altcp_tls_new(g_tls_config, IPADDR_TYPE_V4);
    if (!c->pcb) {
        cyw43_arch_lwip_end();
        return tls_fail(TLS_ERR_TLS_CONFIG, "altcp_tls_new failed (out of memory)", 0);
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
        return tls_fail(TLS_ERR_TLS_CONFIG, "mbedtls_ssl_set_hostname failed", 0);
    }

    err_t cerr = altcp_connect(c->pcb, &c->remote_ip, (u16_t)port, on_connected);
    cyw43_arch_lwip_end();
    if (cerr != ERR_OK) {
        struct altcp_pcb *pcb = c->pcb;
        c->pcb = NULL;
        detach_and_close(pcb);
        return tls_fail(TLS_ERR_CONNECT, "altcp_connect refused", (int)cerr);
    }

    // Waits for the *full* TLS handshake, not just the TCP three-way
    // handshake: see on_connected()'s comment above.
    absolute_time_t deadline = make_timeout_time_ms(CONNECT_TIMEOUT_MS);
    while (!c->connected && !c->closed &&
           absolute_time_diff_us(get_absolute_time(), deadline) > 0) {
        sleep_ms(1);
    }
    if (c->connected) {
        wf_logf(WF_INFO, "tls: handshake OK with %s:%d", host, port);
        return 0;
    }

    if (c->pcb) {
        struct altcp_pcb *pcb = c->pcb;
        c->pcb = NULL;
        detach_and_close(pcb);
    }
    // c->err is on_err()'s snapshot of the lwIP err_t -- the ONLY place the
    // real reason for a refused handshake survives.
    return c->closed
        ? tls_fail(TLS_ERR_CONNECT, "closed during handshake", (int)c->err)
        : tls_fail(TLS_ERR_HANDSHAKE_TIMEOUT, "handshake timed out", (int)c->err);
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
//
// Review round 1 (Minor): cap <= 0 previously returned 0, which the
// contract reserves for a clean close -- a caller passing a bad/zero
// buffer would misread that as "the peer hung up". Now negative.
static int tls_read(struct transport *t, uint8_t *b, int cap, int timeout_ms) {
    tls_conn_t *c = (tls_conn_t *)t->impl;
    if (cap <= 0) return TLS_ERR_BAD_ARG;

    absolute_time_t deadline =
        make_timeout_time_ms(timeout_ms > 0 ? (uint32_t)timeout_ms : 0);
    for (;;) {
        if (c->rx_head) break; // plain poll, unlocked: see file-header
                                // comment -- a stale "not yet" here just
                                // costs one more 1ms loop iteration.
        if (c->closed) return c->err ? -1 : 0;
        if (absolute_time_diff_us(get_absolute_time(), deadline) <= 0) {
            // 3z: THE moment of the stall. Nothing has arrived for the whole
            // timeout while the peer still holds most of the body, so whatever
            // went wrong has already gone wrong -- these counters are the only
            // record of it. `err` is the discriminator: a non-zero pbuf-pool or
            // heap err means an allocation failed and packets were dropped,
            // which lwIP surfaces nowhere else; all-zero errs point at the
            // receive window instead.
            wf_logf(WF_WARN, "tls: read timeout -- pbuf used=%u max=%u err=%u, "
                    "heap used=%u max=%u err=%u, tcp drop=%u memerr=%u",
                    (unsigned)lwip_stats.memp[MEMP_PBUF_POOL]->used,
                    (unsigned)lwip_stats.memp[MEMP_PBUF_POOL]->max,
                    (unsigned)lwip_stats.memp[MEMP_PBUF_POOL]->err,
                    (unsigned)lwip_stats.mem.used,
                    (unsigned)lwip_stats.mem.max,
                    (unsigned)lwip_stats.mem.err,
                    (unsigned)lwip_stats.tcp.drop,
                    (unsigned)lwip_stats.tcp.memerr);
            // The actual receive window, read off the inner TCP pcb. altcp_tls
            // credits the LOWER layer with PLAINTEXT byte counts
            // (altcp_mbedtls_pass_rx_data adds the decrypted tot_len to
            // rx_passed_unrecved, and altcp_mbedtls_recved forwards that same
            // number to altcp_recved on inner_conn), while TCP actually
            // received ciphertext. If that shortfall is what stalls us, rcv_wnd
            // is at or near zero here; if it is healthy, the peer went quiet
            // for some other reason and this rules the window out.
            {
                struct altcp_pcb *inner = c->pcb ? c->pcb->inner_conn : NULL;
                struct tcp_pcb *tp = inner ? (struct tcp_pcb *)inner->state : NULL;
                if (tp) {
                    wf_logf(WF_WARN, "tls: rcv_wnd=%u ann=%u (TCP_WND=%u) state=%d",
                            (unsigned)tp->rcv_wnd, (unsigned)tp->rcv_ann_wnd,
                            (unsigned)TCP_WND, (int)tp->state);
                } else {
                    wf_logf(WF_WARN, "tls: no inner tcp pcb to inspect");
                }
            }
            return -1;
        }
        sleep_ms(1);
    }

    // Review round 1 finding (Critical, C2): this whole drain -- reading
    // rx_head/rx_off, freeing a fully-consumed pbuf, and re-pointing
    // rx_head at its successor -- used to run outside the lock. on_recv()
    // (background context) mutates the same fields via pbuf_cat(); without
    // the lock, on_recv() firing between pbuf_free(head) and the
    // reassignment below could run pbuf_cat() on freed memory and then
    // have its own new pbuf orphaned (rx_head overwritten out from under
    // it). Locked for the whole sequence now.
    int copied = 0;
    cyw43_arch_lwip_begin();
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
    // Flow control belongs HERE, at consumption: these are the bytes the
    // application has actually taken, so this is the only point at which the
    // receive window can honestly be reopened. With TCP_WND at 8*TCP_MSS the
    // server now pauses when this loop falls behind, which is what keeps a
    // 2 MB body bounded in a 16 KB lwIP heap.
    if (copied > 0) altcp_recved(c->pcb, (u16_t)copied);
    cyw43_arch_lwip_end();
    return copied;
}

static void tls_close(struct transport *t) {
    tls_conn_t *c = (tls_conn_t *)t->impl;
    if (c->pcb) {
        struct altcp_pcb *pcb = c->pcb;
        c->pcb = NULL;
        detach_and_close(pcb); // deregisters arg/recv/err first, so
                                // on_recv() cannot fire for this `c` again
                                // after this returns.
    }
    cyw43_arch_lwip_begin();
    if (c->rx_head) {
        pbuf_free(c->rx_head);
        c->rx_head = NULL;
    }
    cyw43_arch_lwip_end();
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
