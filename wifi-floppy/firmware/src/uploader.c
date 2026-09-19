// Write-back piece 2b, Task 5 -- see uploader.h for the spec references and
// the one-request-at-a-time argument.
//
// RULE: this file may not include any pico-sdk or lwIP header -- only C
// standard headers and the project's own pure headers (uploader.h already
// carries that same rule for device_client.h/psram_image.h) -- so it stays
// host-testable.
//
// STACK: core1's stack is 2 KB, shared with the whole mbedTLS handshake
// (see device_client.c's STACK note, which this file is bound by too, since
// it runs on the same core in the same call chain: core1_main -> up_step ->
// dc_post -> dc_exchange). Every buffer over ~64 bytes below is `static`
// for that reason. It is sound here for the identical argument
// device_client.c gives: up_step() has exactly one caller (core1_main's
// loop), it is never re-entered (up_send_track calls dc_post but nothing
// that calls back into up_step or up_send_track), and it owns its own
// statics rather than sharing device_client.c's.
#include "uploader.h"
#include "mfm.h"
#include "json_scan.h"
#include "wf_log.h"
#include "sha256.h"
#include <string.h>
#include <stdio.h>

static void up_refresh(uploader_t *u) {
    device_client_t *dc = u->dc;
    if (u->parked && (dc->mounted_version != u->parked_version ||
                       strcmp(dc->mounted_sha256, u->parked_sha) != 0)) {
        u->parked = false;
    }
    if (u->force_wprot && dc->mounted_version != u->wprot_version) {
        u->force_wprot = false;
    }
}

static void up_backoff(uploader_t *u) {
    // Copied from device_client.c's dc_enter_backoff() formula -- NOT
    // called, since that function also mutates the device client's own
    // state (c->backoff_ms, c->state), which has nothing to do with this
    // uploader's retry timer. Floor, doubling, cap; jitter from the
    // injected clock so tests stay deterministic; capped again after
    // jitter is added.
    uint32_t next = (u->backoff_ms == 0) ? DC_BACKOFF_FLOOR_MS : u->backoff_ms * 2u;
    if (next > DC_BACKOFF_CAP_MS) next = DC_BACKOFF_CAP_MS;
    uint32_t jitter = u->dc->now() % 250u;
    next += jitter;
    if (next > DC_BACKOFF_CAP_MS) next = DC_BACKOFF_CAP_MS;
    u->backoff_ms = next;
    u->retry_at_ms = u->dc->now() + next;
    // Review round 1, Important: this is the ONLY place `waiting` is set.
    // up_step consults `retry_at_ms` only while it is true, and clears it
    // itself once the wait is over -- see uploader.h's comment on `waiting`
    // for why a bare "now - retry_at_ms" comparison with no such guard goes
    // wrong across a long uptime.
    u->waiting = true;
}

static void up_clear_session(uploader_t *u) {
    u->open = false;
    u->mount = 0;
    u->disk_id[0] = '\0';
    u->seq = 0;
    memset(u->sent, 0, sizeof u->sent);
}

// Every track this session got a 200 for must be re-sent under the next
// one -- a parked session is abandoned, not resumed, so nothing survives
// its own bookkeeping.
static void up_park(uploader_t *u, int slot) {
    device_client_t *dc = u->dc;
    for (int t = 0; t < NUM_TRACKS; t++) {
        if (u->sent[t / 8] & (uint8_t)(1u << (t % 8))) {
            psram_image_set_dirty(slot, t);
        }
    }
    up_clear_session(u);
    u->parked = true;
    u->parked_version = dc->mounted_version;
    snprintf(u->parked_sha, sizeof u->parked_sha, "%s", dc->mounted_sha256);
    wf_logf(WF_WARN, "upload: parked (%s) until the mount changes", u->parked_sha);
}

// The server's copy is authoritative now (write-protect flipped on under
// this session): whatever this board still holds dirty is discarded, not
// retried, and the poll is forced to fetch the server's image fresh.
static void up_server_wins(uploader_t *u, int slot) {
    device_client_t *dc = u->dc;
    psram_image_discard_dirty(slot);
    up_clear_session(u);
    dc_force_refetch(dc);
    wf_logf(WF_WARN, "upload: server image wins (%s), refetching", dc->mounted_sha256);
}

void up_init(uploader_t *u, device_client_t *dc, const char *session,
            up_counter_fn write_gen, up_counter_fn last_write_ms) {
    memset(u, 0, sizeof *u);
    u->dc = dc;
    snprintf(u->session, sizeof u->session, "%s", session);
    u->write_gen = write_gen;
    u->last_write_ms = last_write_ms;
    u->online = true;
}

bool up_pending(const uploader_t *u) {
    return u->open || psram_image_dirty_count(psram_active_slot()) > 0;
}

bool up_has_work(uploader_t *u) {
    up_refresh(u);
    device_client_t *dc = u->dc;
    if (dc->state == DC_HALTED) return false;
    if (psram_active_slot() == SLOT_NONE) return false;
    if (dc->mounted_sha256[0] == '\0') return false;
    if (u->parked) return false;
    return up_pending(u);
}

bool up_holds(void *u) {
    return up_has_work((uploader_t *)u);
}

bool up_forces_wprot(uploader_t *u) {
    up_refresh(u);
    return u->force_wprot;
}

up_sync_t up_sync(const uploader_t *u) {
    if (!up_pending(u)) return UP_SYNCED;
    return u->online ? UP_PENDING : UP_OFFLINE;
}

// Reads track `t` out of `slot`, decodes it, and returns a pointer to the
// shared static decode buffer if it came back whole (all sectors found,
// consistently numbered, matching `t`) -- NULL otherwise. Shared by
// up_send_track (one track, Task 5) and up_close's whole-image hash (Task
// 6, every track): a torn read -- core0 rewriting the track while this read
// is in progress -- must never be sent OR hashed, and both call sites
// resolve it exactly the same way, using the exact same statics, so this is
// the one place that check lives.
static uint8_t *up_read_whole_track(int slot, int t) {
    static uint8_t mfm[TRACK_MAX_BYTES];
    uint32_t bits = 0;
    psram_image_read(slot, t, mfm, &bits);

    static uint8_t trk[MFM_TRACK_DATA_BYTES];
    memset(trk, 0, sizeof trk);
    // Review (final), Critical C1: the re-entrant decoder, through core1's
    // OWN scratch. mfm_decode_track (no _r) is core0's -- its static
    // scratch is in use whenever core0 is decoding a captured write, which
    // can be exactly now. Static here for the STACK note above.
    static uint8_t scratch[MFM_DECODE_SCRATCH_BYTES];
    mfm_decode_result_t d;
    memset(&d, 0, sizeof d);
    mfm_decode_track_r(mfm, (size_t)((bits + 7u) / 8u), trk, &d, scratch);

    if (d.found != 0x7ffu || !d.track_no_consistent || d.track_no != (uint8_t)t)
        return NULL;
    return trk;
}

// Sends dirty track `t` out of `slot`, opening a session first if none is
// open yet. See uploader.h / the brief for the per-response behaviour this
// implements verbatim: what each status does to the dirty flag, the
// session, `online` and the retry timer.
static up_step_t up_send_track(uploader_t *u, int slot, int t) {
    device_client_t *dc = u->dc;

    if (!u->open) {
        // Local only -- the server opens its own session on the first
        // upload it actually sees (HANDOFF 4g).
        u->open = true;
        u->mount = dc->mounted_version;
        snprintf(u->disk_id, sizeof u->disk_id, "%s", dc->mounted_disk_id);
        u->seq = 0;
        memset(u->sent, 0, sizeof u->sent);
    }

    // Clear-then-read: a write that lands mid-upload marks it dirty again
    // and it is re-sent, rather than this upload silently winning a race
    // against core0.
    psram_image_clear_dirty(slot, t);

    uint8_t *trk = up_read_whole_track(slot, t);
    if (!trk) {
        // core0 was rewriting this track while this read was in progress --
        // a damaged track is never sent. Put the dirty flag back so it is
        // retried once the write settles.
        psram_image_set_dirty(slot, t);
        wf_logf(WF_WARN, "upload: trk %d torn, retrying", t);
        return UP_WAITING;
    }

    static char path[256];
    snprintf(path, sizeof path,
        "/api/device/write?disk=%s&mount=%lu&track=%d&session=%s&seq=%lu",
        u->disk_id, (unsigned long)u->mount, t, u->session,
        (unsigned long)(u->seq + 1u));

    static char resp[256];
    int status = dc_post(dc, path, "application/octet-stream", trk,
                         MFM_TRACK_DATA_BYTES, resp, sizeof resp);

    static char err[32];
    static char reason[32];
    err[0] = '\0';
    reason[0] = '\0';
    if (status > 0) {
        json_str(resp, "error", err, sizeof err);
        json_str(resp, "reason", reason, sizeof reason);
    }

    if (status == -1) {
        psram_image_set_dirty(slot, t);
        u->online = false;
        up_backoff(u);
        wf_logf(WF_WARN, "upload: trk %d transport failure, backing off %lu ms",
                t, (unsigned long)u->backoff_ms);
        return UP_DID_REQUEST;
    }

    if (status == 200) {
        u->online = true;
        u->backoff_ms = 0;
        u->seq++;
        u->sent[t / 8] |= (uint8_t)(1u << (t % 8));
        wf_logf(WF_INFO, "upload: trk %d seq %lu ok", t, (unsigned long)u->seq);
        return UP_DID_REQUEST;
    }

    // Every non-200 (short of the transport failure above, which has no
    // status or body to report) is logged with its status and error/reason
    // -- whatever the specific handling below does on top of this.
    wf_logf(WF_WARN, "upload: trk %d status %d error=%s reason=%s",
            t, status, err, reason);

    if (status == 409 && strcmp(err, "write_protected") == 0) {
        u->force_wprot = true;
        u->wprot_version = dc->mounted_version;
        up_server_wins(u, slot);
        return UP_DID_REQUEST;
    }

    if ((status == 409 && strcmp(err, "not_mounted") == 0) || status == 404) {
        psram_image_set_dirty(slot, t);
        up_park(u, slot);
        return UP_DID_REQUEST;
    }

    if (status == 401) {
        // dc_post already halted the device client; nothing else to do but
        // keep the write for whenever this board is re-provisioned.
        psram_image_set_dirty(slot, t);
        return UP_DID_REQUEST;
    }

    // Anything else (5xx, an unrecognised 4xx): transient. The server was
    // reachable, so this does not count as offline.
    psram_image_set_dirty(slot, t);
    u->online = true;
    up_backoff(u);
    return UP_DID_REQUEST;
}

// Closes the session: hashes the whole image the board holds (every track,
// in order, through the same torn-read check up_send_track uses) and posts
// the digest. See uploader.h / the brief for the per-response behaviour
// this implements verbatim.
static up_step_t up_close(uploader_t *u, int slot) {
    device_client_t *dc = u->dc;

    // If a write lands mid-hash, the bytes just fed to sha256_update may
    // already be stale -- caught below by re-checking write_gen() and the
    // dirty state once the loop finishes, not by trusting a single read.
    uint32_t g0 = u->write_gen();

    static sha256_t s;
    sha256_init(&s);
    for (int t = 0; t < NUM_TRACKS; t++) {
        uint8_t *trk = up_read_whole_track(slot, t);
        if (!trk) {
            // core0 is rewriting this track right now: hashing a torn read
            // would produce a digest that matches nothing. No request is
            // sent; back off and try the whole hash again later.
            wf_logf(WF_WARN, "close: trk %d unreadable", t);
            up_backoff(u);
            return UP_WAITING;
        }
        sha256_update(&s, trk, MFM_TRACK_DATA_BYTES);
    }

    if (u->write_gen() != g0 || psram_image_next_dirty(slot) >= 0) {
        // A write landed while hashing -- resend it (on a later up_step),
        // not close over a digest that no longer matches what is held.
        return UP_WAITING;
    }

    uint8_t digest[32];
    sha256_final(&s, digest);
    static char board_sha[65];
    sha256_hex(digest, board_sha);

    static char path[192];
    snprintf(path, sizeof path,
        "/api/device/write/close?disk=%s&mount=%lu&session=%s&seq=%lu&sha256=%s",
        u->disk_id, (unsigned long)u->mount, u->session,
        (unsigned long)u->seq, board_sha);

    static char resp[256];
    int status = dc_post(dc, path, NULL, NULL, 0, resp, sizeof resp);

    static char err[32];
    err[0] = '\0';
    if (status > 0) json_str(resp, "error", err, sizeof err);

    if (status == -1) {
        u->online = false;
        up_backoff(u);
        wf_logf(WF_WARN, "close: transport failure, backing off %lu ms",
                (unsigned long)u->backoff_ms);
        return UP_DID_REQUEST;
    }

    if (status == 200) {
        static char server_sha[65];
        server_sha[0] = '\0';
        json_str(resp, "sha256", server_sha, sizeof server_sha);
        bool unchanged = false;
        json_bool(resp, "unchanged", &unchanged);
        dc_adopt_image(dc, server_sha);
        wf_logf(WF_INFO, "close: %.12s%s", server_sha, unchanged ? " unchanged" : "");
        if (strcmp(server_sha, board_sha) != 0) {
            wf_logf(WF_WARN, "close: server digest %.12s differs from the board's %.12s",
                    server_sha, board_sha);
        }
        up_clear_session(u);
        u->online = true;
        u->backoff_ms = 0;
        return UP_DID_REQUEST;
    }

    wf_logf(WF_WARN, "close: status %d error=%s", status, err);

    if (status == 409 && strcmp(err, "mismatch") == 0) {
        // The server's copy wins: whatever this board holds is discarded
        // and refetched, exactly as a write_protected upload resolves.
        up_server_wins(u, slot);
        return UP_DID_REQUEST;
    }

    if (status == 409 && strcmp(err, "incomplete") == 0) {
        // The server did not see every track this session claims to have
        // sent -- resend them under the same session, above the seq the
        // server may already hold.
        for (int t = 0; t < NUM_TRACKS; t++) {
            if (u->sent[t / 8] & (uint8_t)(1u << (t % 8)))
                psram_image_set_dirty(slot, t);
        }
        return UP_DID_REQUEST;
    }

    if ((status == 409 && strcmp(err, "not_mounted") == 0) || status == 404) {
        up_park(u, slot);
        return UP_DID_REQUEST;
    }

    // 409 conflict, and anything else (5xx, an unrecognised 4xx): transient.
    // The server was reachable, so this does not count as offline; the
    // session stays open and the whole close is retried once the backoff
    // elapses.
    u->online = true;
    up_backoff(u);
    return UP_DID_REQUEST;
}

up_step_t up_step(uploader_t *u) {
    if (!up_has_work(u)) return UP_NOTHING;

    device_client_t *dc = u->dc;
    // `retry_at_ms` is only ever consulted while `waiting` is true (set by
    // up_backoff() alone), and cleared here the moment the wait it named is
    // over -- never compared against `now` again until the next backoff
    // sets both together. This is what keeps a wait that ended days ago
    // from ever being re-read as still pending, no matter how far `now` has
    // since moved: once `waiting` is false, the stale value in
    // `retry_at_ms` is simply never looked at.
    if (u->waiting) {
        uint32_t now = dc->now();
        if ((int32_t)(now - u->retry_at_ms) < 0) return UP_WAITING;
        u->waiting = false;
    }

    int slot = psram_active_slot();
    int t = psram_image_next_dirty(slot);
    if (t < 0) {
        // Session open, nothing dirty: close it once the Amiga has been
        // quiet for UP_IDLE_CLOSE_MS -- closing any sooner would risk
        // catching a burst of writes still in flight.
        if (dc->now() - u->last_write_ms() < UP_IDLE_CLOSE_MS) return UP_WAITING;
        return up_close(u, slot);
    }

    return up_send_track(u, slot, t);
}
