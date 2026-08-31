// The lwIP/cyw43 glue for the provisioning portal (see portal_net.h).
// Device-only: test/run.sh excludes this file by name, same as
// transport_tls.c and sntp_time.c, since it pulls in pico-sdk and lwIP's
// raw API and has no host-portable logic of its own -- everything it
// calls (dhcp_handle, dns_handle, portal_request) is pure and already
// host-tested; this file only wires those pure functions to real sockets.
//
// --- Concurrency model -----------------------------------------------
// Same NO_SYS=1 / pico_cyw43_arch_lwip_threadsafe_background setup as
// transport_tls.c, and the same rule applies: lwIP calls made from
// *foreground* code (portal_run()'s own setup and its blocking wait loop,
// portal_stop()'s teardown) must be bracketed in
// cyw43_arch_lwip_begin()/end(); lwIP calls made from *inside* an lwIP
// callback (every udp_recv_fn/tcp_*_fn below) are already running on that
// same locked context and must NOT be re-wrapped -- cyw43_arch.h's own
// doc for cyw43_arch_lwip_begin says as much ("not necessary but
// harmless" from within a callback; the necessary direction is the one
// that matters here). See pico/cyw43_arch.h's top-of-file threading
// model comment and transport_tls.c's header comment for the fuller
// version of this rule and the review-round-1 defect (a use-after-free
// with silent data loss) that not following it caused there.
//
// The one shared, compound piece of state this file hands from a
// background callback to portal_run()'s foreground blocking loop is
// `g_pending_cfg`/`g_submitted`: the HTTP recv callback (background)
// writes the whole device_config_t into g_pending_cfg and only then sets
// g_submitted, so a foreground read that observes g_submitted true is
// guaranteed to see a fully-written g_pending_cfg alongside it -- same
// "write the payload, then flip the flag that publishes it" ordering
// transport_tls.c's on_connected()/on_recv() use for c->connected/
// c->rx_head. The foreground side polls g_submitted unlocked first (a
// stale read there just costs one more loop iteration, exactly like
// tls_read()'s and tls_connect()'s polls), then takes the lock to copy
// g_pending_cfg out -- the struct copy itself doesn't need lwIP's lock to
// be correct (nothing will write g_pending_cfg again once g_submitted is
// true), but taking it anyway keeps this file to one rule -- "touch
// cross-context state only under the lock" -- rather than two.
//
// --- TCP request accumulation -----------------------------------------
// Each accepted connection gets a fixed-size slot (no malloc/free -- see
// below) holding a `req` buffer. Every arriving segment is appended to it
// and the WHOLE accumulated prefix is rescanned for "\r\n\r\n" from the
// start; that is O(request size) per segment rather than O(1), which
// would matter for a multi-megabyte stream but not for a form that is at
// most a few hundred bytes arriving over a handful of segments -- kept
// this way because it needs no additional bookkeeping to get right when
// a segment splits the terminator itself (e.g. one segment ends in "\r\n\r"
// and the next starts with "\n"): a fresh scan of the concatenated buffer
// finds it either way, with nothing special to handle at the split point.
// Once found, Content-Length is parsed from the header block and
// accumulation continues until that many body bytes have *also* arrived
// -- the brief's "accumulate until the headers end" is necessarily read
// this way, not literally: portal_http.h's contract is that an
// over-length field is rejected outright, never truncated, and calling
// portal_request() with a body that stopped mid-field (because it hadn't
// all arrived yet) would truncate a real submission indistinguishably
// from a bad one. If the request (headers or body) would not fit in the
// fixed buffer at all, the connection is refused with a fixed
// "413 Payload Too Large" and closed -- see TOO_LARGE_RESPONSE below.
//
// --- Resource discipline ------------------------------------------------
// No dynamic allocation anywhere in this file: the DHCP/DNS pcbs and the
// TCP listen pcb are each a single static pointer, and TCP connections
// come from a small fixed pool (g_http_conns) rather than mem_malloc'd
// per-connection state. This sidesteps the defect class the brief calls
// out (an ignored altcp_close() return leaking a pcb with its callbacks
// already nulled) for the pool slots themselves -- there is nothing to
// leak, only to mark unused again -- but the *pcbs* lwIP itself owns
// still need the same close-then-abort-on-failure discipline
// transport_tls.c's detach_and_close() uses, so finish_conn() below
// follows it exactly (arg/recv/sent/err/poll all deregistered before
// tcp_close(), tcp_abort() as the fallback when tcp_close() cannot queue
// a FIN, and every one of that callback's return paths reports ERR_ABRT
// when (and only when) it actually called tcp_abort() -- the raw tcp API
// callback contract is emphatic that misreporting this is unsafe: "Only
// return ERR_ABRT if you have called tcp_abort from within the callback
// function!").
//
// --- Why DHCP replies are always broadcast ------------------------------
// A DHCPOFFER/DHCPACK's client (yiaddr) has no IP configured yet, so
// unicasting the reply there would need an ARP resolution for an address
// nobody can answer for. Real DHCP servers solve this with a raw socket
// that injects a static ARP entry or writes the reply at the link layer
// directly; lwIP's ordinary udp_sendto() offers neither, and building
// either from scratch is a lot of machinery for an AP with at most
// DHCP_POOL_SIZE clients on it. Every reply here is instead broadcast to
// 255.255.255.255:68 -- link-layer broadcast needs no ARP resolution --
// which is the same simplification other minimal AP-mode DHCP servers in
// the lwIP/embedded space make. The lease pool's own client
// disambiguates by chaddr, and any DHCP client tolerates receiving (and
// ignoring) a broadcast reply that isn't its own transaction.
//
// --- Setup failure has no return path ----------------------------------
// portal_run() has two defined outcomes (a submission arrived, or the
// caller's inactivity window elapsed -- portal_net.h's
// portal_run_result_t), and neither of them is "the very first
// udp_new()/tcp_new() of this device's life failed"; there is nothing
// meaningful to hand a caller back for that.
// main.c already sets the precedent for treating that class of failure
// as unrecoverable rather than inventing a signalling path for it:
// `if (cyw43_arch_init()) while (1) tight_loop_contents();`. Every setup
// step below that can fail follows the same rule via fatal_setup_failure().
#include "portal_net.h"
#include "dhcp_server.h"
#include "dns_server.h"
#include "portal_http.h"

#include "pico/cyw43_arch.h"
#include "pico/platform.h"   // tight_loop_contents(), see fatal_setup_failure()
#include "pico/time.h"
#include "lwip/udp.h"
#include "lwip/tcp.h"
#include "lwip/pbuf.h"
#include "lwip/ip_addr.h"
#include "lwip/netif.h"   // netif_set_default(), see portal_stop()'s CRITICAL fix

#include <stdint.h>
#include <string.h>
#include <stdio.h>

#define DHCP_SERVER_PORT 67
#define DHCP_CLIENT_PORT 68
#define DNS_SERVER_PORT  53
#define HTTP_SERVER_PORT 80

#define DGRAM_CAP 512   // generous for a BOOTP/DHCP or DNS packet; both
                         // dhcp_handle()/dns_handle() refuse (return 0)
                         // rather than overrun a smaller `cap` anyway.

#define MAX_HTTP_CONNS 3      // a phone's captive-portal detection can
                               // open more than one probe connection at
                               // once; a few slots is enough headroom for
                               // that without inviting real exhaustion.
#define TCP_REQ_CAP  2048      // headers + body; see the accumulation
                               // comment above for what "too large" does.
#define TCP_RESP_CAP 2048      // portal_http.c's largest rendered page is
                               // 1339 B fully substituted (re-measured
                               // against PAGE_FMT + a full MAC + a
                               // buffer-filling err block; its second
                               // template, the accepted-submit
                               // confirmation page, is 938 B). This leaves
                               // comfortable headroom without costing much
                               // RAM.

#define HTTP_POLL_INTERVAL 6      // tcp_poll() units are ~500 ms each
                                   // (lwIP's coarse timer) -- 6 is ~3 s.
#define HTTP_IDLE_POLL_LIMIT 10    // ~30 s of a connection sitting open
                                   // with neither new data nor a response
                                   // in flight -- reclaim the slot rather
                                   // than hold it (and its buffers) for a
                                   // client that opened a socket and never
                                   // followed through.

static struct udp_pcb *g_dhcp_pcb;
static struct udp_pcb *g_dns_pcb;
static struct tcp_pcb *g_http_listen_pcb;

// Written by the HTTP recv callback (background), read by portal_run()'s
// foreground wait loop -- see the file header comment on the ordering
// that makes this safe.
static volatile bool   g_submitted;
static device_config_t g_pending_cfg;

// Set once by portal_run() before any socket exists (so there is no
// concurrent reader yet) and only read afterwards -- effectively
// read-only for the rest of this call, like an ordinary parameter, even
// though the HTTP callback reads it from a different context.
static const char *g_current_err;

// Final-review Important 2: portal_run()'s wait is now bounded, so it
// needs to know whether anyone is actually out there. This is a
// milliseconds-since-boot stamp of the last packet received from any
// client on the AP -- DHCP, DNS or HTTP alike -- written from background
// (lwIP callback) context and read from portal_run()'s foreground loop.
//
// A single aligned uint32_t: the read and the write are each one
// instruction on this core, so a reader never sees a torn value, and the
// only thing a stale read can do is extend the wait by one 5 ms tick,
// which is the harmless direction. Comparisons use unsigned subtraction
// (now - stamp), so the ~49.7-day wrap of to_ms_since_boot()'s 32-bit
// value is a non-event rather than a 49-day hang.
static volatile uint32_t g_last_activity_ms;

static void note_client_activity(void) {
    g_last_activity_ms = to_ms_since_boot(get_absolute_time());
}

typedef struct {
    // volatile: portal_run()'s foreground loop polls this (via
    // any_http_conn_in_use()) to refuse to time out while a request is in
    // flight, while lwIP callbacks on the background context set and clear
    // it. Without the qualifier the compiler is free to hoist the read out
    // of that loop and never observe a connection at all.
    volatile bool    in_use;
    struct tcp_pcb  *pcb;
    char             req[TCP_REQ_CAP];
    int              req_used;
    int              header_end;      // index just past "\r\n\r\n", or -1
    int              content_length;  // valid once header_end >= 0
    char             resp[TCP_RESP_CAP];
    int              resp_len;
    int              resp_sent;
    int              poll_ticks;
    bool             handled;      // set once a response has started --
                                   // see start_response()'s comment (MINOR 2
                                   // review-round-1 fix: blocks a later
                                   // segment from re-entering
                                   // handle_complete_request()).
} http_conn_t;

static http_conn_t g_http_conns[MAX_HTTP_CONNS];

static const char TOO_LARGE_RESPONSE[] =
    "HTTP/1.1 413 Payload Too Large\r\nConnection: close\r\n\r\n";

// See the file header comment: matches main.c's own precedent for a
// setup-time failure this early in the device's life (cyw43_arch_init()
// failing) -- there is no recovery path worth inventing for it.
static void fatal_setup_failure(void) {
    while (1) tight_loop_contents();
}

static void format_mac_colon(char *out, size_t out_len) {
    uint8_t mac[6] = {0};
    cyw43_wifi_get_mac(&cyw43_state, CYW43_ITF_STA, mac);
    snprintf(out, out_len, "%02x:%02x:%02x:%02x:%02x:%02x",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

// ---------------------------------------------------------------- DHCP

static void dhcp_recv_cb(void *arg, struct udp_pcb *pcb, struct pbuf *p,
                          const ip_addr_t *addr, u16_t port) {
    (void)arg; (void)addr; (void)port;
    note_client_activity();   // somebody is on the AP -- see portal_run()
    uint8_t req[DGRAM_CAP];
    u16_t n = pbuf_copy_partial(p, req, DGRAM_CAP, 0);
    pbuf_free(p);

    uint8_t rep[DGRAM_CAP];
    int rlen = dhcp_handle(req, (int)n, rep, sizeof rep);
    if (rlen <= 0) return;

    struct pbuf *out = pbuf_alloc(PBUF_TRANSPORT, (u16_t)rlen, PBUF_RAM);
    if (!out) return; // OOM: drop the reply, same as a lost packet -- the
                       // DHCP client's own retry timer covers this.
    memcpy(out->payload, rep, (size_t)rlen);
    // Always broadcast -- see the file header comment on why.
    udp_sendto(pcb, out, IP_ADDR_BROADCAST, DHCP_CLIENT_PORT);
    pbuf_free(out); // udp_sendto() never takes ownership of the pbuf --
                     // "Sends the pbuf p using UDP. The pbuf is not
                     // deallocated." (lwIP's own udp_send() doc, which
                     // udp_sendto() shares) -- so this is required on
                     // every path, not just the error one.
}

// ----------------------------------------------------------------- DNS

static void dns_recv_cb(void *arg, struct udp_pcb *pcb, struct pbuf *p,
                         const ip_addr_t *addr, u16_t port) {
    (void)arg;
    note_client_activity();   // somebody is on the AP -- see portal_run()
    uint8_t req[DGRAM_CAP];
    u16_t n = pbuf_copy_partial(p, req, DGRAM_CAP, 0);
    pbuf_free(p);

    uint8_t rep[DGRAM_CAP];
    int rlen = dns_handle(req, (int)n, rep, sizeof rep);
    if (rlen <= 0) return;

    struct pbuf *out = pbuf_alloc(PBUF_TRANSPORT, (u16_t)rlen, PBUF_RAM);
    if (!out) return;
    memcpy(out->payload, rep, (size_t)rlen);
    udp_sendto(pcb, out, addr, port); // ordinary request/response: the
                                       // querying client already has an
                                       // IP (DHCP ran first), so replying
                                       // straight to its source address
                                       // needs no broadcast workaround.
    pbuf_free(out);
}

// ------------------------------------------------------------- TCP/HTTP

// Deregisters every callback before closing, so a pcb lingering in lwIP's
// own teardown can never call back into an `http_conn_t` this pool has
// since reused for another connection -- same reasoning and same order
// as transport_tls.c's detach_and_close(). Frees the slot regardless of
// which branch closes the pcb. Callers in an lwIP callback MUST return
// this function's result directly: ERR_ABRT here means tcp_abort() ran,
// and the raw tcp API requires callbacks that call tcp_abort() to report
// exactly that, never ERR_OK, so lwIP does not touch the (now freed) pcb
// again.
static err_t finish_conn(http_conn_t *c) {
    struct tcp_pcb *pcb = c->pcb;
    c->pcb = NULL;
    c->in_use = false;
    if (!pcb) return ERR_OK;
    tcp_arg(pcb, NULL);
    tcp_recv(pcb, NULL);
    tcp_sent(pcb, NULL);
    tcp_err(pcb, NULL);
    tcp_poll(pcb, NULL, 0);
    if (tcp_close(pcb) == ERR_OK) return ERR_OK;
    // tcp_close() can fail to enqueue the FIN (e.g. ERR_MEM) and leaves
    // the pcb allocated; with callbacks already nulled above nothing
    // would ever free it otherwise -- see the file header comment and
    // transport_tls.c's detach_and_close(), which this mirrors.
    tcp_abort(pcb);
    return ERR_ABRT;
}

// Sends as much of c->resp[c->resp_sent .. c->resp_len) as tcp_sndbuf()
// currently allows and finishes the connection once it has all gone out.
// Not a blocking loop -- this runs inside lwIP callbacks (recv/sent/poll)
// where blocking would stall the very context that would make room. If
// tcp_write() can't take anything right now (ERR_MEM, or no window at
// all), it simply returns ERR_OK and leaves resp_sent unchanged; the next
// tcp_sent_fn (once the peer ACKs something) or the idle poll retries.
static err_t try_send_more(http_conn_t *c) {
    if (!c->pcb) return ERR_OK;
    int remaining = c->resp_len - c->resp_sent;
    if (remaining <= 0) return finish_conn(c);

    u16_t avail = tcp_sndbuf(c->pcb);
    int chunk = ((int)avail < remaining) ? (int)avail : remaining;
    if (chunk <= 0) return ERR_OK;

    err_t werr = tcp_write(c->pcb, c->resp + c->resp_sent, (u16_t)chunk,
                            TCP_WRITE_FLAG_COPY);
    if (werr != ERR_OK) return ERR_OK; // retry later, see comment above
    c->resp_sent += chunk;
    tcp_output(c->pcb);
    if (c->resp_sent >= c->resp_len) return finish_conn(c);
    return ERR_OK;
}

// `data` is either c->resp itself (the normal path: portal_request()
// already rendered straight into it) or one of the small fixed literals
// above (TOO_LARGE_RESPONSE) -- copied in only for that second case.
static err_t start_response(http_conn_t *c, const char *data, int len) {
    // Review round 1 (Minor): every response-producing path (this one,
    // both TOO_LARGE_RESPONSE call sites, and the normal
    // handle_complete_request() path) funnels through here, so setting
    // the flag in this one place is enough to stop try_progress() from
    // ever re-entering handle_complete_request() for a later segment on
    // this connection (pipelined bytes, a retransmit) -- which would
    // otherwise re-run portal_request(), clobber c->resp mid-send, and
    // for a POST /save, re-publish g_pending_cfg a second time.
    c->handled = true;
    int cap = (int)sizeof(c->resp);
    int n = (len < cap) ? len : cap;
    if (data != c->resp) memcpy(c->resp, data, (size_t)n);
    c->resp_len = n;
    c->resp_sent = 0;
    return try_send_more(c);
}

static bool ci_prefix(const char *s, int slen, const char *prefix) {
    int plen = (int)strlen(prefix);
    if (plen > slen) return false;
    for (int i = 0; i < plen; i++) {
        char a = s[i], b = prefix[i];
        if (a >= 'A' && a <= 'Z') a = (char)(a - 'A' + 'a');
        if (b >= 'A' && b <= 'Z') b = (char)(b - 'A' + 'a');
        if (a != b) return false;
    }
    return true;
}

// Scans header block hdr[0..hdr_len) for a "Content-Length:" line and
// returns its value, or 0 if absent/unparsable (a GET has none; a
// malformed value is treated the same as absent rather than aborting the
// connection over a header this file doesn't otherwise need). Saturates
// rather than overflowing on a pathological number of digits -- the
// caller's own bound check against the fixed request buffer rejects
// anything that large anyway.
static int parse_content_length(const char *hdr, int hdr_len) {
    static const char KEY[] = "content-length:";
    int keylen = (int)sizeof(KEY) - 1;
    for (int i = 0; i < hdr_len; i++) {
        if (i != 0 && hdr[i - 1] != '\n') continue;
        if (!ci_prefix(hdr + i, hdr_len - i, KEY)) continue;
        int j = i + keylen;
        while (j < hdr_len && (hdr[j] == ' ' || hdr[j] == '\t')) j++;
        long v = 0;
        bool any = false;
        while (j < hdr_len && hdr[j] >= '0' && hdr[j] <= '9') {
            if (v > (1L << 30)) { v = (1L << 30); break; } // saturate
            v = v * 10 + (hdr[j] - '0');
            j++;
            any = true;
        }
        return any ? (int)v : 0;
    }
    return 0;
}

static int find_header_end(const char *buf, int used) {
    for (int i = 0; i + 3 < used; i++) {
        if (buf[i] == '\r' && buf[i + 1] == '\n' &&
            buf[i + 2] == '\r' && buf[i + 3] == '\n') {
            return i + 4;
        }
    }
    return -1;
}

// Splits "METHOD PATH HTTP/1.1" (the only line this needs from the
// request). Truncates rather than rejecting if a token is longer than
// the destination -- unlike portal_http.h's form fields, `method`/`path`
// here are only used to pick a route and to echo back in a redirect;
// portal_request() treats anything it doesn't recognise as "redirect to
// the portal root" regardless, so a truncated garbage path is still
// handled safely, just not usefully -- there is nothing sensitive to get
// wrong by truncating it.
static void parse_request_line(const char *buf, int header_end,
                                char *method, int method_cap,
                                char *path, int path_cap) {
    method[0] = '\0';
    path[0] = '\0';
    int i = 0;
    int m = 0;
    while (i < header_end && buf[i] != ' ' && buf[i] != '\r' && buf[i] != '\n') {
        if (m < method_cap - 1) method[m++] = buf[i];
        i++;
    }
    method[m] = '\0';
    while (i < header_end && buf[i] == ' ') i++;
    int p = 0;
    while (i < header_end && buf[i] != ' ' && buf[i] != '\r' && buf[i] != '\n') {
        if (p < path_cap - 1) path[p++] = buf[i];
        i++;
    }
    path[p] = '\0';
}

static err_t handle_complete_request(http_conn_t *c) {
    c->req[c->req_used] = '\0'; // room for this is reserved -- see the
                                 // "-1" in http_recv_cb's `avail` below.
    char method[8];
    char path[192];
    parse_request_line(c->req, c->header_end, method, sizeof method,
                        path, sizeof path);
    const char *body = c->req + c->header_end;

    char mac_str[18];
    format_mac_colon(mac_str, sizeof mac_str);

    portal_result_t res;
    int n = portal_request(method, path, body, mac_str, g_current_err,
                            c->resp, (int)sizeof c->resp, &res);

    if (n <= 0) {
        // portal_request()'s "would not fit" case. Not expected given
        // TCP_RESP_CAP's sizing against portal_http.c's templates, but
        // fail closed (no reply) rather than send nothing meaningful.
        return finish_conn(c);
    }

    err_t rc = start_response(c, c->resp, n);

    // Review round 1 (Important 2): publish only now that the reply has
    // actually been handed to lwIP (start_response() -> try_send_more()
    // already ran tcp_write()/tcp_output() above). Publishing before this
    // point let portal_run()'s foreground loop observe g_submitted, return,
    // and have the caller reach portal_stop() -- tearing the AP down --
    // while the confirmation page was still only sitting in c->resp,
    // never given to lwIP at all.
    if (res.action == PORTAL_ACT_SUBMIT) {
        g_pending_cfg = res.submitted; // write the payload...
        g_submitted = true;            // ...then publish it -- see the
                                        // file header comment.
    }
    return rc;
}

static err_t try_progress(http_conn_t *c) {
    if (c->handled) return ERR_OK; // already answered (see
                                    // start_response()'s comment) --
                                    // ignore any further bytes on this
                                    // connection rather than re-running
                                    // portal_request().
    if (c->header_end < 0) {
        int idx = find_header_end(c->req, c->req_used);
        if (idx < 0) return ERR_OK; // headers not complete yet
        c->header_end = idx;
        c->content_length = parse_content_length(c->req, idx);
        if (c->content_length < 0 ||
            c->header_end + c->content_length > (int)sizeof(c->req) - 1) {
            return start_response(c, TOO_LARGE_RESPONSE,
                                   (int)sizeof(TOO_LARGE_RESPONSE) - 1);
        }
    }
    if (c->req_used < c->header_end + c->content_length) {
        return ERR_OK; // body still arriving
    }
    return handle_complete_request(c);
}

static err_t http_recv_cb(void *arg, struct tcp_pcb *tpcb, struct pbuf *p, err_t err) {
    http_conn_t *c = (http_conn_t *)arg;
    if (err != ERR_OK) {
        // Review round 1 (Minor): this SDK's tcp_in.c never actually
        // invokes this callback with a non-ERR_OK err (grep confirms the
        // one call site always passes ERR_OK), so this is dead code today
        // -- but it is exactly the defect class plan 4a was bitten by, so
        // it gets the same real teardown as every other exit from this
        // connection rather than a bespoke one. Nulling c->pcb/c->in_use
        // directly (the previous version of this branch) without
        // deregistering callbacks or closing the pcb would let this slot
        // be handed to a new connection while the old pcb -- still
        // pointing tcp_arg() at this same struct -- could still call back
        // into it. finish_conn() does the full deregister-then-close (or
        // abort) sequence instead, same as every other path below.
        if (p) pbuf_free(p);
        return finish_conn(c);
    }
    if (!p) {
        // Remote closed (or reset cleanly) before completing a request.
        return finish_conn(c);
    }

    c->poll_ticks = 0; // saw data -- the idle watchdog only fires on silence
    note_client_activity();  // ...and so does portal_run()'s, which is what
                              // keeps a request that is still arriving from
                              // being cut off by the AP coming down.

    u16_t total = p->tot_len;
    tcp_recved(tpcb, total); // ack the whole segment whether kept or
                              // discarded below.
    int avail = (int)sizeof(c->req) - 1 - c->req_used; // -1 reserves the NUL
    int take = (avail < (int)total) ? avail : (int)total;
    if (take > 0) {
        pbuf_copy_partial(p, c->req + c->req_used, (u16_t)take, 0);
        c->req_used += take;
    }
    pbuf_free(p);

    if ((int)total > take) {
        // Would not fit -- see the accumulation strategy in the file
        // header comment for why this refuses rather than truncates.
        return start_response(c, TOO_LARGE_RESPONSE,
                               (int)sizeof(TOO_LARGE_RESPONSE) - 1);
    }
    return try_progress(c);
}

static err_t http_sent_cb(void *arg, struct tcp_pcb *tpcb, u16_t len) {
    (void)tpcb; (void)len;
    http_conn_t *c = (http_conn_t *)arg;
    if (!c || !c->pcb) return ERR_OK;
    c->poll_ticks = 0; // the peer ACKed real bytes -- see http_poll_cb's
                       // review-round-1 fix for why this matters.
    note_client_activity();  // a reply still going out is activity too --
                              // the confirmation page must not be cut off
                              // mid-send by portal_run()'s timeout.
    return try_send_more(c);
}

static void http_err_cb(void *arg, err_t err) {
    (void)err;
    // Per tcp_err_fn's own doc: "The corresponding pcb is already freed
    // when this callback is called!" -- so, exactly like transport_tls.c's
    // on_err(), this only drops this slot's reference to it and calls
    // nothing else.
    http_conn_t *c = (http_conn_t *)arg;
    if (!c) return;
    c->pcb = NULL;
    c->in_use = false;
}

static err_t http_poll_cb(void *arg, struct tcp_pcb *tpcb) {
    (void)tpcb;
    http_conn_t *c = (http_conn_t *)arg;
    if (!c || !c->pcb) return ERR_OK;

    // Review round 1 (Minor): this used to only increment/check
    // poll_ticks in the "waiting on the client" branch below, so a
    // response that was queued but stalled (tcp_write() returning
    // ERR_MEM, e.g. a dribbling client that acks very slowly) never
    // timed out at all -- the slot would be held forever. poll_ticks now
    // ticks unconditionally every ~3 s and is reset by *any* real
    // progress in either direction (new request bytes in http_recv_cb,
    // or an ACKed write in http_sent_cb above), so a connection that is
    // truly idle -- whichever direction that idleness is in -- still
    // gets reclaimed within HTTP_IDLE_POLL_LIMIT ticks.
    c->poll_ticks++;
    if (c->poll_ticks >= HTTP_IDLE_POLL_LIMIT) {
        return finish_conn(c); // no progress in either direction for too
                                // long -- reclaim the slot.
    }
    if (c->resp_len > 0 && c->resp_sent < c->resp_len) {
        return try_send_more(c); // a stalled tcp_write() (ERR_MEM) retry
    }
    return ERR_OK;
}

// portal_run()'s second guarantee that an in-progress submission is never
// cut off: the inactivity deadline is not even evaluated while any slot is
// occupied, so the check is effectively "between connections" as well as
// "after silence". A slot is occupied from http_accept_cb() until
// finish_conn(), which covers a request still arriving, a response still
// being written, and everything in between.
static bool any_http_conn_in_use(void) {
    for (int i = 0; i < MAX_HTTP_CONNS; i++) {
        if (g_http_conns[i].in_use) return true;
    }
    return false;
}

static http_conn_t *find_free_conn(void) {
    for (int i = 0; i < MAX_HTTP_CONNS; i++) {
        if (!g_http_conns[i].in_use) return &g_http_conns[i];
    }
    return NULL;
}

static err_t http_accept_cb(void *arg, struct tcp_pcb *newpcb, err_t err) {
    (void)arg;
    if (err != ERR_OK || !newpcb) return err;

    http_conn_t *c = find_free_conn();
    if (!c) {
        // Pool exhausted: refuse rather than grow it or queue -- per
        // tcp_accept_fn's doc, "Only return ERR_ABRT if you have called
        // tcp_abort from within the callback function!", which this does.
        tcp_abort(newpcb);
        return ERR_ABRT;
    }
    note_client_activity();
    memset(c, 0, sizeof *c);
    c->in_use = true;
    c->pcb = newpcb;
    c->header_end = -1;
    tcp_arg(newpcb, c);
    tcp_recv(newpcb, http_recv_cb);
    tcp_sent(newpcb, http_sent_cb);
    tcp_err(newpcb, http_err_cb);
    tcp_poll(newpcb, http_poll_cb, HTTP_POLL_INTERVAL);
    return ERR_OK;
}

// ------------------------------------------------------------- lifecycle

static void setup_dhcp(void) {
    cyw43_arch_lwip_begin();
    struct udp_pcb *pcb = udp_new_ip_type(IPADDR_TYPE_V4);
    if (!pcb) { cyw43_arch_lwip_end(); fatal_setup_failure(); }
    if (udp_bind(pcb, IP_ADDR_ANY, DHCP_SERVER_PORT) != ERR_OK) {
        udp_remove(pcb);
        cyw43_arch_lwip_end();
        fatal_setup_failure();
    }
    udp_recv(pcb, dhcp_recv_cb, NULL);
    g_dhcp_pcb = pcb;
    cyw43_arch_lwip_end();
}

static void setup_dns(void) {
    cyw43_arch_lwip_begin();
    struct udp_pcb *pcb = udp_new_ip_type(IPADDR_TYPE_V4);
    if (!pcb) { cyw43_arch_lwip_end(); fatal_setup_failure(); }
    if (udp_bind(pcb, IP_ADDR_ANY, DNS_SERVER_PORT) != ERR_OK) {
        udp_remove(pcb);
        cyw43_arch_lwip_end();
        fatal_setup_failure();
    }
    udp_recv(pcb, dns_recv_cb, NULL);
    g_dns_pcb = pcb;
    cyw43_arch_lwip_end();
}

static void setup_http(void) {
    cyw43_arch_lwip_begin();
    struct tcp_pcb *pcb = tcp_new_ip_type(IPADDR_TYPE_V4);
    if (!pcb) { cyw43_arch_lwip_end(); fatal_setup_failure(); }
    if (tcp_bind(pcb, IP_ADDR_ANY, HTTP_SERVER_PORT) != ERR_OK) {
        tcp_close(pcb); // pcb is still CLOSED-state here (never listened,
                         // never connected); tcp_close() on that never
                         // needs the FIN dance tcp_abort() exists for.
        cyw43_arch_lwip_end();
        fatal_setup_failure();
    }
    struct tcp_pcb *listen_pcb = tcp_listen_with_backlog(pcb, MAX_HTTP_CONNS);
    if (!listen_pcb) {
        // tcp_listen_with_backlog() only frees `pcb` itself on success;
        // on failure it is untouched and still ours to close.
        tcp_close(pcb);
        cyw43_arch_lwip_end();
        fatal_setup_failure();
    }
    g_http_listen_pcb = listen_pcb;
    tcp_accept(g_http_listen_pcb, http_accept_cb);
    cyw43_arch_lwip_end();
}

portal_run_result_t portal_run(device_config_t *out, const char *err,
                               uint32_t idle_timeout_ms) {
    // Review round 1 (Important 1): a second portal_run() call without an
    // intervening portal_stop() used to hang the board silently --
    // lwipopts.h does not set LWIP_SO_REUSE, so re-binding ports 67/53/80
    // while the previous pcbs are still bound returns ERR_USE, and
    // setup_dhcp()/setup_dns()/setup_http() treat any bind failure as the
    // unrecoverable fatal_setup_failure() case (while(1)
    // tight_loop_contents(), no watchdog, no LED, no UART). Retrying after
    // a wrong password (spec D-4b-3's verify-then-commit) is the NORMAL
    // path here, not a caller error, so this enforces the ordering
    // itself instead of just documenting it as the caller's
    // responsibility.
    if (g_dhcp_pcb) {
        portal_stop();
    }

    // Read the MAC before enabling AP mode: it names the AP itself. The
    // MAC is a fixed per-chip value available as soon as cyw43_arch_init()
    // has run (main.c's own mac_address_string() reads it the same way,
    // just later in that file's flow); nothing here depends on whether
    // STA mode has been set up.
    uint8_t mac[6] = {0};
    cyw43_wifi_get_mac(&cyw43_state, CYW43_ITF_STA, mac);
    char ssid[24];
    snprintf(ssid, sizeof ssid, "wifi-floppy-%02X%02X", mac[4], mac[5]);

    cyw43_arch_enable_ap_mode(ssid, PORTAL_AP_PASSWORD, CYW43_AUTH_WPA2_AES_PSK);

    // A previous portal session's leases must not linger into this one --
    // see dhcp_server.h's comment on dhcp_reset_leases().
    dhcp_reset_leases();

    g_current_err = err;
    g_submitted = false;
    note_client_activity();   // start the inactivity clock at "now", not at
                               // whenever the last portal session saw a
                               // packet -- otherwise a second call could
                               // time out before the AP is even usable.

    setup_dhcp();
    setup_dns();
    setup_http();

    while (!g_submitted) {
        sleep_ms(5); // plain, unlocked poll -- never wrap a wait loop in
                      // cyw43_arch_lwip_begin()/end(): doing so would
                      // block the very background context that has to
                      // run for g_submitted to ever become true.

        // Final-review Important 2: this wait used to be unbounded, which
        // made PROV_PORTAL a one-way door -- a board that lost a race with
        // its own router at boot (three 15 s attempts spent in the 45 s
        // before the router finished coming up) parked in AP mode until
        // somebody turned up with a phone. See portal_net.h's
        // PORTAL_IDLE_TIMEOUT_MS for the interval and its two-sided
        // justification, and provisioning.h's prov_on_portal_idle_timeout()
        // for what the caller does with the result.
        //
        // Three separate things keep a submission in progress from being
        // cut off here:
        //   1. `idle_timeout_ms` measures INACTIVITY. Every DHCP, DNS and
        //      HTTP packet -- inbound bytes and outbound ACKs alike --
        //      calls note_client_activity(), so the clock only runs while
        //      the AP is genuinely deserted.
        //   2. The deadline is not evaluated at all while an HTTP
        //      connection slot is occupied, so a request mid-arrival or a
        //      response mid-send holds the portal open no matter how the
        //      clock stands. That cannot defer the timeout forever: a slot
        //      with no progress in either direction is reclaimed by
        //      http_poll_cb() after HTTP_IDLE_POLL_LIMIT ticks (~30 s), so
        //      a client that opens a socket and goes silent buys the
        //      portal half a minute, not an eternity.
        //   3. g_submitted is re-read after the deadline check. A submit
        //      published by the background context between the top of this
        //      loop and here still wins the race, so the outcome is never
        //      "timed out, discarding a config that had already arrived".
        if (idle_timeout_ms == 0) continue;    // caller wants no bound
        if (any_http_conn_in_use()) {
            note_client_activity();
            continue;
        }
        uint32_t now = to_ms_since_boot(get_absolute_time());
        if ((uint32_t)(now - g_last_activity_ms) < idle_timeout_ms) continue;
        if (g_submitted) break;                // point 3 above
        return PORTAL_RUN_IDLE_TIMEOUT;
    }

    cyw43_arch_lwip_begin();
    *out = g_pending_cfg;
    cyw43_arch_lwip_end();
    return PORTAL_RUN_SUBMITTED;
}

void portal_stop(void) {
    cyw43_arch_lwip_begin();

    for (int i = 0; i < MAX_HTTP_CONNS; i++) {
        if (g_http_conns[i].in_use) {
            finish_conn(&g_http_conns[i]); // return value not needed here
                                            // -- unlike inside a callback,
                                            // nothing above this needs to
                                            // be told ERR_ABRT.
        }
    }
    if (g_http_listen_pcb) {
        tcp_arg(g_http_listen_pcb, NULL);
        tcp_accept(g_http_listen_pcb, NULL);
        if (tcp_close(g_http_listen_pcb) != ERR_OK) {
            tcp_abort(g_http_listen_pcb);
        }
        g_http_listen_pcb = NULL;
    }
    if (g_dns_pcb) {
        udp_recv(g_dns_pcb, NULL, NULL);
        udp_remove(g_dns_pcb);
        g_dns_pcb = NULL;
    }
    if (g_dhcp_pcb) {
        udp_recv(g_dhcp_pcb, NULL, NULL);
        udp_remove(g_dhcp_pcb);
        g_dhcp_pcb = NULL;
    }

    cyw43_arch_lwip_end();

    cyw43_arch_disable_ap_mode();

    // Review round 1 (Critical): cyw43_arch_disable_ap_mode() ->
    // cyw43_wifi_set_up(CYW43_ITF_AP, false, ...) -> cyw43_cb_tcpip_deinit()
    // -> netif_remove() on the AP's netif (cyw43_lwip.c). netif_remove()
    // (lwip/core/netif.c) sets netif_default back to NULL whenever the
    // netif being removed *was* netif_default -- and it always is here,
    // because bringing the AP up (cyw43_cb_tcpip_init(), same file) called
    // netif_set_default() on it unconditionally. Left alone, every route
    // lookup with no more specific match (ip4_route(), used for anything
    // off the AP's own /24 -- e.g. the TLS connection to WEBADF_HOST once
    // STA reconnects) returns NULL from here on: the provisioning flow
    // looks like it succeeded and the board silently never reaches the
    // server again. A later cyw43_arch_enable_sta_mode() does NOT fix
    // this on its own: cyw43_wifi_set_up()'s `up` branch only calls
    // cyw43_cb_tcpip_init() (the thing that calls netif_set_default())
    // when the itf's bit in itf_state is not already set, and main.c
    // enables STA mode once at boot, before this file's caller ever runs
    // -- so STA's bit is already set by the time portal_stop() is called,
    // and re-enabling it again is a no-op as far as netif_set_default()
    // is concerned.
    //
    // The fix: explicitly restore the STA netif as default.
    // cyw43_state.netif[itf] (cyw43.h's own `struct netif netif[2];`
    // field, indexed exactly this way by cyw43_lwip.c itself) is always a
    // valid, already-netif_add()-ed struct by the time this runs --
    // portal_net.h documents that this file assumes STA mode has already
    // been enabled by the caller (main.c does this once at boot, before
    // any provisioning decision), so the target netif here always exists
    // and is already registered in lwIP's netif_list; this is only
    // re-designating which already-registered netif is the default one.
    // netif_set_default() is a plain lwIP call made from foreground code,
    // so it needs the lock like every other one above.
    cyw43_arch_lwip_begin();
    netif_set_default(&cyw43_state.netif[CYW43_ITF_STA]);
    cyw43_arch_lwip_end();
}
