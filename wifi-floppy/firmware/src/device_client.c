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
#include <string.h>
#include <stdio.h>

// Generous for a GET line plus Host/Authorization headers to either the
// poll or the image endpoint (the sha256 in the image path is 64 hex
// chars); nowhere near HTTP_MAX_BODY_BYTES.
#define DC_REQ_BUF_BYTES  256
// Sized from the poll body's actual shape, not guessed. readDesired()
// (src/lib/mount.ts) emits, in this order: version, sha256 (64 hex),
// diskId, gameId, game, diskNo, diskCount, label, writeProtected. The
// fixed part -- keys, punctuation, the two 64-char-capable ids, the
// 64-hex digest and three small integers -- comes to under 400 bytes;
// everything above that is headroom for the two free-text fields (`game`,
// a title, and `label`), which are `text` columns with no length limit at
// all in the schema, so no buffer size can be *proved* sufficient here.
//
// Two things matter about the ordering: `sha256` is emitted first, so a
// truncated body still yields a plausible-looking digest, while
// `writeProtected` is emitted LAST, so it is the first field a long title
// pushes off the end. Losing it silently is only harmless while
// dc_handle_poll_body's absent-value default (true) and main.c's
// WRITE_BACK_IMPLEMENTED=0 both hold; the day write-back lands it would
// be a disk presented as writable purely because its title was long.
// So: the buffer is generous (~1.1 KB for the two free-text fields), AND
// truncation is recorded rather than silently swallowed -- dc_step
// refuses to act on a truncated body at all (see its DC_IDLE_POLL/backoff
// path), which is the same "touch nothing" resolution every other
// malformed-response case takes.
#define DC_POLL_BODY_BYTES 1536
// 512 was never under load before the image fetch: every other response on
// this device is a few hundred bytes of poll JSON. At 2 MB it means ~4,000
// read calls, each taking the lwIP lock, memcpy'ing and crediting the window.
#define DC_READ_CHUNK_BYTES 4096

// The status report is the one request this file POSTs a body with, so it
// needs a bigger request buffer than a bare GET line (DC_REQ_BUF_BYTES):
// two 64-hex-char fields, a version, an escaped error string, and two ints,
// plus the request line and headers around them.
#define DC_STATUS_PATH        "/api/device/status"
#define DC_STATUS_BODY_BYTES  512
#define DC_STATUS_REQ_BYTES   1024
// `err` is firmware-authored (a short static string or errno-derived text,
// never network input), but it still has to survive being embedded in a
// JSON string unescaped -- truncated well short of DC_STATUS_BODY_BYTES so
// there is always room left for the rest of the fields.
#define DC_STATUS_ERR_BYTES   256

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
// at dc_fetch_image's own `static` response, whose storage outlives the call.
static const http_resp_t *g_img_resp;
static uint32_t g_img_t0;   // fetch start, for the throughput line
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
    if (ctx) {
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
//   * These functions never call each other in a cycle. The only call
//     graph is  core1_main -> dc_step -> dc_handle_poll_body ->
//     dc_fetch_image -> dc_exchange,  core1_main -> dc_report_status ->
//     dc_exchange,  and  core1_main -> dc_register -> dc_exchange. Every
//     path is a straight line; dc_exchange is shared by three callers but
//     is never nested inside itself.
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
static bool dc_exchange(device_client_t *c, const char *req, int req_len,
                        void (*sink)(void *ctx, const uint8_t *b, int n),
                        void *sink_ctx, http_resp_t *r) {
    if (c->t->connect(c->t, c->host, 443) < 0) return false;

    int sent = 0;
    while (sent < req_len) {
        int w = c->t->write(c->t, (const uint8_t *)req + sent, req_len - sent);
        if (w <= 0) { c->t->close(c->t); return false; }
        sent += w;
    }

    http_resp_init(r);
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
        if (got < 0) { c->t->close(c->t); return false; } // error or timeout
        if (got == 0) break;                              // clean close
        bool fed = http_resp_feed(r, buf, got, sink, sink_ctx);
        g_ms_feed += c->now() - t_b;
        if (!fed) {
            c->t->close(c->t);
            return false; // malformed response
        }
        if (r->body_complete) break;
    }
    c->t->close(c->t);
    return true;
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
}

// Fetches `d->sha256` from the image endpoint. Only reached once the poll
// has named a digest that is neither already mounted nor already known
// bad. On any failure -- transport-level, or a dropped/incomplete body --
// this touches nothing: rule 2 (never release the current disk before the
// replacement is fetched *and* verified) means an incomplete fetch is not
// a partial success, it is simply not a swap.
static dc_state_t dc_fetch_image(device_client_t *c, const dc_desired_t *d) {
    // static: see the STACK note above.
    static char path[DC_REQ_BUF_BYTES];
    snprintf(path, sizeof path, "/api/device/image/%s", d->sha256);

    static char req[DC_REQ_BUF_BYTES];
    int req_len = http_build_request(req, sizeof req, "GET", path, c->host, c->token, NULL);
    if (req_len < 0) return dc_enter_backoff(c); // path too long: unexpected, treat as transient

    // Task 8: a fetch always targets the slot that is NOT the one core0 is
    // currently streaming from -- psram_inactive_slot(). image_parse_begin()
    // resets that slot up front (so stale data from an earlier aborted
    // fetch can never be mistaken for this one) and points the incremental
    // parser at it; dc_image_sink below feeds it body bytes straight off
    // the wire as dc_exchange's read loop hands them over -- there is no
    // SRAM buffer big enough to hold a whole image (up to ~2 MB,
    // psram_image.h) first. Nothing below this line may touch the active
    // slot except the single psram_publish_slot() call in the 200 case,
    // and only after the body is known to have arrived whole AND parsed
    // clean: that ordering is rule 2 (never release the current disk
    // before the replacement is fetched *and* verified) made concrete.
    int target = psram_inactive_slot();
    // Digests are not secret here -- /api/ingest/check is a deliberate global
    // existence oracle and TOSEC publishes thousands of them -- so a prefix is
    // safe to print and is what makes a fetch traceable against the server side.
    g_img_got = 0;
    g_img_next = 262144;
    g_img_t0 = 0;   // set by the sink on the first body byte
    wf_logf(WF_INFO, "fetch: %.12s -> slot %d (psram %s)", d->sha256, target,
            psram_image_available() ? "ok" : "MISSING");
    image_parse_begin(target);

    c->state = DC_FETCHING;
    static http_resp_t r;   // static: see the STACK note above
    g_img_resp = &r;
    c->_fetch_pct = -1;     // a fresh transfer reports 0% again
    dc_emit(c, DC_OBS_FETCH_BEGIN, 0, 0);
    bool ok = dc_exchange(c, req, req_len, dc_image_sink, c, &r);

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
    }

    switch (r.status) {
    case 200: {
        // DC_VERIFYING: image_parse_end() is "fill, then verify" -- it
        // returns true only if the parser reached a clean end-of-container
        // AND every track in it landed in PSRAM (image_loader.c). That,
        // together with "the whole body arrived intact" already checked
        // above, is the verification this layer does; there is no
        // separate state to hold for it once control reaches here.
        dc_emit(c, DC_OBS_VERIFY, (uint32_t)g_img_got, (uint32_t)g_img_got);
        if (!image_parse_end()) {
            // Content-Length matched what arrived, but the bytes
            // themselves are not a well-formed, complete WFMF container.
            // Resending the exact same bytes under this digest would fail
            // the same way every time, so this digest is treated like the
            // 400/404/422 cases below rather than backed off forever.
            wf_logf(WF_WARN, "fetch: %.12s arrived complete but is not a "
                    "valid WFMF container -- digest blocked", d->sha256);
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
        }
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
    }

    case 400: // malformed digest: will not become valid by resending
    case 404: // not entitled / no longer exists
    case 422: // permanently unencodable
        // Never retry this exact digest, but keep polling -- the desired
        // state may change to something fetchable (spec §4.2). Backed off
        // rather than returned as DC_IDLE_POLL for the same reason as the
        // parse-failure case above: `since` did not advance, so an
        // immediate re-poll is answered immediately and the loop spins.
        wf_logf(WF_WARN, "fetch: server said %d -- digest blocked, not retried",
                r.status);
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

// Acts on a fully-received 200 poll body. `json` is NUL-terminated.
static dc_state_t dc_handle_poll_body(device_client_t *c, const char *json) {
    uint32_t version = 0;
    if (!json_u32(json, "version", &version)) {
        // Can't even read the reconciliation counter: nothing here can be
        // trusted enough to act on. Treat like any other transient fault.
        return dc_enter_backoff(c);
    }

    if (json_is_null(json, "desired")) {
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

    if (c->mounted_sha256[0] != '\0' && strcmp(d.sha256, c->mounted_sha256) == 0) {
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
    static char pc_esc[80], fv_esc[32], mac_esc[32];
    dc_json_escape(pc_esc, sizeof pc_esc, pairing_code);
    dc_json_escape(fv_esc, sizeof fv_esc, firmware_version);
    dc_json_escape(mac_esc, sizeof mac_esc, mac);

    static char body[DC_REGISTER_BODY_BYTES];
    int body_len = snprintf(body, sizeof body,
        "{\"pairingCode\":\"%s\",\"firmwareVersion\":\"%s\",\"macAddress\":\"%s\"}",
        pc_esc, fv_esc, mac_esc);
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

    bool ok = dc_exchange(c, req, req_len, dc_body_sink, &resp, &r);
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
// Best-effort: a connect/write/read failure or an unexpected status here
// does not touch `backoff_ms` or `state` -- the poll loop is what keeps the
// device from looking dead (spec: "a device with a broken status path but
// a healthy poll loop still reads as recently seen"). The one exception is
// 401: the token is dead everywhere it appears, so this halts exactly as
// the poll and image endpoints do.
void dc_report_status(device_client_t *c, int psram_free, int rssi, const char *err) {
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

    static char body[DC_STATUS_BODY_BYTES];
    int body_len = snprintf(body, sizeof body,
        "{\"mountedSha256\":%s,\"mountedDiskId\":%s,\"version\":%lu,"
        "\"error\":%s,\"psramFree\":%d,\"rssi\":%d}",
        sha_field, disk_field, (unsigned long)c->mounted_version,
        err_field, psram_free, rssi);
    if (body_len < 0 || body_len >= (int)sizeof body) return; // should never happen; give up quietly

    static char req[DC_STATUS_REQ_BYTES];
    int req_len = http_build_request(req, sizeof req, "POST", DC_STATUS_PATH,
                                     c->host, c->token, body);
    if (req_len < 0) return;

    static http_resp_t r;   // static: see the STACK note above
    bool ok = dc_exchange(c, req, req_len, dc_discard_sink, NULL, &r);
    if (!ok || !r.body_complete) return; // best-effort; the poll loop is what matters

    if (r.status == 401) c->state = DC_HALTED; // token is dead; 401 anywhere halts
}

dc_state_t dc_step(device_client_t *c) {
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
    static char path[64];
    snprintf(path, sizeof path, "/api/device/poll?since=%lu", (unsigned long)c->since);

    static char req[DC_REQ_BUF_BYTES];
    int req_len = http_build_request(req, sizeof req, "GET", path, c->host, c->token, NULL);
    if (req_len < 0) return dc_enter_backoff(c); // unexpected: since is bounded, host is fixed

    static dc_body_buf_t body;
    body.len = 0;
    body.truncated = false;
    body.buf[0] = '\0';
    static http_resp_t r;
    bool ok = dc_exchange(c, req, req_len, dc_body_sink, &body, &r);

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
        return dc_handle_poll_body(c, body.buf);

    default:
        // Any other/unlisted status: transient, never destructive.
        return dc_enter_backoff(c);
    }
}
