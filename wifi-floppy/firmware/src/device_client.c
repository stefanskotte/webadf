// The §10 poll loop. See device_client.h for the file-wide rule (no SDK or
// lwIP headers here) and docs/superpowers/specs/2026-08-30-device-firmware-
// protocol-design.md §2 for the two things this file must never do:
//
//   1. An eject nobody asked for -- a timeout, a 5xx, a dropped connection,
//      or a deleted device row must never change what is mounted. Only an
//      explicit `desired: null` ejects.
//   2. A diskless gap -- never release the current disk before a
//      replacement is fetched and verified.
//
// Every dispatch branch below resolves failures towards "touch nothing"
// rather than towards "clear the mount", specifically because of rule 1.
#include "device_client.h"
#include "wf_log.h"
#include "http.h"
#include "json_scan.h"
#include "psram_image.h"
#include "image_loader.h"
#include "token_store.h"
#include "nfc_tag.h"
#include "display_layout.h"   // pure: LAYOUT_BLOB_MAX, panel_t
#include <string.h>
#include <stdio.h>

// Generous for a GET line plus Host/Authorization headers to either the
// poll or the image endpoint (the sha256 in the image path is 64 hex
// chars); nowhere near HTTP_MAX_BODY_BYTES.
// Raised from 256 for OLED layouts' &displayAck= (the poll path's worst case
// went from 51 to 73). With a real token (wadf_ + 43 base64url = 48 bytes,
// src/lib/device-token.ts) and WEBADF_HOST, the worst poll request is 211
// bytes; but token_store accepts up to TOKEN_STORE_MAX_LEN (127), and at that
// length the worst poll request is 290 -- already 268 before this change, so
// 256 silently could not carry the longest token the store would hand it.
// 320 covers it; the buffers using this are static, so the cost is .bss.
// &driveAck=4294967295 (DF1 setting, Phase 3) adds 20: 290 + 20 = 310 worst,
// so 352.
#define DC_REQ_BUF_BYTES  352
// DC_POLL_BODY_BYTES moved to device_client.h so a test can name it -- see
// the note there. A budget a test cannot name is a budget checked by hand.
// 512 was never under load before the image fetch: every other response on
// this device is a few hundred bytes of poll JSON. At 2 MB it means ~4,000
// read calls, each taking the lwIP lock, memcpy'ing and crediting the window.
#define DC_READ_CHUNK_BYTES 4096

// The status buffer budgets moved to device_client.h, so that
// test_status_body_fits_at_maximum can name them. A budget a test cannot
// name is a budget that gets checked by hand, which is how this body came to
// sit ~16 bytes below its own limit unnoticed.
#define DC_STATUS_PATH        "/api/device/status"

// Registration (spec §7): pairingCode, firmwareVersion, macAddress -- all
// short, firmware-authored or compile-time values, so a generous fixed
// size costs nothing and avoids a second round of hand-counted-length bugs.
#define DC_REGISTER_PATH      "/api/device/register"
#define DC_REGISTER_BODY_BYTES 384
#define DC_REGISTER_REQ_BYTES  512
// The register response is a small, fixed-shape JSON object ({token,
// deviceId, name}); reuses dc_body_buf_t/DC_POLL_BODY_BYTES below rather
// than a dedicated buffer.

typedef struct {
    char buf[DC_POLL_BODY_BYTES];
    int  len;
    // Set the moment a single byte of body is dropped for want of room.
    // Never reset by this sink -- the owner clears it when it resets `len`.
    bool truncated;
} dc_body_buf_t;

static void dc_body_sink(void *ctx, const uint8_t *b, int n) {
    dc_body_buf_t *body = ctx;
    if (n <= 0) return;
    int space = (int)sizeof(body->buf) - 1 - body->len;
    if (space <= 0) { body->truncated = true; return; }
    int take = n < space ? n : space;
    if (take < n) body->truncated = true;
    memcpy(body->buf + body->len, b, (size_t)take);
    body->len += take;
    body->buf[body->len] = '\0';
}

// Used for every exchange whose body this layer has no use for keeping
// (the status report's response, and the image endpoint's body on any
// non-200 status -- an error JSON payload, not track data). What this
// layer checks regardless of whether bytes are kept is only whether the
// full body arrived; dc_fetch_image is what turns that into a
// publish-or-not decision for the slot.
static void dc_discard_sink(void *ctx, const uint8_t *b, int n) {
    (void)ctx; (void)b; (void)n;
}

// The image endpoint's 200 body IS track data, and there is nowhere near
// enough SRAM to buffer a whole image (up to ~2 MB, psram_image.h) before
// parsing it -- so unlike dc_body_sink above, this feeds bytes straight
// into image_loader.c's incremental parser as dc_exchange's read loop
// hands them over, chunk by chunk, writing directly into the PSRAM slot
// image_parse_begin() was pointed at. Harmless to feed on a non-200 status
// too (a small error body will not parse as a WFMF header and the parser
// state is simply never asked for a verdict via image_parse_end() in that
// case), so dc_fetch_image uses this sink unconditionally rather than
// switching on the status after the fact.
// Reset by dc_fetch_image before each attempt. 16 KB granularity was what
// diagnosed the 3z stall -- it is the only way to tell a transfer that STOPS
// DEAD from one that merely crawls, since both reach the caller as a read that
// eventually times out. Dialled back to 256 KB now that the stall is fixed: at
// 16 KB a healthy fetch printed ~124 lines in under four seconds, which is a
// smaller version of exactly the mistake 3x records. Eight lines still show
// throughput and still localise a stall to within 256 KB, which is enough to
// know to put it back.
static long g_img_got;
static long g_img_next;
// The in-flight response, so dc_image_sink can read the Content-Length that
// the header parser recorded. Safe to read from the sink and nowhere else:
// http.c only starts calling the body sink after start_body_phase(), which
// runs once the headers are complete, so the field is final by then. Points
// at dc_fetch_into's own `static` response (shared by the swap fetch and the
// preload), whose storage outlives the call.
static const http_resp_t *g_img_resp;
static uint32_t g_img_t0;   // fetch start, for the throughput line
// True for a preload: the sink still times and logs the transfer, but emits no
// progress observations -- the OLED shows the mounted disk, not a background
// fetch nobody asked to watch. Set by dc_fetch_into before every transfer.
static bool g_img_quiet;
static uint32_t g_ms_read;  // ms inside transport read (network + TLS decrypt)
static uint32_t g_ms_feed;  // ms inside http parse + sink (PSRAM writes)

// ---------------------------------------------------------------------
// Observations. `obs` is file-static for the reason every large buffer here
// is (see the STACK note below): core1 runs on a 2 KB stack shared with the
// whole mbedTLS handshake, and ~90 bytes of struct per call is not free at
// that size. Safe because no dc_* function re-enters another, which the
// re-entrancy note below establishes for exactly this kind of sharing.
static dc_obs_t obs;

static void dc_emit(device_client_t *c, dc_obs_kind_t kind,
                    uint32_t got, uint32_t total) {
    if (!c->_obs) return;
    memset(&obs, 0, sizeof obs);
    obs.kind = kind;
    snprintf(obs.title, sizeof obs.title, "%s", c->_fetch_title);
    snprintf(obs.label, sizeof obs.label, "%s", c->_fetch_label);
    obs.disk_no    = c->_fetch_disk_no;
    obs.disk_count = c->_fetch_disk_count;
    obs.got        = got;
    obs.total      = total;
    c->_obs(c->_obs_ctx, &obs);
}

void dc_set_observer(device_client_t *c, dc_observe_fn fn, void *ctx) {
    c->_obs = fn;
    c->_obs_ctx = ctx;
    c->_fetch_pct = -1;
}

static void dc_image_sink(void *ctx, const uint8_t *b, int n) {
    // The clock starts on the FIRST BODY BYTE, not at dc_fetch_image entry:
    // otherwise the ~1-3 s DNS + TCP + TLS handshake is averaged into the
    // transfer rate and a throughput change is impossible to read.
    if (g_img_got == 0 && ctx) g_img_t0 = ((device_client_t *)ctx)->now();
    image_parse_feed(b, n);
    g_img_got += n;
    if (g_img_got >= g_img_next) {
        wf_logf(WF_INFO, "fetch: %ld KB", g_img_got / 1024);
        g_img_next = g_img_got + 262144;
    }
    // Throttled to whole percent changes. This sink runs once per 4 KB read,
    // so ~500 times for a 2 MB image; an observation per call would be ~400
    // wasted publishes, all of them rendering the identical frame.
    if (ctx && !g_img_quiet) {
        device_client_t *c = ctx;
        uint32_t total = (g_img_resp && g_img_resp->content_length > 0)
                       ? (uint32_t)g_img_resp->content_length : 0u;
        int pct = total ? (int)((uint64_t)g_img_got * 100u / total) : -1;
        if (pct != c->_fetch_pct) {
            c->_fetch_pct = pct;
            dc_emit(c, DC_OBS_FETCH_PROGRESS, (uint32_t)g_img_got, total);
        }
    }
}

// ---------------------------------------------------------------------
// STACK: why every large buffer below is `static`.
//
// Core 1 runs on a 2 KB stack (.stack1_dummy lives in the 4 KB SCRATCH_X
// bank, so PICO_CORE1_STACK_SIZE cannot simply be raised past 4 KB), and
// the cyw43 threadsafe-background IRQ runs lwIP + the whole mbedTLS
// handshake on that SAME stack, on top of whatever this file is doing.
// Measured on the built ELF, the request buffers in dc_step,
// dc_report_status, dc_register and dc_exchange were together worth
// ~2.7 KB of frame before the IRQ chain was even counted -- past the limit
// on the very first poll, into the top of the newlib heap where mbedTLS's
// record buffers live, with no fault to show for it. See
// .superpowers/sdd/2026-08-30-device-firmware-protocol/final-fix-report.md
// for the before/after measurement.
//
// Moving them to static storage is sound ONLY because none of these
// functions is re-entrant. The full argument, which must be re-checked
// before adding any call site:
//
//   * Everything here runs on core 1 and only on core 1 (main.c launches
//     core1_main and nothing else calls into this file). There is no RTOS,
//     no thread, and no second caller -- so "single-threaded" is a
//     property of the whole file, not of one function.
//   * These functions never call each other in a cycle. The only call graph
//     is  core1_main -> dc_step -> dc_handle_poll_body -> dc_fetch_image ->
//     dc_exchange,  core1_main -> dc_report_status -> dc_exchange,
//     core1_main -> dc_register -> dc_exchange, core1_main -> fw_update ->
//     dc_fetch_firmware -> dc_exchange, core1_main -> up_step -> dc_post ->
//     dc_exchange (uploader.c, Task 5: one dirty track at a time), and its
//     close counterpart, core1_main -> up_step -> (sha256_*,
//     psram_image_read, mfm_decode_track_r, psram_image_track_data) ->
//     dc_post -> dc_exchange (uploader.c, Task 6: hashes the whole image,
//     then posts the digest -- psram_image_track_data is the HD track's
//     read, HD writes spec §4.4: no decode, no copy, a pointer straight
//     into PSRAM), and the NFC pair, core1_main -> dc_tap /
//     dc_tap_write_report -> dc_post -> dc_exchange, sent BETWEEN dc_steps
//     -- an interrupted poll returns first, and only then does the tap go
//     out. Every path is a straight line, including the close's hash loop
//     -- sha256_*, psram_image_read, mfm_decode_track_r and
//     psram_image_track_data never call back into any dc_*/up_* function,
//     so nothing here is re-entered while its statics are live; dc_exchange
//     is shared by five callers but is never nested inside itself, and
//     dc_post/dc_fetch_firmware are never nested inside dc_step -- the
//     uploader runs from its own call site in the main loop, not from
//     inside the poll.
//   * Each function owns its own statics -- dc_exchange's read chunk is
//     not shared with dc_step's body buffer, and so on -- so a caller's
//     buffer can never be clobbered by a callee. (The one buffer that IS
//     handed across a call boundary, the dc_body_buf_t a caller passes to
//     dc_exchange as sink context, belongs to that caller and is written
//     only by its own sink.)
//   * None of the body sinks (dc_body_sink / dc_image_sink /
//     dc_discard_sink) call back into any dc_* function, so the read loop
//     cannot re-enter a function whose statics are live.
//   * No dc_* function is used as an interrupt handler, and nothing in
//     this file is reachable from one: the cyw43/lwIP IRQ runs the
//     transport's callbacks, never these.
//
// The cost is ~6 KB of BSS in a build with ~390 KB of SRAM unallocated.
// dc_post's request buffer has since grown by 5.6 KB to carry an HD track
// (DC_POST_BODY_MAX, HD writes spec §4.4).
// ---------------------------------------------------------------------

// Exponential from the floor, doubling on every consecutive failure,
// capped -- then jittered. The jitter comes from the injected clock
// (`c->now()`), never `rand()`, so a host test can drive it deterministically
// (fix the fake clock and the sequence is exact; advance it and the jitter
// term changes predictably). It is added *after* capping the doubled value,
// and the sum is capped again, so DC_BACKOFF_CAP_MS is a hard ceiling on
// `backoff_ms` even with a nonzero jitter term. Because the doubled-and-
// capped base is always >= the previous backoff_ms (doubling a positive
// number never shrinks it, and capping never pushes a value that was
// already <= the cap below itself), and jitter only ever adds, the result
// never shrinks either.
static dc_state_t dc_enter_backoff(device_client_t *c) {
    uint32_t next = (c->backoff_ms == 0) ? DC_BACKOFF_FLOOR_MS : c->backoff_ms * 2u;
    if (next > DC_BACKOFF_CAP_MS) next = DC_BACKOFF_CAP_MS;

    uint32_t jitter = c->now() % 250u;
    next += jitter;
    if (next > DC_BACKOFF_CAP_MS) next = DC_BACKOFF_CAP_MS;

    c->backoff_ms = next;
    c->state = DC_BACKOFF;
    return c->state;
}

static void dc_backoff_reset(device_client_t *c) {
    c->backoff_ms = 0;
}

// Ends the connection for real. transport.h's `abandon` is optional, so a
// transport that does not implement it falls back to close() -- which is
// correct for any transport that does not keep connections alive in the
// first place.
static void dc_abandon(device_client_t *c) {
    if (c->t->abandon) c->t->abandon(c->t);
    else c->t->close(c->t);
}

// Records how an attempt ended in c->last_xfer (device_client.h). Called on
// EVERY exit of dc_attempt, so the record always describes the latest one.
static void dc_xfer_end(device_client_t *c, const http_resp_t *r, dc_xfer_stage_t stage,
                        int rc, uint32_t t0, int read_bytes) {
    dc_xfer_t *x = &c->last_xfer;
    x->stage = (uint8_t)stage;
    x->rc = rc;
    x->status = r->status;
    x->body_got = r->_body_got;
    x->content_length = r->content_length;
    x->body_complete = r->body_complete;
    x->bytes_read = read_bytes;
    x->ms = c->now() - t0;
}

const char *dc_transport_rc_text(int rc) {
    switch (rc) {
    case 0:                          return "";
    case TLS_ERR_TIME_UNSET:         return "no clock";
    case TLS_ERR_DNS:                return "DNS failed";
    case TLS_ERR_DNS_TIMEOUT:        return "DNS timeout";
    case TLS_ERR_TLS_CONFIG:         return "TLS setup failed";
    case TLS_ERR_CONNECT:            return "refused/closed in handshake";
    case TLS_ERR_HANDSHAKE_TIMEOUT:  return "handshake timeout";
    case TLS_ERR_BAD_ARG:            return "bad argument";
    case TLS_ERR_HOST_TOO_LONG:      return "host too long";
    case TLS_ERR_READ_TIMEOUT:       return "read timeout";
    case TLS_ERR_CONN_LOST:          return "connection lost";
    case TLS_ERR_WRITE_CLOSED:       return "write on closed conn";
    case TLS_ERR_WRITE_TIMEOUT:      return "write timeout";
    case TLS_ERR_WRITE:              return "write refused";
    case TRANSPORT_INTERRUPTED:      return "interrupted";
    default:                         return "error";
    }
}

void dc_xfer_describe(const dc_xfer_t *x, char *how, int how_cap, char *got, int got_cap) {
    static const char *const stage_names[] = {
        [DC_XFER_DONE] = "end", [DC_XFER_CONNECT] = "connect", [DC_XFER_WRITE] = "write",
        [DC_XFER_READ] = "read", [DC_XFER_FRAMING] = "framing",
        [DC_XFER_INTERRUPTED] = "interrupt",
    };
    const char *stage = x->stage < sizeof stage_names / sizeof stage_names[0]
                        ? stage_names[x->stage] : "?";
    // "at read rc=-108 (read timeout), kept conn, retried" -- or, for an
    // exchange that ended on the wire's own terms, "at end (peer closed)" /
    // "at end (complete)": the status line on `got` then says the rest.
    if (how && how_cap > 0) {
        if (x->stage == DC_XFER_DONE) {
            snprintf(how, (size_t)how_cap, "at end (%s), %s conn%s",
                     x->body_complete ? "complete" : "peer closed",
                     x->reused ? "kept" : "new", x->retried ? ", retried" : "");
        } else {
            snprintf(how, (size_t)how_cap, "at %s rc=%d (%s), %s conn%s", stage, x->rc,
                     dc_transport_rc_text(x->rc), x->reused ? "kept" : "new",
                     x->retried ? ", retried" : "");
        }
    }
    if (got && got_cap > 0) {
        snprintf(got, (size_t)got_cap, "status=%d body %ld/%ld complete=%s read=%ld in %lu ms",
                 x->status, x->body_got, x->content_length,
                 x->body_complete ? "yes" : "no", x->bytes_read, (unsigned long)x->ms);
    }
}

// Runs one full request/response exchange over `c->t`: writes the `req_len`
// bytes of an already-built request at `req` -- looping on partial writes,
// since transport_t.write may accept fewer bytes than offered exactly as a
// real socket can under backpressure -- then reads until the response is
// fully framed or the connection closes. `sink` receives body bytes as
// http_resp_feed frames them.
//
// This is the one place any request goes out on the wire: the GET poll
// (dc_step), the GET image fetch (dc_fetch_image), and the POST status
// report (dc_report_status) all build their own request bytes with
// http_build_request and then share this function for the connect/write/
// read loop, rather than each duplicating it.
//
// Returns false only for a transport- or framing-level failure (connect
// failed, a write stalled, a read errored, or the bytes seen so far don't
// parse as HTTP at all). A response that parsed a status line and then hit
// a clean close mid-body returns true with `r->body_complete` still false
// -- the caller decides what an incomplete body means for that endpoint;
// this function only reports what happened on the wire.
// One attempt: connect (which may hand back an already-open connection),
// write the request, read until the response is framed or the peer closes.
//
// Every exit that is not "the response finished" goes through dc_abandon()
// rather than close(): a keep-alive transport's close() means "this
// exchange is over", which it cannot distinguish from "we gave up
// mid-response" -- and a connection kept after we gave up hands the rest of
// THIS response to the NEXT request, permanently. `read_bytes_out` reports
// whether anything at all arrived on this attempt, which is the only honest
// basis for deciding a request is safe to repeat (see dc_exchange).
static bool dc_attempt(device_client_t *c, const char *req, int req_len,
                       void (*sink)(void *ctx, const uint8_t *b, int n),
                       void *sink_ctx, http_resp_t *r, bool *reused_out,
                       int *read_bytes_out, bool *interrupted_out) {
    // FIRST, before anything can return: every caller's `r` is static and
    // still holds the PREVIOUS exchange's status/flags. An early return
    // (connect refused, a write that failed) used to leave all of it in
    // place, and dc_exchange would then read a stale `status` and conclude
    // the server had answered a request that never went out.
    http_resp_init(r);
    *read_bytes_out = 0;
    *interrupted_out = false;
    const uint32_t t0 = c->now();
    c->last_xfer.reused = false;
    c->last_xfer.retried = false;
    const int crc = c->t->connect(c->t, c->host, 443);
    if (crc < 0) {
        *reused_out = false;
        dc_abandon(c);
        dc_xfer_end(c, r, DC_XFER_CONNECT, crc, t0, 0);
        return false;
    }
    *reused_out = c->t->reused ? c->t->reused(c->t) : false;
    c->last_xfer.reused = *reused_out;

    int sent = 0;
    while (sent < req_len) {
        int w = c->t->write(c->t, (const uint8_t *)req + sent, req_len - sent);
        if (w <= 0) {
            dc_abandon(c);
            dc_xfer_end(c, r, DC_XFER_WRITE, w, t0, 0);
            return false;
        }
        sent += w;
    }

    g_ms_read = 0;
    g_ms_feed = 0;
    // static: see the STACK note above. Live only inside this loop, and
    // dc_exchange is never nested inside itself.
    static uint8_t buf[DC_READ_CHUNK_BYTES];
    for (;;) {
        // Splits the transfer into "waiting for the network + TLS decrypt"
        // (read) and "our own processing" (feed -> image_parse_feed -> PSRAM).
        // Raising TCP_WND 16->32*MSS bought +27% and DC_READ_CHUNK_BYTES
        // 512->4096 bought ~4%, so neither is the ceiling any more and the next
        // change should be aimed at whichever of these two dominates -- not
        // guessed at.
        uint32_t t_a = c->now();
        int got = c->t->read(c->t, buf, sizeof buf, (int)DC_POLL_TIMEOUT_MS);
        uint32_t t_b = c->now();
        g_ms_read += t_b - t_a;
        if (got == TRANSPORT_INTERRUPTED) {
            // The caller's poll-interrupt said stop (spec 2026-09-25 §4.2).
            // Not a failure, but the response is still owed on this socket
            // -- possibly half of it already read -- so the socket can never
            // carry another request: abandoned exactly like a failure.
            *interrupted_out = true;
            dc_abandon(c);
            dc_xfer_end(c, r, DC_XFER_INTERRUPTED, got, t0, *read_bytes_out);
            return false;
        }
        if (got < 0) {                                // error or timeout
            dc_abandon(c);
            dc_xfer_end(c, r, DC_XFER_READ, got, t0, *read_bytes_out);
            return false;
        }
        if (got == 0) break;                          // clean close
        *read_bytes_out += got;
        bool fed = http_resp_feed(r, buf, got, sink, sink_ctx);
        g_ms_feed += c->now() - t_b;
        if (!fed) {
            dc_abandon(c);
            dc_xfer_end(c, r, DC_XFER_FRAMING, 0, t0, *read_bytes_out);
            return false; // malformed response
        }
        if (r->body_complete) break;
    }
    // The ONE exit that may hand the connection back, and it takes four
    // conditions, not one:
    //
    //   * body_complete -- the parser reached the end of the response;
    //   * has_explicit_framing -- and it KNEW where that end was. Without a
    //     Content-Length, a chunked encoding or a bodyless status, http.c
    //     declares completion at the end of the headers simply because
    //     nothing further can be delimited. That response is close-delimited:
    //     its body is still arriving, and keeping the socket hands it to the
    //     next request. This is C1's desync by another door -- the one door
    //     abandon() alone does not cover, because this path never looked
    //     like a failure;
    //   * !connection_close -- the peer said it is going away, so keeping
    //     the socket only means discovering that on the next request;
    //   * !extra_after_complete -- bytes arrived past the end of the
    //     response. Whatever they are, the stream is out of step, and the
    //     next reader would start mid-something.
    //
    // A break here with `body_complete` still false is the peer closing
    // mid-body: the caller is told (true, incomplete), and the connection is
    // finished either way.
    if (r->body_complete && r->has_explicit_framing &&
        !r->connection_close && !r->extra_after_complete) {
        c->t->close(c->t);
    } else {
        dc_abandon(c);
    }
    dc_xfer_end(c, r, DC_XFER_DONE, 0, t0, *read_bytes_out);
    return true;
}

/**
 * One exchange, with one retry reserved for exactly one situation.
 *
 * The transport keeps a clean connection open between exchanges (a handshake
 * costs ~1.25 s on this hardware, measured, and session resumption barely
 * dented it). A kept connection can be closed by the far end while idle, and
 * nothing says so until the next request goes out and gets nothing back. That
 * failure is not the network being down; it is a socket that expired, and the
 * request was never answered -- so it is retried once, on a fresh connection.
 *
 * The retry is deliberately narrow, on three counts:
 *
 *   * only when the connection was REUSED -- a fresh connection that failed
 *     says something about the network, not about a socket that expired;
 *   * only when NOT ONE BYTE arrived on it. `status == 0` is not the same
 *     thing: a read timeout on a POST the server is still working on also
 *     leaves status at 0, and that request HAS been received. Bytes read is
 *     the only signal here that distinguishes "never left" from "no answer
 *     yet", and even it is conservative by design;
 *   * only when the caller says the request is safe to repeat.
 *     `retryable` is false for /api/device/register, which has no
 *     idempotency at all: the pairing code is single-use, so a resend of a
 *     registration whose response was lost turns a recoverable timeout into
 *     a terminal `invalid_or_used_code` and sends the board back to the
 *     portal for a code the user has to re-issue.
 */
// `interrupted_out` (may be NULL) is set when an attempt ended on
// TRANSPORT_INTERRUPTED. That is checked BEFORE the retry rule, and it has
// to be: an interrupt usually lands on a reused connection with nothing read
// yet -- exactly the shape of a dead socket -- so the retry would otherwise
// re-send the poll the caller just asked to stop, and wait the full hold again.
static bool dc_exchange_i(device_client_t *c, const char *req, int req_len,
                          void (*sink)(void *ctx, const uint8_t *b, int n),
                          void *sink_ctx, http_resp_t *r, bool retryable,
                          bool *interrupted_out) {
    bool reused = false;
    int got = 0;
    bool intr = false;
    if (interrupted_out) *interrupted_out = false;
    const bool ok = dc_attempt(c, req, req_len, sink, sink_ctx, r, &reused, &got, &intr);
    if (intr) {
        if (interrupted_out) *interrupted_out = true;
        return false;
    }
    if (ok && r->status != 0) return true;
    if (!retryable || !reused || got != 0) return ok;

    // The socket was stale: it was handed to us already open, and it
    // produced nothing at all. dc_attempt has already abandoned it on every
    // path that reaches here; this call is what makes that a guarantee
    // rather than an assumption about a function that may grow another exit
    // -- abandon() is idempotent in both implementations.
    wf_logf(WF_INFO, "http: kept connection was closed, retrying on a new one");
    dc_abandon(c);
    bool again = false;
    int got_again = 0;
    const bool ok_again = dc_attempt(c, req, req_len, sink, sink_ctx, r, &again, &got_again, &intr);
    c->last_xfer.retried = true;
    if (intr && interrupted_out) *interrupted_out = true;
    return ok_again;
}

// Every caller but the poll: no interrupt is ever installed for them, so
// there is nothing to report.
static bool dc_exchange(device_client_t *c, const char *req, int req_len,
                        void (*sink)(void *ctx, const uint8_t *b, int n),
                        void *sink_ctx, http_resp_t *r, bool retryable) {
    return dc_exchange_i(c, req, req_len, sink, sink_ctx, r, retryable, NULL);
}

bool dc_digest_is_blocked(const device_client_t *c, const char *sha256) {
    for (int i = 0; i < c->_blocked_count; i++) {
        if (strcmp(c->_blocked[i], sha256) == 0) return true;
    }
    return false;
}

// FIFO over a fixed ring: writes always land at `_blocked_next` and advance
// it, so once the set is full the oldest blocked digest is the next one
// evicted. Small and fixed by design (DC_BLOCKED_MAX) -- see device_client.h.
static void dc_block_digest(device_client_t *c, const char *sha256) {
    if (dc_digest_is_blocked(c, sha256)) return;
    int slot = c->_blocked_next;
    strncpy(c->_blocked[slot], sha256, sizeof(c->_blocked[slot]) - 1);
    c->_blocked[slot][sizeof(c->_blocked[slot]) - 1] = '\0';
    c->_blocked_next = (c->_blocked_next + 1) % DC_BLOCKED_MAX;
    if (c->_blocked_count < DC_BLOCKED_MAX) c->_blocked_count++;
}

// The ONLY place `since` is assigned in this file, and it runs only once a
// transition -- a verified fetch-and-swap, or an explicit eject -- has
// actually completed. Never call this on merely receiving a response that
// *names* a transition (spec §4.1: since advances only after the
// transition it names has completed, not on receipt of the response that
// named it).
static void dc_complete_transition(device_client_t *c, uint32_t version,
                                   const char *sha256, const char *disk_id,
                                   bool write_protected) {
    c->since = version;
    c->mounted_version = version;
    strncpy(c->mounted_sha256, sha256, sizeof(c->mounted_sha256) - 1);
    c->mounted_sha256[sizeof(c->mounted_sha256) - 1] = '\0';
    strncpy(c->mounted_disk_id, disk_id, sizeof(c->mounted_disk_id) - 1);
    c->mounted_disk_id[sizeof(c->mounted_disk_id) - 1] = '\0';
    c->mounted_write_protected = write_protected;
    c->_refetch = false;
}

// What dc_fetch_into saw. The caller decides what each one means -- block,
// back off, halt, publish or record a preload -- so the fetch itself is shared
// by the swap path and the preload path without either inheriting the other's
// verdicts.
typedef enum {
    DC_FETCH_OK,          // 200, whole body, image_parse_end() true: `target` is verified
    DC_FETCH_NO_REQUEST,  // the request did not fit its buffer; nothing went out
    DC_FETCH_INCOMPLETE,  // transport/framing failure or a body that stopped short
    DC_FETCH_INVALID,     // 200 and whole, but not a valid WFMF/WFAD container
    DC_FETCH_STATUS,      // a whole non-200 response; *status_out says which
    DC_FETCH_INTERRUPTED, // `interruptible` and the poll-interrupt said stop: decided nothing
} dc_fetch_result_t;

// Streams /api/device/image/<sha256> into PSRAM slot `target` and verifies it.
// NEVER publishes anything: `target` is written, the active slot is not
// referenced at all. `observe` false keeps it off the OLED (a preload is not
// something the person at the Amiga asked for). `interruptible` installs the
// poll-interrupt (dc_set_poll_interrupt) on the transport for this one
// exchange, exactly as dc_step does for the poll: a preload is a background
// fetch seconds long, and a waiting tap must not queue behind it (final
// review I1). The swap fetch never passes it -- that is the disk someone asked
// for, and cutting it short would only mean fetching it again.
//
// Task 8: a fetch always targets the slot that is NOT the one core0 is
// currently streaming from -- the caller passes psram_inactive_slot().
// image_parse_begin() resets that slot up front (so stale data from an earlier
// aborted fetch can never be mistaken for this one) and points the incremental
// parser at it; dc_image_sink below feeds it body bytes straight off the wire
// as dc_exchange's read loop hands them over -- there is no SRAM buffer big
// enough to hold a whole image (up to ~2 MB, psram_image.h) first.
static dc_fetch_result_t dc_fetch_into(device_client_t *c, const char *sha256, int target,
                                       bool observe, bool interruptible, int *status_out) {
    *status_out = 0;
    // static: see the STACK note above.
    static char path[DC_REQ_BUF_BYTES];
    snprintf(path, sizeof path, "/api/device/image/%s", sha256);

    static char req[DC_REQ_BUF_BYTES];
    int req_len = http_build_request(req, sizeof req, "GET", path, c->host, c->token, NULL);
    if (req_len < 0) return DC_FETCH_NO_REQUEST;

    // Digests are not secret here -- /api/ingest/check is a deliberate global
    // existence oracle and TOSEC publishes thousands of them -- so a prefix is
    // safe to print and is what makes a fetch traceable against the server side.
    g_img_got = 0;
    g_img_next = 262144;
    g_img_t0 = 0;   // set by the sink on the first body byte
    g_img_quiet = !observe;
    wf_logf(WF_INFO, "fetch: %.12s -> slot %d (psram %s)", sha256, target,
            psram_image_available() ? "ok" : "MISSING");
    image_parse_begin(target);

    c->state = DC_FETCHING;
    static http_resp_t r;   // static: see the STACK note above
    g_img_resp = &r;
    c->_fetch_pct = -1;     // a fresh transfer reports 0% again
    if (observe) dc_emit(c, DC_OBS_FETCH_BEGIN, 0, 0);
    // Set just before, cleared just after, whatever happened -- dc_step's rule.
    if (interruptible) {
        c->t->interrupted = c->_poll_intr;
        c->t->interrupt_ctx = c->_poll_intr_ctx;
    }
    bool interrupted = false;
    bool ok = dc_exchange_i(c, req, req_len, dc_image_sink, c, &r, /*retryable=*/true,
                            &interrupted);
    c->t->interrupted = NULL;
    c->t->interrupt_ctx = NULL;
    *status_out = r.status;
    if (interrupted) {
        // dc_exchange_i has abandoned the connection (the rest of the body is
        // still owed on it). `target` holds a partial image: never published,
        // and the caller's record was dropped before the transfer began.
        wf_logf(WF_INFO, "fetch: %.12s interrupted after %ld bytes -- a tap or a write is waiting",
                sha256, g_img_got);
        return DC_FETCH_INTERRUPTED;
    }

    if (!ok || !r.body_complete) {
        // Deliberately detailed: this branch NEVER blocks the digest, so it
        // retries the same fetch forever, and from the console that is
        // indistinguishable from a stalled server unless it says which of the
        // three things went wrong. `_body_got` is parser-internal, but it is
        // the only record of how far the transfer actually got -- the whole
        // question for a 2 MB body on a device whose largest previous transfer
        // was a few hundred bytes.
        wf_logf(WF_WARN, "fetch: incomplete -- exchange=%s status=%d "
                "complete=%s got=%ld of %ld",
                ok ? "ok" : "FAILED", r.status,
                r.body_complete ? "yes" : "no",
                r._body_got, r.content_length);
        return DC_FETCH_INCOMPLETE;
    }
    if (r.status != 200) return DC_FETCH_STATUS;

    // DC_VERIFYING: image_parse_end() is "fill, then verify" -- it
    // returns true only if the parser reached a clean end-of-container
    // AND every track in it landed in PSRAM (image_loader.c). That,
    // together with "the whole body arrived intact" already checked
    // above, is the verification this layer does; there is no
    // separate state to hold for it once control reaches here.
    if (observe) dc_emit(c, DC_OBS_VERIFY, (uint32_t)g_img_got, (uint32_t)g_img_got);
    if (!image_parse_end()) return DC_FETCH_INVALID;
    return DC_FETCH_OK;
}

// --- DF1 second drive (spec 2026-10-08 §4): core1's policy ---------------

void dc_set_df1(device_client_t *c, df1_mode_t mode, bool hd_ok) {
    c->_df1_capable = true;
    c->_df1_mode = (uint8_t)mode;
    c->_df1_hd_ok = hd_ok;
}

void dc_set_df1_quiesce(device_client_t *c, bool (*fn)(void *), void *ctx) {
    c->_df1_quiesce = fn;
    c->_df1_quiesce_ctx = ctx;
}

// The slot DF1 should hold right now (spec §4 "What DF1 serves"): the verified
// preload, only while DF1 is on, DF0 holds a disk, the record still names the
// idle slot AND still names the server's current next, and the disk fits DF1's
// buffer.
//
// "Still the current next" is not in the spec's sentence but is what it means:
// a record the server has moved past (a poll named a different next) is about
// to be overwritten by dc_preload_step, which ejects DF1 first. Without this
// condition the reconcile at the end of that same step would put the stale
// disk straight back whenever the write had to wait for core0 -- an eject and
// re-insert per pass, each one a disk change the Amiga sees.
static int dc_df1_want(const device_client_t *c) {
    const dc_preload_t *p = &c->preload;
    if (c->_df1_mode != DF1_MODE_NEXT || p->slot == SLOT_NONE || p->loading) return SLOT_NONE;
    if (psram_active_slot() == SLOT_NONE || p->slot != psram_inactive_slot()) return SLOT_NONE;
    if (p->sha256[0] == '\0' || strcmp(p->sha256, p->next_sha256) != 0) return SLOT_NONE;
    if (!c->_df1_hd_ok && psram_image_slot_kind(p->slot) == SLOT_KIND_ADF_HD) return SLOT_NONE;
    return p->slot;
}

void dc_df1_reconcile(device_client_t *c) {
    const int want = dc_df1_want(c);
    if (psram_df1_slot() == want) return;
    if (psram_publish_df1(want))
        wf_logf(WF_INFO, "df1: %s", want == SLOT_NONE ? "ejected" : "inserted the next disk");
}

// Before ANY write into `target` (Review Focus 1): if DF1 holds it, eject DF1
// and wait for core0 to say it stopped reading. False = do not write now.
//
// The two writers into a PSRAM slot on core1 are dc_fetch_image (a regular
// fetch) and dc_preload_step, both through dc_fetch_into, both into
// psram_inactive_slot(); both call this first. core0's own writes
// (write_back_apply) go to DF0's active slot, which DF1 can never hold
// (psram_publish_df1 refuses it), and the uploader only moves dirty flags of
// the active slot.
static bool dc_df1_release(device_client_t *c, int target) {
    if (psram_df1_slot() != target && psram_df1_quiescent()) return true;
    if (psram_df1_slot() == target) psram_publish_df1(SLOT_NONE);
    if (!c->_df1_quiesce) return psram_df1_quiescent();
    if (c->_df1_quiesce(c->_df1_quiesce_ctx)) return true;
    wf_logf(WF_WARN, "df1: core0 has not let go of slot %d -- write deferred", target);
    c->df1_deferred = true;
    return false;
}

// Fetches `d->sha256` from the image endpoint. Only reached once the poll
// has named a digest that is neither already mounted nor already known
// bad. On any failure -- transport-level, or a dropped/incomplete body --
// this touches nothing: rule 2 (never release the current disk before the
// replacement is fetched *and* verified) means an incomplete fetch is not
// a partial success, it is simply not a swap.
static dc_state_t dc_fetch_image(device_client_t *c, const dc_desired_t *d) {
    // DF1 (Task 15): the idle slot may be what DF1 is serving. Eject it and
    // wait for core0 before a byte is written. `since` is not advanced, so the
    // next poll redelivers this instruction at once. The record is dropped on
    // the way out as well: this fetch WILL overwrite the slot when it runs,
    // and a kept record would have dc_df1_reconcile re-insert the disk this
    // just ejected -- a disk change on DF1 for every deferred poll.
    if (!dc_df1_release(c, psram_inactive_slot())) {
        c->preload.slot = SLOT_NONE;
        c->preload.sha256[0] = '\0';
        c->state = DC_IDLE_POLL;
        return c->state;
    }
    // Multi-disk §4.3: this fetch is about to overwrite the idle slot, so
    // whatever a preload left there is no longer what the record says --
    // dropped FIRST, before a byte is written, and whatever the outcome.
    c->preload.slot = SLOT_NONE;
    c->preload.sha256[0] = '\0';

    // Nothing below this line may touch the active slot except the single
    // psram_publish_slot() call in the 200 case, and only after the body is
    // known to have arrived whole AND parsed clean: that ordering is rule 2
    // (never release the current disk before the replacement is fetched
    // *and* verified) made concrete.
    int target = psram_inactive_slot();
    int status = 0;
    switch (dc_fetch_into(c, d->sha256, target, /*observe=*/true, /*interruptible=*/false,
                          &status)) {
    case DC_FETCH_NO_REQUEST:
        return dc_enter_backoff(c); // path too long: unexpected, treat as transient

    case DC_FETCH_INCOMPLETE:
    case DC_FETCH_INTERRUPTED:   // never: this fetch is not interruptible
        // Connect/write/read failure, a response that never parsed as HTTP
        // at all, or a connection dropped before the body finished -- all
        // treated alike. Never block the digest for these: none of them
        // tell us anything reliable about the digest itself, and it may be
        // perfectly fetchable next time. `target` holds whatever partial
        // track data the parser managed to write before the drop (never
        // published -- see below), and the active slot was never
        // referenced above, so psram_active_slot() is exactly what it was
        // on entry -- the Amiga keeps the disk it had.
        return dc_enter_backoff(c);

    case DC_FETCH_INVALID:
        // Content-Length matched what arrived, but the bytes
        // themselves are not a well-formed, complete WFMF or WFAD
        // container. Resending the exact same bytes under this digest
        // would fail the same way every time, so this digest is
        // treated like the 400/404/422 cases below rather than backed
        // off forever.
        wf_logf(WF_WARN, "fetch: %.12s arrived complete but is not a "
                "valid WFMF or WFAD container -- digest blocked", d->sha256);
        dc_block_digest(c, d->sha256);
        // Review (final), Important 2: `since` has NOT advanced -- only
        // dc_complete_transition moves it, and no transition happened
        // here. The server answers a poll with `version > since`
        // immediately (src/app/api/device/poll/route.ts), so returning
        // DC_IDLE_POLL would send main.c straight back into another
        // full TLS handshake with no delay at all, forever, for as long
        // as this digest stays desired. Backing off is the floor that
        // turns a permanently-unfetchable disk into a slow retry rather
        // than a request storm; the poll loop keeps running, which is
        // what spec 4.2 asks for.
        return dc_enter_backoff(c);

    case DC_FETCH_OK:
        // DC_SWAPPING is the moment right here: the single word-aligned
        // store psram_publish_slot() makes -- see its comment in
        // psram_image.c for why moving between two complete, verified
        // images that way can never show core0 a half-fetched one.
        c->state = DC_SWAPPING;
        {
            uint32_t ms = c->now() - g_img_t0;
            wf_logf(WF_INFO, "fetch: read=%lu ms feed=%lu ms",
                    (unsigned long)g_ms_read, (unsigned long)g_ms_feed);
            wf_logf(WF_INFO, "fetch: verified in %lu ms (%lu KB/s), publishing slot %d",
                    (unsigned long)ms,
                    (unsigned long)(ms ? (unsigned long)g_img_got / ms * 1000u / 1024u : 0u),
                    target);
        }
        psram_publish_slot(target);
        dc_complete_transition(c, d->version, d->sha256, d->disk_id, d->write_protected);
        dc_emit(c, DC_OBS_MOUNTED, 0, 0);
        c->state = DC_IDLE_POLL;
        dc_backoff_reset(c);
        return c->state;

    case DC_FETCH_STATUS:
        break;
    }

    switch (status) {
    case 400: // malformed digest: will not become valid by resending
    case 404: // not entitled / no longer exists
    case 422: // permanently unencodable
        // Never retry this exact digest, but keep polling -- the desired
        // state may change to something fetchable (spec §4.2). Backed off
        // rather than returned as DC_IDLE_POLL for the same reason as the
        // parse-failure case above: `since` did not advance, so an
        // immediate re-poll is answered immediately and the loop spins.
        wf_logf(WF_WARN, "fetch: server said %d -- digest blocked, not retried",
                status);
        dc_block_digest(c, d->sha256);
        return dc_enter_backoff(c);

    case 401:
        c->state = DC_HALTED; // token is dead; 401 anywhere halts
        return c->state;

    default:
        // 5xx and anything else unlisted: transient. Blocking the digest
        // here would strand a disk that becomes fetchable again once the
        // blob store recovers.
        return dc_enter_backoff(c);
    }
}

void dc_set_hold(device_client_t *c, dc_hold_fn fn, void *ctx) {
    c->_hold = fn;
    c->_hold_ctx = ctx;
}

void dc_set_fw_report(device_client_t *c, const dc_fw_report_t *r) { c->_fw_report = r; }

// Lifts `update` out of a 200 poll body BEFORE anything else reads it: its
// version/sha256 keys would otherwise be found by the disk logic's flat scans.
static void dc_take_fw_fields(device_client_t *c, char *json) {
    c->fw_offer_present = json_object(json, "update", c->fw_update_json,
                                      sizeof c->fw_update_json, true);
    // Final review m2: an `update` that is there but could not be lifted (too
    // large, unterminated, not an object) is malformed -- never read as "no
    // update", which would make it a cancel (or, on the first cursor, a sync).
    bool malformed = !c->fw_offer_present && json_has(json, "update") &&
                     !json_is_null(json, "update");
    c->fw_offer_malformed = false;
    uint32_t iv = 0;
    if (json_u32(json, "instructionVersion", &iv) && iv > c->fw_instruction_version) {
        // The first cursor since dc_init (still 0) with no update is the
        // server's normal echo -- a sync to ack, not a cancel (device_client.h).
        c->fw_instruction_is_sync = c->fw_instruction_version == 0 &&
                                    !c->fw_offer_present && !malformed;
        c->fw_offer_malformed = malformed;
        c->fw_instruction_version = iv;
        c->fw_instruction_new = true;
    } else if (c->fw_offer_present) {
        // An update with no moved cursor is stale. Never act on it.
        c->fw_offer_present = false;
    }
}

// Lifts `nfcWrite` out of a 200 poll body BEFORE the disk logic reads it,
// for the same reason dc_take_fw_fields lifts `update`: its "diskId" would
// otherwise be found by dc_handle_poll_body's flat scans -- and with nfcWrite
// ahead of `desired` in the body, it would be read as the desired disk's id.
//
// The copy buffer is DC_POLL_BODY_BYTES, the size of the body itself, so a
// well-formed object can never be too big to lift: a lift that failed for
// size would leave the object un-blanked, its diskId visible to those scans.
static void dc_take_nfc_write(device_client_t *c, char *json) {
    static char obj[DC_POLL_BODY_BYTES];   // static: see the STACK note above
    if (!json_object(json, "nfcWrite", obj, sizeof obj, true)) return;  // absent (or null)
    uint32_t seq = 0;
    // Strict: a wrapped or fractional seq could jump the cursor past a real
    // request, which would then never be delivered again.
    if (!json_u32_strict(obj, "seq", &seq) || seq <= c->nfc_ack) return;
    // Read into a buffer wider than an id, THEN check the shape: a fixed
    // 37-byte copy would clip an over-long value back into a valid-looking id.
    char id[NFC_DISK_ID_LEN + 8];
    id[0] = '\0';
    if (!json_str(obj, "diskId", id, sizeof id) || !nfc_disk_id_valid(id)) id[0] = '\0';
    c->nfc_write_seq = seq;
    // id is valid (36 chars) or empty here; the precision only tells gcc so
    // (its -Wformat-truncation cannot see nfc_disk_id_valid, and CI's -Werror stops on it).
    snprintf(c->nfc_write_disk_id, sizeof c->nfc_write_disk_id, "%.*s",
             (int)(sizeof c->nfc_write_disk_id - 1), id);
    c->nfc_write_title[0] = '\0';
    if (id[0]) json_str(obj, "title", c->nfc_write_title, sizeof c->nfc_write_title);
    // Multi-disk §4.5: kind "next" (with no disk) is the Next-disk card. A
    // null diskId WITHOUT it is a disarm, as it always was -- and a kind that
    // came with a disk id is not a Next card, since there is one thing to write.
    char kind[8];
    kind[0] = '\0';
    if (!json_str(obj, "kind", kind, sizeof kind)) kind[0] = '\0';
    c->nfc_write_next = strcmp(kind, "next") == 0 && id[0] == '\0';
    c->nfc_write_new = true;
}

// Drops the preload record: the idle slot is no longer trusted to hold it.
static void dc_preload_drop(device_client_t *c) {
    c->preload.slot = SLOT_NONE;
    c->preload.sha256[0] = '\0';
}

// A 64-character LOWERCASE hex digest, and nothing else -- the server's own
// shape (/^[0-9a-f]{64}$/). `next` goes into an image URL and is compared
// byte-for-byte against desired's digest, so an uppercase spelling of the same
// disk would never match it: anything that is not exactly the server's shape
// is not a disk worth preloading.
static bool dc_is_sha256_hex(const char *s) {
    int n = 0;
    for (; s[n]; n++) {
        char ch = s[n];
        bool hex = (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f');
        if (!hex || n >= 64) return false;
    }
    return n == 64;
}

// Multi-disk §4.3: lifts `next` out of a 200 poll body BEFORE the disk logic
// reads it, for the reason dc_take_nfc_write lifts `nfcWrite`: its sha256,
// diskId and diskNo would otherwise be found by dc_handle_poll_body's flat
// scans -- and with `next` ahead of `desired` in a body, next's digest would
// be FETCHED AND MOUNTED as the desired disk. The server emits it after
// `desired`, but nothing here may depend on that.
//
// Absent: changes nothing (an older server, or desired: null). `next: null`:
// no next disk, and the preload record is dropped. A present `next` does NOT
// drop the record even when it names a different disk: the poll that swaps to
// the preloaded disk B is the same poll that names C as the new next, and
// dropping B here -- before dc_handle_poll_body sees desired == B -- would make
// every Next tap a full fetch. dc_preload_step replaces the record when it
// fetches C, and the swap check compares digests, so a record that is merely
// no longer "next" can never be published as the wrong disk.
//
// The copy buffer is DC_POLL_BODY_BYTES, the size of the body itself, for the
// reason dc_take_nfc_write's is: a well-formed object can then never be too big
// to lift, and a lift that failed for size would leave it un-blanked.
static void dc_take_next(device_client_t *c, char *json) {
    static char obj[DC_POLL_BODY_BYTES];   // static: see the STACK note above
    if (json_object(json, "next", obj, sizeof obj, true)) {
        char sha[72];
        sha[0] = '\0';
        if (!json_str(obj, "sha256", sha, sizeof sha) || !dc_is_sha256_hex(sha)) sha[0] = '\0';
        c->preload.known = true;
        snprintf(c->preload.next_sha256, sizeof c->preload.next_sha256, "%.*s",
                 (int)(sizeof c->preload.next_sha256 - 1), sha);
        c->preload.next_disk_id[0] = '\0';
        json_str(obj, "diskId", c->preload.next_disk_id, sizeof c->preload.next_disk_id);
        c->preload.next_disk_no = 0;
        json_u32(obj, "diskNo", &c->preload.next_disk_no);
        return;
    }
    if (json_is_null(json, "next")) {
        c->preload.known = true;
        c->preload.next_sha256[0] = '\0';
        c->preload.next_disk_id[0] = '\0';
        c->preload.next_disk_no = 0;
        dc_preload_drop(c);
    }
    // Anything else (absent, or not an object) says nothing about next.
}

void dc_force_refetch(device_client_t *c) {
    c->_refetch = true;
    c->since = 0;
}

void dc_adopt_image(device_client_t *c, const char *sha256) {
    strncpy(c->mounted_sha256, sha256, sizeof(c->mounted_sha256) - 1);
    c->mounted_sha256[sizeof(c->mounted_sha256) - 1] = '\0';
}

// D7: a disk with writes the server has not got is never released. Only
// when something IS mounted -- with nothing mounted there is nothing to lose.
// Sets c->held for the caller's pacing (main.c), and logs only when a hold
// begins: a hold on an idle-waiting Amiga is re-asked every paced poll.
static bool dc_held(device_client_t *c) {
    if (c->mounted_sha256[0] == '\0' || !c->_hold) return false;
    if (!c->_hold(c->_hold_ctx)) return false;
    if (!c->_was_held)
        wf_logf(WF_INFO, "hold: the disk is busy (unsent writes, or the Amiga not idle), not releasing it yet");
    c->held = true;
    return true;
}

// Acts on a fully-received 200 poll body. `json` is NUL-terminated.
// Lifts `secondDrive` ({"seq":N,"mode":"off"|"df1"}) out of a 200 poll body
// and BLANKS it, before any flat lookup: its counter is `seq`, never
// `version`, and blanking keeps its keys from shadowing the body's own.
// Only a DF1-capable build reads it; an older one sends no &driveAck= and the
// server never wakes it for this. Unknown mode -> off, never on.
static void dc_take_second_drive(device_client_t *c, char *json) {
    static char obj[128];   // {"seq":4294967295,"mode":"df1"} is 31; static: STACK note
    if (!c->_df1_capable || !json_object(json, "secondDrive", obj, sizeof obj, true)) return;
    uint32_t seq;
    if (!json_u32_strict(obj, "seq", &seq)) return;
    char mode[8] = "";
    json_str(obj, "mode", mode, sizeof mode);
    const uint8_t want = strcmp(mode, "df1") == 0 ? DF1_MODE_NEXT : DF1_MODE_OFF;
    // Nothing new only when BOTH the seq is acked AND the board already runs
    // that mode (final review I1). A re-paired board seeds ack 0 against a new
    // row at {seq 0, off}: comparing the seq alone left it running DF1 while
    // the server showed Off as applied. The same covers a DF1-default TEST
    // build with nothing stored, and a handoff a re-pair interrupted (Task 19
    // M1). _df1_mode is what core0 runs (main.c seeds it on every entry).
    if (seq == c->drive_ack && !c->drive_owed && want == c->_df1_mode) return;
    c->drive_want_seq = seq;
    c->drive_want_mode = want;
    c->drive_owed = true;
}

bool dc_drive_take(device_client_t *c, uint32_t *seq, df1_mode_t *mode) {
    if (!c->drive_owed) return false;
    c->drive_owed = false;
    *seq = c->drive_want_seq;
    *mode = (df1_mode_t)c->drive_want_mode;
    return true;
}

void dc_drive_handled(device_client_t *c, uint32_t seq) { c->drive_ack = seq; }

bool dc_drive_report_owed(const device_client_t *c) {
    return c->_df1_capable &&
           (!c->_drive_sent_valid || c->_drive_sent_mode != c->_df1_mode ||
            c->_drive_sent_ack != c->drive_ack);
}

static dc_state_t dc_handle_poll_body(device_client_t *c, const char *json) {
    // OLED layouts (spec 2026-10-04 §6): the server's display version, read
    // before anything about the disk can return early. Absent (an older
    // server, or no layout ever published) leaves the cursor alone; strict, so
    // a wrapped or malformed number is not mistaken for a version.
    //
    // A version BELOW the ack is a server-side reset, not news: the cursor
    // belongs to another device row (a re-paired board, whose stored ack is
    // the old row's). The server sends displayVersion on every poll body when
    // the board sends displayAck, so this is seen at the first 200. Start
    // over: ack 0, so a positive version is fetched once and 0 owes nothing.
    //
    // Final review I1: the reset must also take the OLD row's layout off the
    // glass. A positive version does that by being fetched; version 0 fetches
    // nothing, so it raises display_reset_to_default and main.c puts the
    // panel's default on under version 0 (the same-boot re-pair's path).
    // The server wakes the poll on ANY ack/version mismatch, so a stale
    // higher ack seeded across a reboot reaches this at the first poll.
    uint32_t dv;
    if (json_u32_strict(json, "displayVersion", &dv)) {
        if (dv < c->display_ack) {
            c->display_ack = 0;
            c->display_error[0] = '\0';
            if (dv == 0) c->display_reset_to_default = true;
        }
        c->display_want = dv;
    }

    uint32_t version = 0;
    if (!json_u32(json, "version", &version)) {
        // Can't even read the reconciliation counter: nothing here can be
        // trusted enough to act on. Treat like any other transient fault.
        return dc_enter_backoff(c);
    }

    if (json_is_null(json, "desired")) {
        // Final review m6: nothing is (to be) mounted, so there is no title
        // whose next disk is worth fetching. Cleared on delivery -- before the
        // hold, which only delays releasing the disk, not the server's word --
        // so a board that keeps its `next` from before an eject never
        // preloads a disk of a title no longer mounted. (The server sends no
        // `next` with desired: null, which dc_take_next reads as "nothing
        // said".) The verified record, if any, is left alone: it is only ever
        // published when a later desired names its exact digest.
        c->preload.next_sha256[0] = '\0';
        c->preload.next_disk_id[0] = '\0';
        c->preload.next_disk_no = 0;
        if (dc_held(c)) { c->state = DC_IDLE_POLL; return c->state; }
        // The one explicit, unambiguous eject instruction. No fetch is
        // needed -- the transition is "hold no disk", which is complete
        // the instant it is acted on. Task 8: that now includes publishing
        // SLOT_NONE, so track_cache_get() actually stops streaming rather
        // than only this struct's bookkeeping saying nothing is mounted.
        psram_publish_slot(SLOT_NONE);
        c->_fetch_title[0] = '\0';
        c->_fetch_label[0] = '\0';
        c->_fetch_disk_no = c->_fetch_disk_count = 0;
        dc_emit(c, DC_OBS_EJECTED, 0, 0);
        // write_protected is meaningless with nothing mounted -- pass true
        // anyway (rather than leaving whatever the previous disk reported)
        // so a stale "writable" can never survive an eject in this field.
        dc_complete_transition(c, version, "", "", true);
        // A real transition: `since` has advanced, so the next poll is a
        // genuine long poll again. This -- not merely receiving a 200 --
        // is what earns a backoff reset (see dc_step's case 200).
        dc_backoff_reset(c);
        c->state = DC_IDLE_POLL;
        return c->state;
    }

    dc_desired_t d;
    memset(&d, 0, sizeof d);
    if (!json_str(json, "sha256", d.sha256, sizeof d.sha256) || d.sha256[0] == '\0') {
        // "desired" present but the one field that identifies what to
        // fetch is missing or itself null -- malformed, not an
        // instruction. Never guess at a disk change from this.
        return dc_enter_backoff(c);
    }
    // diskId is read best-effort -- display metadata, never gates a fetch.
    json_str(json, "diskId", d.disk_id, sizeof d.disk_id);

    // Likewise the human-readable identity, which the server has sent all
    // along (src/lib/mount.ts) and this device used to discard. Best-effort
    // in the strongest sense: a missing or malformed title must never stop a
    // disk mounting -- the drive's job is to hold the disk, and a blank line
    // on a display is not a reason to refuse. json_str leaves the buffer
    // untouched and returns false when the key is absent, so the memset of
    // these fields below is what guarantees a stale title cannot survive
    // into a different disk.
    c->_fetch_title[0] = '\0';
    c->_fetch_label[0] = '\0';
    c->_fetch_disk_no = c->_fetch_disk_count = 0;
    json_str(json, "game",  c->_fetch_title, sizeof c->_fetch_title);
    json_str(json, "label", c->_fetch_label, sizeof c->_fetch_label);
    json_u32(json, "diskNo",    &c->_fetch_disk_no);
    json_u32(json, "diskCount", &c->_fetch_disk_count);
    // writeProtected fails safe: if it's absent or not a JSON boolean, this
    // disk is treated as write-protected, not writable. The two ways to
    // get this wrong are not symmetric -- presenting a genuinely
    // read-only disk as writable risks a write the server never agreed to
    // accept, where the reverse only costs a write the host will retry as
    // read-only. memset above already zeroed the struct (false), so the
    // safe default has to be set explicitly here, before the real value
    // (if present) overwrites it.
    d.write_protected = true;
    json_bool(json, "writeProtected", &d.write_protected);
    d.version = version;
    d.present = true;

    if (!c->_refetch && c->mounted_sha256[0] != '\0' && strcmp(d.sha256, c->mounted_sha256) == 0) {
        // Already holding exactly this disk: nothing to fetch. Catching
        // `since` up here (rather than leaving it behind version after
        // version) avoids re-attempting this same no-op every poll.
        dc_complete_transition(c, version, d.sha256, d.disk_id, d.write_protected);
        // Not redundant with the DC_OBS_MOUNTED after a fetch: on a board that
        // rebooted with its disk still in PSRAM, or one whose display was
        // attached later, this reconciliation poll is the ONLY place the
        // title is ever spoken. Without it the panel would read LOADED with
        // no name until the next time the operator changed disks.
        dc_emit(c, DC_OBS_MOUNTED, 0, 0);
        dc_backoff_reset(c);   // `since` advanced: a productive poll
        c->state = DC_IDLE_POLL;
        return c->state;
    }

    if (dc_digest_is_blocked(c, d.sha256)) {
        // Known unfetchable; keep polling without retrying it -- but not
        // instantly. This is the short-circuit that made the storm
        // self-sustaining: no request goes out at all here, so without a
        // delay main.c would re-enter dc_step immediately, poll again
        // (answered at once, since `since` is still behind `version`), and
        // land right back here at full TLS-handshake rate.
        return dc_enter_backoff(c);
    }

    if (dc_held(c)) { c->state = DC_IDLE_POLL; return c->state; }

    // Multi-disk §4.4: the disk wanted is the one already verified in the idle
    // slot -- publish it, with no fetch. All three conditions, never fewer:
    //   * a record exists;
    //   * it is for THE slot a fetch would have written (psram_inactive_slot()),
    //     so the active slot -- what the Amiga reads now -- is never the one
    //     "swapped in", and a record left over from before an eject or a
    //     second swap cannot name a slot that has since changed role;
    //   * its digest is DESIRED's digest, not next's (R2).
    // A forced refetch means the server's copy must be fetched afresh, so it
    // never takes this path. The hold was checked just above: a held swap
    // waits here exactly as a fetch would, and happens on a later poll.
    if (!c->_refetch && c->preload.slot != SLOT_NONE &&
        c->preload.slot == psram_inactive_slot() &&
        strcmp(c->preload.sha256, d.sha256) == 0) {
        wf_logf(WF_INFO, "swap: %.12s from preloaded slot %d", d.sha256, c->preload.slot);
        c->state = DC_SWAPPING;
        psram_publish_slot(c->preload.slot);
        dc_preload_drop(c);
        dc_complete_transition(c, d.version, d.sha256, d.disk_id, d.write_protected);
        dc_emit(c, DC_OBS_MOUNTED, 0, 0);
        c->state = DC_IDLE_POLL;
        dc_backoff_reset(c);
        return c->state;
    }

    return dc_fetch_image(c, &d);
}

void dc_init(device_client_t *c, transport_t *t, clock_ms_fn now,
            const char *host, const char *token) {
    memset(c, 0, sizeof *c);
    c->t = t;
    c->now = now;
    c->host = host;
    c->token = token;
    // since is always 0 at boot and lives only in RAM -- see device_client.h
    // and spec §4.1. Nothing here persists it.
    c->state = (token && token[0]) ? DC_IDLE_POLL : DC_UNPROVISIONED;
    c->preload.slot = SLOT_NONE;   // 0 is a real slot; memset's zero is not "none"
    // Every build from 1.7.0 can take a layout (spec 2026-10-04 §6).
    c->display_layouts = true;
}

// Escapes `"` and `\` (the two bytes that would break out of a JSON string)
// and replaces any control byte with a space, copying at most out_len - 1
// bytes of input into `out`. `err` is firmware-authored text (a short
// static string or errno-derived message), never network input, but the
// status report is still JSON we are constructing by hand, and an
// unescaped quote in it would produce a malformed body silently.
static void dc_json_escape(char *out, int out_len, const char *in) {
    int n = 0;
    for (const unsigned char *p = (const unsigned char *)in; *p; p++) {
        if (*p == '"' || *p == '\\') {
            if (n + 2 > out_len - 1) break;
            out[n++] = '\\';
            out[n++] = (char)*p;
        } else if (*p < 0x20) {
            if (n + 1 > out_len - 1) break;
            out[n++] = ' ';
        } else {
            if (n + 1 > out_len - 1) break;
            out[n++] = (char)*p;
        }
    }
    out[n] = '\0';
}

// One-shot, unauthenticated registration (spec §7; see device_client.h).
// Builds {pairingCode, firmwareVersion, macAddress} and posts it with no
// bearer at all (http_build_request(..., NULL, ...) omits the Authorization
// header entirely) -- deliberately, since the pairing code IS the
// credential here, and sending c->token (which may well be a stale or
// placeholder value the caller passed to dc_init just to get a
// transport/host-bearing device_client_t) would be actively misleading
// about what authenticates this one request.
//
// pairing_code/firmware_version/mac are firmware-authored or compile-time
// values, not network input, but are still escaped before landing in
// hand-built JSON for the same reason dc_report_status escapes `err`.
//
// On a 200 whose body has a non-empty `token`, persists it via
// token_store_save() (never logged -- see device_client.h) and returns
// DC_REG_OK. A 400 whose body's `error` field is exactly
// "invalid_or_used_code" returns DC_REG_BAD_CODE (spec D-4b-4: terminal,
// not retryable) and stores nothing. Any other outcome -- transport
// failure, a different 400, another non-200 status, or a 200 body missing
// `token` -- returns DC_REG_RETRY and stores nothing.
dc_register_result_t dc_register(device_client_t *c, const char *pairing_code,
                 const char *firmware_version, const char *mac) {
    // static: see the STACK note above. dc_register runs only from
    // core1_main's registration loop, one call at a time, and never while
    // dc_step or dc_report_status is on the stack.
    // fv_esc is sized from DC_STATUS_VER_BYTES, not a literal: a board that
    // could REGISTER a version it may not REPORT would send two different
    // identities for one image. dc_json_escape truncates silently, so at 32
    // a version past 31 characters registered short and then changed on the
    // first heartbeat -- reading as an unrecognised build in between.
    static char pc_esc[80], fv_esc[DC_STATUS_VER_BYTES], mac_esc[32];
    dc_json_escape(pc_esc, sizeof pc_esc, pairing_code);
    dc_json_escape(fv_esc, sizeof fv_esc, firmware_version);
    dc_json_escape(mac_esc, sizeof mac_esc, mac);

    // Firmware self-update (piece 2b): register declares the protocol the
    // same way status does -- only when a report has been set AND it opted
    // in, never as a bare claim from an unset report.
    char reg_tail[32] = "";  // Sized for literal (18) + int width (11) + NUL; gcc -Wformat-truncation
    if (c->_fw_report && c->_fw_report->update_protocol > 0) {
        snprintf(reg_tail, sizeof reg_tail, ",\"updateProtocol\":%d",
                 c->_fw_report->update_protocol);
    }

    static char body[DC_REGISTER_BODY_BYTES];
    int body_len = snprintf(body, sizeof body,
        "{\"pairingCode\":\"%s\",\"firmwareVersion\":\"%s\",\"macAddress\":\"%s\"%s}",
        pc_esc, fv_esc, mac_esc, reg_tail);
    // Review round 1, Important I-2: every failure path below calls
    // dc_enter_backoff() -- the same exponential-from-the-floor, jittered,
    // capped backoff dc_step()/dc_fetch_image() already use -- rather than
    // just returning false. Without it, main.c's register loop (which reads
    // c->backoff_ms and sleeps on it) always saw 0 for a fresh
    // device_client_t, so a bad or already-used pairing code hammered the
    // deliberately UNAUTHENTICATED /api/device/register endpoint at a flat
    // 1 req/s forever instead of backing off. Note dc_enter_backoff()
    // returns dc_state_t, not bool -- DC_BACKOFF is nonzero, so
    // `return dc_enter_backoff(c);` from this bool-returning function would
    // silently return true on every failure. Each call site below is
    // deliberately its own statement, discarding that return value, with an
    // explicit `return false;` beside it.
    if (body_len < 0 || body_len >= (int)sizeof body) {
        dc_enter_backoff(c);
        return DC_REG_RETRY;
    }

    static char req[DC_REGISTER_REQ_BYTES];
    int req_len = http_build_request(req, sizeof req, "POST", DC_REGISTER_PATH,
                                     c->host, NULL, body);
    if (req_len < 0) {
        dc_enter_backoff(c);
        return DC_REG_RETRY;
    }

    // static: see the STACK note above. `resp` and `token` hold the
    // device token on the success path, so both are wiped before every
    // return below rather than left sitting in BSS for the life of the
    // process -- main.c's own copy is the one that persists.
    static dc_body_buf_t resp;
    resp.len = 0;
    resp.truncated = false;
    resp.buf[0] = '\0';
    static http_resp_t r;
    static char token[TOKEN_STORE_MAX_LEN + 1];

    bool ok = dc_exchange(c, req, req_len, dc_body_sink, &resp, &r,
                             // A single-use pairing code: never resend this one.
                             /*retryable=*/false);
    if (!ok || !r.body_complete || resp.truncated) {
        // resp.truncated: the register response is a small fixed-shape
        // object and cannot legitimately overrun DC_POLL_BODY_BYTES, so a
        // truncated one is not a response worth parsing an error or a
        // token out of.
        memset(&resp, 0, sizeof resp);
        dc_enter_backoff(c);
        return DC_REG_RETRY;
    }

    if (r.status != 200) {
        // Spec D-4b-4: a 400 body naming invalid_or_used_code is
        // terminal, not retryable -- the pairing code is single-use with
        // a 10-minute TTL and cannot become valid again. Every other
        // non-200 (including a different 400 body) stays retryable, same
        // as before this distinction existed.
        static char err[32];
        bool bad_code = r.status == 400 &&
            json_str(resp.buf, "error", err, sizeof err) &&
            strcmp(err, "invalid_or_used_code") == 0;
        memset(&resp, 0, sizeof resp);
        dc_enter_backoff(c);
        return bad_code ? DC_REG_BAD_CODE : DC_REG_RETRY;
    }

    if (!json_str(resp.buf, "token", token, sizeof token) || token[0] == '\0') {
        memset(&resp, 0, sizeof resp);
        memset(token, 0, sizeof token);
        dc_enter_backoff(c);
        return DC_REG_RETRY;
    }

    bool saved = token_store_save(token);
    memset(&resp, 0, sizeof resp);
    memset(token, 0, sizeof token);
    if (!saved) {
        dc_enter_backoff(c);
        return DC_REG_RETRY;
    }
    dc_backoff_reset(c);
    return DC_REG_OK;
}

// Sends one status heartbeat (spec §4.3, §10; see device_client.h for the
// null-vs-omitted contract). Shares dc_exchange -- the same connect/write/
// read loop dc_step and dc_fetch_image use -- rather than duplicating it;
// only the request bytes (a POST with a body, built via the same
// http_build_request the GET call sites use) differ.
//
// mountedSha256 and mountedDiskId are reported as explicit JSON null when
// nothing is mounted (c->mounted_sha256[0] == '\0'), never omitted: an
// absent key tells the server "no opinion, leave the column alone", while
// null says "I am holding no disk" -- reporting the wrong one leaves a
// stale disk showing in the operator UI after an eject.
//
// Best-effort as far as `backoff_ms`/`state` go: a connect/write/read
// failure or an unexpected status here does not touch either -- the poll
// loop is what keeps the device from looking dead (spec: "a device with a
// broken status path but a healthy poll loop still reads as recently
// seen"). The one exception is 401: the token is dead everywhere it
// appears, so this halts exactly as the poll and image endpoints do.
//
// The return value is NOT best-effort, though (fix round 1): the caller
// needs to know whether the report actually reached the server before it
// updates its own idea of "what I last told the server", or the two can
// drift -- see the header comment.
bool dc_report_status(device_client_t *c, int psram_free, int rssi, const char *err,
                      const char *fw_version) {
    bool mounted = c->mounted_sha256[0] != '\0';

    // static: see the STACK note above. Called only from core1_main's
    // loop, never re-entrantly and never from an interrupt.
    static char sha_field[80];
    snprintf(sha_field, sizeof sha_field, mounted ? "\"%s\"" : "null", c->mounted_sha256);

    static char disk_field[80];
    snprintf(disk_field, sizeof disk_field, mounted ? "\"%s\"" : "null", c->mounted_disk_id);

    static char err_field[DC_STATUS_ERR_BYTES + 2];
    if (err) {
        static char esc[DC_STATUS_ERR_BYTES];
        dc_json_escape(esc, sizeof esc, err);
        snprintf(err_field, sizeof err_field, "\"%s\"", esc);
    } else {
        snprintf(err_field, sizeof err_field, "null");
    }

    // Escaped like the error string. The version is a compile-time constant
    // today, but it reaches this function as a `const char *`, and a body
    // that can be made invalid by its input is a body that eventually will
    // be. NULL reports null rather than omitting the key -- the same honesty
    // rule mountedSha256 follows, since an absent key means "no opinion" to
    // the server and leaves its column alone.
    static char ver_field[DC_STATUS_VER_BYTES + 2];
    if (fw_version) {
        static char ver_esc[DC_STATUS_VER_BYTES];
        dc_json_escape(ver_esc, sizeof ver_esc, fw_version);
        snprintf(ver_field, sizeof ver_field, "\"%s\"", ver_esc);
    } else {
        snprintf(ver_field, sizeof ver_field, "null");
    }

    // Firmware self-update (piece 2b): an opted-in report (update_protocol
    // > 0) appends updateProtocol/firmwareUpdateState/firmwareUpdateError/
    // firmwareInstructionAck; a board that has not opted in sends none of
    // them, not even as null -- claiming the capability at all is an
    // assertion this board can act on an update, which an unset report
    // must never make.
    static char fw_tail[DC_STATUS_ERR_BYTES + 160];
    fw_tail[0] = '\0';
    if (c->_fw_report && c->_fw_report->update_protocol > 0) {
        const dc_fw_report_t *f = c->_fw_report;
        static char st_field[40], er_field[DC_STATUS_ERR_BYTES + 2];
        if (f->state) {
            static char st_esc[32];
            dc_json_escape(st_esc, sizeof st_esc, f->state);
            snprintf(st_field, sizeof st_field, "\"%s\"", st_esc);
        } else snprintf(st_field, sizeof st_field, "null");
        if (f->error) {
            static char er_esc[201];
            dc_json_escape(er_esc, sizeof er_esc, f->error);
            snprintf(er_field, sizeof er_field, "\"%s\"", er_esc);
        } else snprintf(er_field, sizeof er_field, "null");
        snprintf(fw_tail, sizeof fw_tail,
                 ",\"updateProtocol\":%d,\"firmwareUpdateState\":%s,"
                 "\"firmwareUpdateError\":%s,\"firmwareInstructionAck\":%lu",
                 f->update_protocol, st_field, er_field, (unsigned long)f->instruction_ack);
    }

    // nfcReader: "present"/"absent" once main.c knows, and no key at all
    // before then -- an absent key leaves the server's column alone, which is
    // what older firmware (no reader support at all) also sends.
    static char nfc_tail[32];
    nfc_tail[0] = '\0';
    if (c->_nfc_reader[0]) {
        snprintf(nfc_tail, sizeof nfc_tail, ",\"nfcReader\":\"%s\"", c->_nfc_reader);
    }

    // trackMaxBytes: the longest track this build's PSRAM slots hold. The
    // server refuses to mount a disk with longer tracks here (an HFE with a
    // long-track format) instead of sending an image image_loader.c would
    // reject whole. A board built before this field existed sends nothing,
    // and the server assumes 13312, which is what those builds held.
    // preload (multi-disk §4.3): always sent, null when the idle slot holds
    // nothing -- "show both values of a state". Loading names the digest being
    // fetched (next's); ready names the digest verified in the slot.
    static char preload_tail[128];   // 106 at most: 22 + 64 hex + 20
    if (c->preload.loading || c->preload.slot != SLOT_NONE) {
        snprintf(preload_tail, sizeof preload_tail,
                 ",\"preload\":{\"sha256\":\"%s\",\"state\":\"%s\"}",
                 c->preload.loading ? c->preload.next_sha256 : c->preload.sha256,
                 c->preload.loading ? "loading" : "ready");
    } else {
        snprintf(preload_tail, sizeof preload_tail, ",\"preload\":null");
    }

    // OLED layouts (spec 2026-10-04 §6): the capability, the display cursor
    // (the version HANDLED, applied or rejected) and the last refusal's
    // reason, null when it was applied -- both values of the state, always.
    // The reason is layout_decode's text (or main.c's), which can carry
    // quotes or colons, so it is escaped like `err`. Its 47 characters escape
    // to at most 94.
    // 162 at most: 22 (displayLayouts) + 28 (displayVersion) + 16 (key) + 96
    // (94 escaped bytes and the two quotes). test_status_body_fits_at_maximum
    // checks the whole all-quotes reason arrives, closing quote included.
    static char display_tail[192];
    if (c->display_layouts) {
        static char de_field[2 * sizeof c->display_error + 2];
        if (c->display_error[0]) {
            static char de_esc[2 * sizeof c->display_error];
            dc_json_escape(de_esc, sizeof de_esc, c->display_error);
            snprintf(de_field, sizeof de_field, "\"%s\"", de_esc);
        } else snprintf(de_field, sizeof de_field, "null");
        snprintf(display_tail, sizeof display_tail,
                 ",\"displayLayouts\":true,\"displayVersion\":%lu,\"displayError\":%s",
                 (unsigned long)c->display_ack, de_field);
    } else {
        display_tail[0] = '\0';
    }

    // SEL1 (spec §6 step 0): both readings, both values, once main.c knows.
    // 34 bytes at most; DC_STATUS_BODY_BYTES had 63 to spare (header note).
    static char sel1_tail[48];
    const bool sel1_wired_sent = c->_sel1_wired, df1_seen_sent = c->_df1_seen;
    if (c->_sel1_known) {
        snprintf(sel1_tail, sizeof sel1_tail, ",\"sel1Wired\":%s,\"df1Seen\":%s",
                 c->_sel1_wired ? "true" : "false", c->_df1_seen ? "true" : "false");
    } else {
        sel1_tail[0] = '\0';
    }

    // DF1 (Task 15): the digest DF1 serves, null when it serves nothing --
    // both values, from every DF1-capable build; no key at all from one that
    // is not. 79 bytes at most (header note on DC_STATUS_BODY_BYTES).
    static char df1_tail[96];
    if (c->_df1_capable) {
        const int s = psram_df1_slot();
        if (s != SLOT_NONE && s == c->preload.slot && c->preload.sha256[0])
            snprintf(df1_tail, sizeof df1_tail, ",\"df1Sha256\":\"%s\"", c->preload.sha256);
        else snprintf(df1_tail, sizeof df1_tail, ",\"df1Sha256\":null");
    } else df1_tail[0] = '\0';

    // Second drive (Phase 3): the setting as applied and its ack. 46 at most.
    static char drive_tail[64];
    const uint8_t drive_mode_sent = c->_df1_mode;
    const uint32_t drive_ack_sent = c->drive_ack;
    if (c->_df1_capable)
        snprintf(drive_tail, sizeof drive_tail, ",\"secondDrive\":\"%s\",\"driveVersion\":%lu",
                 c->_df1_mode == DF1_MODE_NEXT ? "df1" : "off", (unsigned long)c->drive_ack);
    else drive_tail[0] = '\0';

    static char body[DC_STATUS_BODY_BYTES];
    int body_len = snprintf(body, sizeof body,
        "{\"mountedSha256\":%s,\"mountedDiskId\":%s,\"version\":%lu,"
        "\"error\":%s,\"psramFree\":%d,\"firmwareVersion\":%s,\"rssi\":%d,"
        "\"trackMaxBytes\":%u%s%s%s%s%s%s%s%s}",
        sha_field, disk_field, (unsigned long)c->mounted_version,
        err_field, psram_free, ver_field, rssi, (unsigned)TRACK_MAX_BYTES, fw_tail, nfc_tail,
        display_tail, preload_tail,
        // playsHd: only from a build with the drive-ID responder (HD spec §5.5).
        c->_plays_hd ? ",\"playsHd\":true" : "",
        sel1_tail, df1_tail, drive_tail);
    if (body_len < 0 || body_len >= (int)sizeof body) return false; // should never happen; give up quietly

    static char req[DC_STATUS_REQ_BYTES];
    int req_len = http_build_request(req, sizeof req, "POST", DC_STATUS_PATH,
                                     c->host, c->token, body);
    if (req_len < 0) return false;

    static http_resp_t r;   // static: see the STACK note above
    bool ok = dc_exchange(c, req, req_len, dc_discard_sink, NULL, &r, /*retryable=*/true);
    if (!ok || !r.body_complete) return false; // best-effort; the poll loop is what matters

    if (r.status == 401) {
        c->state = DC_HALTED; // token is dead; 401 anywhere halts
        return false;
    }
    const bool accepted = r.status >= 200 && r.status < 300;
    if (accepted && c->_sel1_known) {
        // The server has heard these readings (the body carried them).
        c->_sel1_sent_valid = true;
        c->_sel1_sent_wired = sel1_wired_sent;
        c->_df1_sent_seen = df1_seen_sent;
    }
    if (accepted && c->_df1_capable) {
        c->_drive_sent_valid = true;
        c->_drive_sent_mode = drive_mode_sent;
        c->_drive_sent_ack = drive_ack_sent;
    }
    return accepted;
}

#define DC_POST_HEAD_BYTES 512

// Write-back (piece 2b; see device_client.h). Shares dc_exchange like every
// other request in this file, but builds the request with http_build_head
// (Task 2) plus a raw memcpy of `body` rather than http_build_request's
// C-string body, since a disk track is full of NUL bytes. Called from
// up_step (uploader.c, a later task), never from inside dc_step -- see the
// STACK note's call graph above.
int dc_post(device_client_t *c, const char *path, const char *content_type,
            const uint8_t *body, int body_len, char *resp, int resp_cap) {
    if (body_len < 0 || body_len > DC_POST_BODY_MAX) return -1;
    // static: see the STACK note above. One head + one HD track, ~11.8 KB.
    static char req[DC_POST_HEAD_BYTES + DC_POST_BODY_MAX];
    int n = http_build_head(req, DC_POST_HEAD_BYTES, "POST", path, c->host, c->token,
                            content_type, body_len);
    if (n < 0) return -1;
    if (body_len) memcpy(req + n, body, (size_t)body_len);

    static dc_body_buf_t out;
    out.len = 0; out.truncated = false; out.buf[0] = '\0';
    static http_resp_t r;
    bool ok = dc_exchange(c, req, n + body_len, dc_body_sink, &out, &r, /*retryable=*/true);
    if (resp && resp_cap > 0) snprintf(resp, (size_t)resp_cap, "%s", out.buf);
    if (!ok || !r.body_complete) return -1;
    if (r.status == 401) c->state = DC_HALTED;    // 401 anywhere halts
    return r.status;
}

int dc_fetch_firmware(device_client_t *c, const char *version,
                      void (*sink)(void *ctx, const uint8_t *b, int n), void *ctx) {
    static char path[DC_REQ_BUF_BYTES];   // static: see the STACK note above
    int pn = snprintf(path, sizeof path, "/api/device/firmware/%s", version);
    if (pn < 0 || pn >= (int)sizeof path) return -1;
    static char req[DC_REQ_BUF_BYTES];
    int req_len = http_build_request(req, sizeof req, "GET", path, c->host, c->token, NULL);
    if (req_len < 0) return -1;
    static http_resp_t r;
    bool ok = dc_exchange(c, req, req_len, sink, ctx, &r, /*retryable=*/true);
    const int status = (!ok || !r.body_complete) ? -1 : r.status;
    if (status == 401) c->state = DC_HALTED;   // 401 anywhere halts
    if (status != 200) {
        // Once per call, whatever failed. fw_update.c retries -1 and 5xx with
        // backoff for minutes, and until this line nothing said which part of
        // the exchange it was retrying. static: see the STACK note above.
        static char how[72], got[72];
        dc_xfer_describe(&c->last_xfer, how, sizeof how, got, sizeof got);
        wf_logf(WF_WARN, "fw: dl %d: %s", status, how);
        wf_logf(WF_WARN, "fw: %s", got);
    }
    return status;
}

// --- OLED layouts (spec 2026-10-04 §6) -------------------------------------

typedef struct { uint8_t *buf; int cap; int len; } dc_bytes_sink_t;

// Keeps the first `cap` bytes and drops the rest: a body longer than any
// legal one is cut, and dc_display_parse refuses the result -- so an
// over-long answer reads as a rejected layout, never as a buffer overrun.
static void dc_bytes_sink(void *ctx, const uint8_t *b, int n) {
    dc_bytes_sink_t *s = ctx;
    if (n <= 0) return;
    int space = s->cap - s->len;
    int take = n < space ? n : space;
    if (take <= 0) return;
    memcpy(s->buf + s->len, b, (size_t)take);
    s->len += take;
}

int dc_fetch_display(device_client_t *c, uint8_t *buf, int cap) {
    if (!buf || cap <= 0) return -1;
    static char req[DC_REQ_BUF_BYTES];   // static: see the STACK note above
    int req_len = http_build_request(req, sizeof req, "GET", "/api/device/display",
                                     c->host, c->token, NULL);
    if (req_len < 0) return -1;
    dc_bytes_sink_t s = { buf, cap, 0 };
    static http_resp_t r;
    bool ok = dc_exchange(c, req, req_len, dc_bytes_sink, &s, &r, /*retryable=*/true);
    if (!ok || !r.body_complete) return -1;
    if (r.status == 401) { c->state = DC_HALTED; return -1; }   // 401 anywhere halts
    if (r.status != 200) return -1;
    return s.len;
}

bool dc_display_owed(const device_client_t *c) {
    return c->display_want > c->display_ack;
}

bool dc_display_take_reset_to_default(device_client_t *c) {
    const bool r = c->display_reset_to_default;
    c->display_reset_to_default = false;
    return r;
}

bool dc_display_parse(const uint8_t *buf, int n, uint32_t *version, uint8_t *panel,
                      const uint8_t **blob, int *blob_len) {
    if (!buf || n < 6) return false;
    if (buf[4] > PANEL_128x64) return false;
    if (buf[5] > 1) return false;
    const int bl = n - 6;
    if (buf[5] == 1 && (bl < 1 || bl > LAYOUT_BLOB_MAX)) return false;
    if (buf[5] == 0 && bl != 0) return false;
    *version  = ((uint32_t)buf[0] << 24) | ((uint32_t)buf[1] << 16) |
                ((uint32_t)buf[2] << 8)  |  (uint32_t)buf[3];
    *panel    = buf[4];
    *blob     = bl ? buf + 6 : NULL;
    *blob_len = bl;
    return true;
}

void dc_display_handled(device_client_t *c, uint32_t version, const char *error) {
    c->display_ack = version;
    snprintf(c->display_error, sizeof c->display_error, "%s", error ? error : "");
}

dc_display_action_t dc_display_decide(const device_client_t *c, const uint8_t *buf, int n,
                                      dc_display_verdict_t *out) {
    memset(out, 0, sizeof *out);
    if (n < 0) return DC_DISP_RETRY;
    if (!dc_display_parse(buf, n, &out->version, &out->panel, &out->blob, &out->blob_len)) {
        out->version = c->display_want;
        out->blob = NULL; out->blob_len = 0;
        snprintf(out->why, sizeof out->why, "malformed display body");
        return DC_DISP_MALFORMED;
    }
    // Stale: acking it would move the cursor BACKWARDS past what the poll
    // named, and applying it would put an older layout on the glass.
    if (out->version < c->display_want) return DC_DISP_RETRY;
    if (out->blob_len > 0) {
        if (!layout_decode(out->blob, (size_t)out->blob_len, &out->layout, out->why, sizeof out->why))
            return DC_DISP_REJECT;
        if (out->layout.panel != (panel_t)out->panel) {
            snprintf(out->why, sizeof out->why, "panel mismatch");
            return DC_DISP_REJECT;
        }
    }
    return DC_DISP_APPLY;
}

static dc_state_t dc_step_inner(device_client_t *c);

// DF1 follows the preload record after every step, whatever path it took
// (a swap, an eject, a fetch that dropped the record). A wrapper, so no return
// path inside can skip it.
dc_state_t dc_step(device_client_t *c) {
    c->df1_deferred = false;          // describes THIS step only
    dc_state_t s = dc_step_inner(c);
    dc_df1_reconcile(c);
    return s;
}

static dc_state_t dc_step_inner(device_client_t *c) {
    // Describes THIS step only: cleared before any return below.
    c->poll_interrupted = false;
    c->_was_held = c->held;
    c->held = false;
    if (c->state == DC_UNPROVISIONED) {
        // No token yet; Task 10 adds dc_register() to get one. Nothing to
        // poll with in the meantime.
        return c->state;
    }
    if (c->state == DC_HALTED) {
        // Spec §4.2: "401 anywhere -- the token is dead. Stop." Once
        // halted, repeating the same request against a dead token on every
        // call would just hammer the server for no benefit; the mounted
        // disk is untouched and stays that way. 4b's re-provisioning path
        // is what gets a device out of this state.
        return c->state;
    }

    // static: see the STACK note above.
    // Worst case
    // "/api/device/poll?since=4294967295&nfcAck=4294967295&displayAck=4294967295"
    // is 73 (51 before displayAck); &driveAck=4294967295 makes it 93.
    // test_poll_url_carries_display_ack / _drive_ack send them.
    static char path[128];
    int plen = snprintf(path, sizeof path, "/api/device/poll?since=%lu&nfcAck=%lu&displayAck=%lu",
             (unsigned long)c->since, (unsigned long)c->nfc_ack, (unsigned long)c->display_ack);
    if (c->_df1_capable && plen > 0 && plen < (int)sizeof path)
        snprintf(path + plen, sizeof path - (size_t)plen, "&driveAck=%lu", (unsigned long)c->drive_ack);

    static char req[DC_REQ_BUF_BYTES];
    int req_len = http_build_request(req, sizeof req, "GET", path, c->host, c->token, NULL);
    if (req_len < 0) return dc_enter_backoff(c); // unexpected: since is bounded, host is fixed

    static dc_body_buf_t body;
    body.len = 0;
    body.truncated = false;
    body.buf[0] = '\0';
    static http_resp_t r;
    // The poll-interrupt is on the transport for this one exchange and no
    // other: set just before, cleared just after, whatever happened.
    c->t->interrupted = c->_poll_intr;
    c->t->interrupt_ctx = c->_poll_intr_ctx;
    bool interrupted = false;
    bool ok = dc_exchange_i(c, req, req_len, dc_body_sink, &body, &r, /*retryable=*/true,
                            &interrupted);
    c->t->interrupted = NULL;
    c->t->interrupt_ctx = NULL;

    if (interrupted) {
        // The caller wanted core1 back (a tag was tapped -- spec 2026-09-25
        // §4.2 -- or a write landed, HANDOFF 3av). Nothing failed, so no backoff: a backoff here would delay
        // the very poll that picks up the tap's new disk. dc_exchange_i has
        // abandoned the connection; state, since and backoff_ms are exactly
        // as they were on entry -- so the return value below may well be
        // DC_BACKOFF, and is NOT a result. The caller checks poll_interrupted
        // first and skips its backoff sleep (device_client.h).
        c->poll_interrupted = true;
        c->held = c->_was_held;   // decided nothing: the hold is as it was
        return c->state;
    }

    if (!ok || !r.body_complete) {
        // Transport/framing failure, or a connection dropped before the
        // body finished (204 always completes immediately in http.c, so
        // this only ever bites 200 and the error statuses below). An
        // incomplete response names nothing reliably -- never destructive.
        return dc_enter_backoff(c);
    }

    switch (r.status) {
    case 204: // long-poll timed out server-side with nothing new to say
        // The only status that is productive without changing anything: the
        // server held the connection for its full 25s, so the loop is
        // already self-throttling and there is nothing to back off from.
        dc_backoff_reset(c);
        c->state = DC_IDLE_POLL;
        return c->state;

    case 401:
        c->state = DC_HALTED;
        return c->state;

    case 404: {
        // Review round 3, NEW Important: a bare 404 status is NOT proof
        // the device row is gone -- it is exactly what an
        // infrastructure-level mistake (a bad deploy, a renamed route, a
        // proxy misroute) looks like too, and those are indistinguishable
        // from a deleted row at the transport level. Before this
        // distinction existed that ambiguity was harmless: DC_HALTED left
        // the token alone, and a board resumed on its own once the server
        // came back healthy. It stopped being harmless the moment
        // DC_HALTED started meaning "erase the token" (main.c's
        // DC_HALTED handling, task 7) -- misreading a transient 404 as
        // "device deleted" would now erase every deployed board's token
        // from one bad deploy, turning a server-side mistake into a
        // fleet-wide outage that needs a human to re-pair each board.
        //
        // Only the server's own explicit body
        // (src/app/api/device/poll/route.ts: {"error":"device_not_found"})
        // means the row is actually gone. `body` is already fully buffered
        // here (the !ok/!body_complete check above already returned), so
        // this costs nothing extra to check. `body.truncated` is excluded
        // from trusting the parse for the same reason dc_register()
        // excludes it: a body that didn't fully arrive is not a body
        // worth reading a verdict out of, in either direction.
        char err[32];
        if (!body.truncated && json_str(body.buf, "error", err, sizeof err) &&
            strcmp(err, "device_not_found") == 0) {
            // The device row is gone from the server -- an absence of
            // signal. Keep the disk mounted (touch nothing) and stop
            // polling.
            c->state = DC_HALTED;
            return c->state;
        }
        // Any other 404 body (or none) is a transient/infra fault, not a
        // deletion -- stays exactly as retryable as any other unexpected
        // status.
        return dc_enter_backoff(c);
    }

    case 200:
        // NOT an unconditional dc_backoff_reset() -- see Important 2. A 200
        // is answered the instant `version > since`, so a 200 the device
        // cannot act on (blocked digest, unfetchable image) is exactly the
        // response that can arrive back-to-back without pause. Only
        // dc_handle_poll_body's genuinely productive exits reset the
        // backoff; the rest fall into dc_enter_backoff, which is what puts
        // a floor under the retry rate. dc_backoff_reset here would have
        // pinned that floor at DC_BACKOFF_FLOOR_MS instead of letting it
        // grow.
        if (body.truncated) {
            // A poll body too long for DC_POLL_BODY_BYTES: `writeProtected`
            // is emitted last by readDesired(), so what got cut is exactly
            // the field whose absence fails open the day write-back lands.
            // Refuse to act on a partial instruction at all -- the same
            // "touch nothing" resolution every other malformed response
            // takes -- rather than parsing whatever prefix arrived.
            return dc_enter_backoff(c);
        }
        dc_take_second_drive(c, body.buf);   // lifted and BLANKED first: its keys must never shadow ours
        dc_take_fw_fields(c, body.buf);
        dc_take_nfc_write(c, body.buf);
        dc_take_next(c, body.buf);
        return dc_handle_poll_body(c, body.buf);

    default:
        // Any other/unlisted status: transient, never destructive.
        return dc_enter_backoff(c);
    }
}

// --- NFC tap-to-mount (spec 2026-09-25) -----------------------------------

void dc_set_poll_interrupt(device_client_t *c, bool (*fn)(void *ctx), void *ctx) {
    c->_poll_intr = fn;
    c->_poll_intr_ctx = ctx;
}

void dc_set_nfc_reader(device_client_t *c, const char *state) {
    // Copied, not kept as a pointer: two fixed words, and a copy cannot
    // dangle. Anything else is omitted -- the server's enum has no third
    // value, so sending one would only be dropped there.
    if (state && (strcmp(state, "present") == 0 || strcmp(state, "absent") == 0)) {
        snprintf(c->_nfc_reader, sizeof c->_nfc_reader, "%s", state);
    } else {
        c->_nfc_reader[0] = '\0';
    }
}

void dc_set_plays_hd(device_client_t *c, bool on) {
    c->_plays_hd = on;
}

void dc_set_sel1(device_client_t *c, bool wired, bool df1_seen) {
    c->_sel1_known = true;
    c->_sel1_wired = wired;
    c->_df1_seen = df1_seen;
}

bool dc_sel1_owed(const device_client_t *c) {
    return c->_sel1_known &&
           (!c->_sel1_sent_valid || c->_sel1_sent_wired != c->_sel1_wired ||
            c->_df1_sent_seen != c->_df1_seen);
}

#define DC_TAP_PATH       "/api/device/tap"
#define DC_TAP_WRITE_PATH "/api/device/tap-write"
#define DC_JSON           "application/json"

dc_tap_outcome_t dc_tap(device_client_t *c, const char *disk_id, char *title_out, int title_cap) {
    if (title_out && title_cap > 0) title_out[0] = '\0';
    // The tag codec already checked the shape; checked again because this is
    // what goes into hand-built JSON unescaped, and the server would answer
    // anything else with a 400 regardless.
    if (!disk_id || !nfc_disk_id_valid(disk_id)) return DC_TAP_FAILED;

    static char body[64];   // static: see the STACK note above
    int n = snprintf(body, sizeof body, "{\"diskId\":\"%s\"}", disk_id);
    if (n < 0 || n >= (int)sizeof body) return DC_TAP_FAILED;

    // The title is an unbounded games.title server-side, so this can clip
    // it -- harmless: `outcome` is emitted first (src/lib/nfc/store.ts), and
    // the title is clipped to the caller's buffer anyway.
    static char resp[256];
    int st = dc_post(c, DC_TAP_PATH, DC_JSON, (const uint8_t *)body, n, resp, sizeof resp);
    // -1 (offline, incomplete), 400 invalid_body, 401 (dc_post halted), 5xx:
    // all "no answer" as far as the person at the reader is concerned.
    if (st < 200 || st >= 300) return DC_TAP_FAILED;

    char outcome[16];
    if (!json_str(resp, "outcome", outcome, sizeof outcome)) return DC_TAP_FAILED;
    dc_tap_outcome_t o;
    if      (strcmp(outcome, "mounting")  == 0) o = DC_TAP_MOUNTING;
    else if (strcmp(outcome, "already")   == 0) o = DC_TAP_ALREADY;
    else if (strcmp(outcome, "not_found") == 0) o = DC_TAP_NOT_FOUND;
    else if (strcmp(outcome, "too_long")  == 0) o = DC_TAP_TOO_LONG;
    else if (strcmp(outcome, "ignored")   == 0) o = DC_TAP_IGNORED;
    else return DC_TAP_FAILED;   // a word this build does not know is not a verdict
    if (title_out && title_cap > 0) json_str(resp, "title", title_out, title_cap);
    return o;
}

bool dc_tap_write_report(device_client_t *c, uint32_t seq, bool ok, const char *uid_hex,
                         const char *why) {
    // Escaped into buffers one byte over the server's bounds (uid <= 32,
    // reason <= 64): dc_json_escape stops before an escape sequence would
    // overflow, so what arrives decodes to at most those lengths, and a long
    // reason is clipped here instead of turning the whole report into a 400.
    static char uid_esc[33], why_esc[65];   // static: see the STACK note above
    dc_json_escape(uid_esc, sizeof uid_esc, uid_hex ? uid_hex : "");
    static char reason[80];
    reason[0] = '\0';
    if (!ok && why) {
        dc_json_escape(why_esc, sizeof why_esc, why);
        snprintf(reason, sizeof reason, ",\"reason\":\"%s\"", why_esc);
    }
    static char body[192];
    int n = snprintf(body, sizeof body, "{\"seq\":%lu,\"ok\":%s,\"uid\":\"%s\"%s}",
                     (unsigned long)seq, ok ? "true" : "false", uid_esc, reason);
    if (n < 0 || n >= (int)sizeof body) return false;
    int st = dc_post(c, DC_TAP_WRITE_PATH, DC_JSON, (const uint8_t *)body, n, NULL, 0);
    return st >= 200 && st < 300;
}

// Multi-disk §4.2: the Next-disk card. The server decides what "next" is (the
// same rule its poll `next` uses), so the board sends only the intent.
dc_tap_outcome_t dc_tap_next(device_client_t *c, uint32_t *disk_no, uint32_t *disk_count,
                             char *title_out, int title_cap) {
    if (title_out && title_cap > 0) title_out[0] = '\0';
    if (disk_no) *disk_no = 0;
    if (disk_count) *disk_count = 0;

    static const char body[] = "{\"action\":\"next\"}";
    static char resp[256];   // static: see the STACK note above
    int st = dc_post(c, DC_TAP_PATH, DC_JSON, (const uint8_t *)body, (int)sizeof body - 1,
                     resp, sizeof resp);
    if (st < 200 || st >= 300) return DC_TAP_FAILED;

    char outcome[20];
    if (!json_str(resp, "outcome", outcome, sizeof outcome)) return DC_TAP_FAILED;
    dc_tap_outcome_t o;
    if      (strcmp(outcome, "mounting")        == 0) o = DC_TAP_MOUNTING;
    else if (strcmp(outcome, "single")          == 0) o = DC_TAP_SINGLE;
    else if (strcmp(outcome, "nothing_mounted") == 0) o = DC_TAP_NO_DISK;
    else if (strcmp(outcome, "already")         == 0) o = DC_TAP_ALREADY;
    else if (strcmp(outcome, "not_found")       == 0) o = DC_TAP_NOT_FOUND;
    else if (strcmp(outcome, "too_long")        == 0) o = DC_TAP_TOO_LONG;
    else if (strcmp(outcome, "ignored")         == 0) o = DC_TAP_IGNORED;
    else return DC_TAP_FAILED;   // a word this build does not know is not a verdict
    if (disk_no) json_u32(resp, "diskNo", disk_no);
    if (disk_count) json_u32(resp, "diskCount", disk_count);
    if (title_out && title_cap > 0) json_str(resp, "title", title_out, title_cap);
    return o;
}

void dc_set_preload_gate(device_client_t *c, bool (*fn)(void *ctx), void *ctx) {
    c->_preload_ok = fn;
    c->_preload_ok_ctx = ctx;
}

// Multi-disk §4.3. The same fetch as a swap (dc_fetch_into), minus the
// publish: rule 2 is untouched because the active slot is never referenced,
// and rule 1 because nothing here changes what is mounted. The gate is asked
// LAST, after every cheap check, and nothing is written before it says yes.
static bool dc_preload_step_inner(device_client_t *c);

// As dc_step: DF1 is reconciled on every return -- a verified preload is
// inserted, a dropped one stays ejected.
bool dc_preload_step(device_client_t *c) {
    c->df1_deferred = false;          // describes THIS step only
    bool did = dc_preload_step_inner(c);
    dc_df1_reconcile(c);
    return did;
}

static bool dc_preload_step_inner(device_client_t *c) {
    dc_preload_t *p = &c->preload;
    // Describes THIS step only (dc_step's poll_interrupted rule).
    p->interrupted = false;
    if (c->state != DC_IDLE_POLL) return false;
    // Final review m4: a forced refetch means the server's copy must be
    // fetched afresh on the next poll; nothing is preloaded meanwhile.
    if (c->_refetch) return false;
    if (p->next_sha256[0] == '\0') return false;
    if (strcmp(p->next_sha256, c->mounted_sha256) == 0) return false;
    if (p->slot != SLOT_NONE && p->slot == psram_inactive_slot() &&
        strcmp(p->sha256, p->next_sha256) == 0) return false;   // already there
    if (dc_digest_is_blocked(c, p->next_sha256)) return false;
    if (!c->_preload_ok || !c->_preload_ok(c->_preload_ok_ctx)) return false;
    // DF1 (Task 15): the idle slot may be what DF1 serves. Eject and wait for
    // core0 before anything is dropped or written; false = nothing happened,
    // try on a later pass. The record is kept: it is what the status report
    // still truthfully says the slot holds.
    if (!dc_df1_release(c, psram_inactive_slot())) return false;

    // From here the idle slot is being overwritten: no record survives it.
    if (p->slot != SLOT_NONE) p->changed = true;   // the server was told "ready"
    dc_preload_drop(c);
    p->loading = true;
    int target = psram_inactive_slot();
    // A copy: dc_fetch_into reads it for the whole transfer, and the log below
    // must name what was fetched even if something ever changes next_sha256.
    char sha[65];
    snprintf(sha, sizeof sha, "%s", p->next_sha256);
    wf_logf(WF_INFO, "preload: %.12s -> slot %d", sha, target);
    int status = 0;
    dc_fetch_result_t res = dc_fetch_into(c, sha, target, /*observe=*/false,
                                          /*interruptible=*/true, &status);
    p->loading = false;

    switch (res) {
    case DC_FETCH_INTERRUPTED:
        // Final review I1: a tap is waiting. Nothing failed, so no backoff
        // (that would hold the tap's own poll up to 60 s), and nothing was
        // verified, so no record. The state is what it was on entry
        // (dc_fetch_into moved it to DC_FETCHING). False: no result for the
        // caller to act on -- it rounds to the top and sends the tap; a later
        // idle pass preloads again.
        p->interrupted = true;
        c->state = DC_IDLE_POLL;
        return false;
    case DC_FETCH_OK:
        p->slot = target;
        p->changed = true;
        snprintf(p->sha256, sizeof p->sha256, "%s", sha);
        wf_logf(WF_INFO, "preload: %.12s verified in slot %d", sha, target);
        c->state = DC_IDLE_POLL;
        return true;
    case DC_FETCH_INVALID:
        wf_logf(WF_WARN, "preload: %.12s is not a valid WFMF or WFAD container -- digest blocked", sha);
        dc_block_digest(c, sha);
        dc_enter_backoff(c);
        return true;
    case DC_FETCH_STATUS:
        if (status == 401) { c->state = DC_HALTED; return true; }   // 401 anywhere halts
        if (status == 400 || status == 404 || status == 422) {
            wf_logf(WF_WARN, "preload: server said %d -- digest blocked, not retried", status);
            dc_block_digest(c, sha);
        }
        dc_enter_backoff(c);
        return true;
    case DC_FETCH_NO_REQUEST:
    case DC_FETCH_INCOMPLETE:
    default:
        // No record, and the existing backoff paces the retry (spec §4.3: no
        // retry storm). The next poll that finds the client idle tries again.
        dc_enter_backoff(c);
        return true;
    }
}
