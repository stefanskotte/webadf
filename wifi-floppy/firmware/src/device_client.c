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
#include "http.h"
#include "json_scan.h"
#include "psram_image.h"
#include <string.h>
#include <stdio.h>

// Generous for a GET line plus Host/Authorization headers to either the
// poll or the image endpoint (the sha256 in the image path is 64 hex
// chars); nowhere near HTTP_MAX_BODY_BYTES.
#define DC_REQ_BUF_BYTES  256
// The poll body is a small, fixed-shape JSON object; even a long "game"
// title leaves this with headroom. Not sized for the image body -- that
// one is never buffered here at all (see dc_discard_sink).
#define DC_POLL_BODY_BYTES 768
#define DC_READ_CHUNK_BYTES 512

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

typedef struct {
    char buf[DC_POLL_BODY_BYTES];
    int  len;
} dc_body_buf_t;

static void dc_body_sink(void *ctx, const uint8_t *b, int n) {
    dc_body_buf_t *body = ctx;
    int space = (int)sizeof(body->buf) - 1 - body->len;
    if (space <= 0 || n <= 0) return;
    int take = n < space ? n : space;
    memcpy(body->buf + body->len, b, (size_t)take);
    body->len += take;
    body->buf[body->len] = '\0';
}

// The image body's bytes are still not routed anywhere here: PSRAM now has
// a real fetch-target slot (Task 8's psram_inactive_slot()), but wiring
// this sink into image_loader.c's image_parse_buffer() so the bytes
// actually land in it is Task 10's job (it also gives core1 the real
// network-driven caller). What this layer checks -- and has always
// checked, before or after Task 8 -- is only whether the full body
// arrived; dc_fetch_image below is what turns that into a publish-or-not
// decision for the slot.
static void dc_discard_sink(void *ctx, const uint8_t *b, int n) {
    (void)ctx; (void)b; (void)n;
}

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
    uint8_t buf[DC_READ_CHUNK_BYTES];
    for (;;) {
        int got = c->t->read(c->t, buf, sizeof buf, (int)DC_POLL_TIMEOUT_MS);
        if (got < 0) { c->t->close(c->t); return false; } // error or timeout
        if (got == 0) break;                              // clean close
        if (!http_resp_feed(r, buf, got, sink, sink_ctx)) {
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
                                   const char *sha256, const char *disk_id) {
    c->since = version;
    c->mounted_version = version;
    strncpy(c->mounted_sha256, sha256, sizeof(c->mounted_sha256) - 1);
    c->mounted_sha256[sizeof(c->mounted_sha256) - 1] = '\0';
    strncpy(c->mounted_disk_id, disk_id, sizeof(c->mounted_disk_id) - 1);
    c->mounted_disk_id[sizeof(c->mounted_disk_id) - 1] = '\0';
}

// Fetches `d->sha256` from the image endpoint. Only reached once the poll
// has named a digest that is neither already mounted nor already known
// bad. On any failure -- transport-level, or a dropped/incomplete body --
// this touches nothing: rule 2 (never release the current disk before the
// replacement is fetched *and* verified) means an incomplete fetch is not
// a partial success, it is simply not a swap.
static dc_state_t dc_fetch_image(device_client_t *c, const dc_desired_t *d) {
    char path[DC_REQ_BUF_BYTES];
    snprintf(path, sizeof path, "/api/device/image/%s", d->sha256);

    char req[DC_REQ_BUF_BYTES];
    int req_len = http_build_request(req, sizeof req, "GET", path, c->host, c->token, NULL);
    if (req_len < 0) return dc_enter_backoff(c); // path too long: unexpected, treat as transient

    // Task 8: a fetch always targets the slot that is NOT the one core0 is
    // currently streaming from -- psram_inactive_slot() -- and that target
    // is reset up front so stale data from an earlier aborted fetch can
    // never be mistaken for this one. Nothing below this line may touch
    // the active slot except the single psram_publish_slot() call in the
    // 200 case, and only after the body is known to have arrived whole:
    // that ordering is rule 2 (never release the current disk before the
    // replacement is fetched *and* verified) made concrete.
    int target = psram_inactive_slot();
    psram_image_reset_slot(target);

    c->state = DC_FETCHING;
    http_resp_t r;
    bool ok = dc_exchange(c, req, req_len, dc_discard_sink, NULL, &r);

    if (!ok || !r.body_complete) {
        // Connect/write/read failure, a response that never parsed as HTTP
        // at all, or a connection dropped before the body finished -- all
        // treated alike. Never block the digest for these: none of them
        // tell us anything reliable about the digest itself, and it may be
        // perfectly fetchable next time. `target` is left reset/empty and
        // the active slot was never referenced above, so psram_active_slot()
        // is exactly what it was on entry -- the Amiga keeps the disk it had.
        return dc_enter_backoff(c);
    }

    switch (r.status) {
    case 200:
        // Task 6/10 route the actual track bytes into `target` (via
        // image_loader.c's image_parse_buffer(), wired to the network by
        // Task 10); "the whole body arrived intact" (already required
        // above, in the `!ok || !r.body_complete` check) is the
        // verification this layer does today -- that is DC_VERIFYING,
        // and it has already happened by the time control reaches here,
        // so there is no separate state to hold for it. DC_SWAPPING is
        // the moment right here: the single word-aligned store
        // psram_publish_slot() makes -- see its comment in psram_image.c
        // for why moving between two complete, verified images that way
        // can never show core0 a half-fetched one.
        c->state = DC_SWAPPING;
        psram_publish_slot(target);
        dc_complete_transition(c, d->version, d->sha256, d->disk_id);
        c->state = DC_IDLE_POLL;
        dc_backoff_reset(c);
        return c->state;

    case 400: // malformed digest: will not become valid by resending
    case 404: // not entitled / no longer exists
    case 422: // permanently unencodable
        // Never retry this exact digest, but keep polling -- the desired
        // state may change to something fetchable (spec §4.2).
        dc_block_digest(c, d->sha256);
        c->state = DC_IDLE_POLL;
        return c->state;

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
        dc_complete_transition(c, version, "", "");
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
        dc_complete_transition(c, version, d.sha256, d.disk_id);
        c->state = DC_IDLE_POLL;
        return c->state;
    }

    if (dc_digest_is_blocked(c, d.sha256)) {
        // Known unfetchable; keep polling without retrying it.
        c->state = DC_IDLE_POLL;
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

    char sha_field[80];
    snprintf(sha_field, sizeof sha_field, mounted ? "\"%s\"" : "null", c->mounted_sha256);

    char disk_field[80];
    snprintf(disk_field, sizeof disk_field, mounted ? "\"%s\"" : "null", c->mounted_disk_id);

    char err_field[DC_STATUS_ERR_BYTES + 2];
    if (err) {
        char esc[DC_STATUS_ERR_BYTES];
        dc_json_escape(esc, sizeof esc, err);
        snprintf(err_field, sizeof err_field, "\"%s\"", esc);
    } else {
        snprintf(err_field, sizeof err_field, "null");
    }

    char body[DC_STATUS_BODY_BYTES];
    int body_len = snprintf(body, sizeof body,
        "{\"mountedSha256\":%s,\"mountedDiskId\":%s,\"version\":%lu,"
        "\"error\":%s,\"psramFree\":%d,\"rssi\":%d}",
        sha_field, disk_field, (unsigned long)c->mounted_version,
        err_field, psram_free, rssi);
    if (body_len < 0 || body_len >= (int)sizeof body) return; // should never happen; give up quietly

    char req[DC_STATUS_REQ_BYTES];
    int req_len = http_build_request(req, sizeof req, "POST", DC_STATUS_PATH,
                                     c->host, c->token, body);
    if (req_len < 0) return;

    http_resp_t r;
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

    char path[64];
    snprintf(path, sizeof path, "/api/device/poll?since=%lu", (unsigned long)c->since);

    char req[DC_REQ_BUF_BYTES];
    int req_len = http_build_request(req, sizeof req, "GET", path, c->host, c->token, NULL);
    if (req_len < 0) return dc_enter_backoff(c); // unexpected: since is bounded, host is fixed

    dc_body_buf_t body = { .len = 0 };
    body.buf[0] = '\0';
    http_resp_t r;
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
        dc_backoff_reset(c);
        c->state = DC_IDLE_POLL;
        return c->state;

    case 401:
        c->state = DC_HALTED;
        return c->state;

    case 404:
        // The device row is gone from the server -- an absence of signal.
        // Keep the disk mounted (touch nothing) and stop polling.
        c->state = DC_HALTED;
        return c->state;

    case 200:
        dc_backoff_reset(c);
        return dc_handle_poll_body(c, body.buf);

    default:
        // Any other/unlisted status: transient, never destructive.
        return dc_enter_backoff(c);
    }
}
