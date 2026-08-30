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
#include <string.h>
#include <stdio.h>

// Backoff shape is finished properly in Task 7 (floor/cap constants, tested
// growth and reset, jitter). This file only needs *some* nonzero, growing,
// capped value so the image-fetch status-code tests (spec §4.2, "a 503
// should back off") have something to assert on.
#define DC_BACKOFF_INITIAL_MS 1000u
#define DC_BACKOFF_CAP_MS     60000u

// Generous for a GET line plus Host/Authorization headers to either the
// poll or the image endpoint (the sha256 in the image path is 64 hex
// chars); nowhere near HTTP_MAX_BODY_BYTES.
#define DC_REQ_BUF_BYTES  256
// The poll body is a small, fixed-shape JSON object; even a long "game"
// title leaves this with headroom. Not sized for the image body -- that
// one is never buffered here at all (see dc_discard_sink).
#define DC_POLL_BODY_BYTES 768
#define DC_READ_CHUNK_BYTES 512

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

// The image body is never buffered here: Task 6 has nowhere to put it yet
// (PSRAM slots are Task 8, wiring into image_loader is Task 10). What
// matters at this layer is only whether the full body arrived.
static void dc_discard_sink(void *ctx, const uint8_t *b, int n) {
    (void)ctx; (void)b; (void)n;
}

static dc_state_t dc_enter_backoff(device_client_t *c) {
    if (c->backoff_ms == 0) {
        c->backoff_ms = DC_BACKOFF_INITIAL_MS;
    } else {
        uint32_t doubled = c->backoff_ms * 2u;
        c->backoff_ms = (doubled > DC_BACKOFF_CAP_MS) ? DC_BACKOFF_CAP_MS : doubled;
    }
    c->state = DC_BACKOFF;
    return c->state;
}

static void dc_backoff_reset(device_client_t *c) {
    c->backoff_ms = 0;
}

// Runs one full request/response exchange over `c->t`: builds a bearer-
// authenticated GET for `path`, writes it -- looping on partial writes,
// since transport_t.write may accept fewer bytes than offered exactly as a
// real socket can under backpressure -- then reads until the response is
// fully framed or the connection closes. `sink` receives body bytes as
// http_resp_feed frames them.
//
// Returns false only for a transport- or framing-level failure (connect
// failed, a write stalled, a read errored, or the bytes seen so far don't
// parse as HTTP at all). A response that parsed a status line and then hit
// a clean close mid-body returns true with `r->body_complete` still false
// -- the caller decides what an incomplete body means for that endpoint;
// this function only reports what happened on the wire.
static bool dc_exchange(device_client_t *c, const char *path,
                        void (*sink)(void *ctx, const uint8_t *b, int n),
                        void *sink_ctx, http_resp_t *r) {
    char req[DC_REQ_BUF_BYTES];
    int n = http_build_request(req, sizeof req, "GET", path, c->host, c->token, NULL);
    if (n < 0) return false; // path too long: a firmware bug, not a network fault

    if (c->t->connect(c->t, c->host, 443) < 0) return false;

    int sent = 0;
    while (sent < n) {
        int w = c->t->write(c->t, (const uint8_t *)req + sent, n - sent);
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
                                   const char *sha256) {
    c->since = version;
    c->mounted_version = version;
    strncpy(c->mounted_sha256, sha256, sizeof(c->mounted_sha256) - 1);
    c->mounted_sha256[sizeof(c->mounted_sha256) - 1] = '\0';
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

    c->state = DC_FETCHING;
    http_resp_t r;
    bool ok = dc_exchange(c, path, dc_discard_sink, NULL, &r);

    if (!ok || !r.body_complete) {
        // Connect/write/read failure, a response that never parsed as HTTP
        // at all, or a connection dropped before the body finished -- all
        // treated alike. Never block the digest for these: none of them
        // tell us anything reliable about the digest itself, and it may be
        // perfectly fetchable next time.
        return dc_enter_backoff(c);
    }

    switch (r.status) {
    case 200:
        // Task 6 has nowhere to route the image bytes yet (PSRAM slots are
        // Task 8, the loader is wired in by Task 10) -- so "the whole body
        // arrived intact" (already required above) is as far as
        // verification goes here.
        c->state = DC_VERIFYING;
        dc_complete_transition(c, d->version, d->sha256);
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
        // the instant it is acted on.
        dc_complete_transition(c, version, "");
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
        dc_complete_transition(c, version, d.sha256);
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

    dc_body_buf_t body = { .len = 0 };
    body.buf[0] = '\0';
    http_resp_t r;
    bool ok = dc_exchange(c, path, dc_body_sink, &body, &r);

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
