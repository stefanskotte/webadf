#include "fw_update.h"
#include <stdio.h>
#include <string.h>

void fwu_init(fwu_t *u, uint8_t *stage_buf, uint32_t stage_cap) {
    memset(u, 0, sizeof *u);
    u->stage_buf = stage_buf;
    u->stage_cap = stage_cap;
    u->phase = FWU_IDLE;
}

void fwu_fail(fwu_t *u, const char *why) {
    u->phase = FWU_FAILED;
    snprintf(u->error, sizeof u->error, "%s", why);
}

void fwu_refuse(fwu_t *u, const char *why) {
    if (u->phase == FWU_APPLYING || u->phase == FWU_REBOOTING) return;   // past the point of no return
    fwu_fail(u, why);
}

void fwu_on_instruction(fwu_t *u, const fw_offer_t *offer, fw_verdict_t verdict) {
    if (u->phase == FWU_APPLYING || u->phase == FWU_REBOOTING) return;   // past the point of no return
    u->error[0] = '\0';
    if (!offer) { u->phase = FWU_IDLE; return; }                         // a cancellation
    if (verdict != FW_OK) {
        char why[FWU_ERROR_MAX + 1];
        snprintf(why, sizeof why, "refused: %s", fw_verdict_text(verdict));
        fwu_fail(u, why);
        return;
    }
    u->offer = *offer;
    u->phase = FWU_QUEUED;
    u->retry_at_ms = 0;
    u->backoff_ms = 0;
}

static void retry_later(fwu_t *u, uint32_t now) {
    u->backoff_ms = u->backoff_ms ? u->backoff_ms * 2u : FWU_RETRY_FLOOR_MS;
    if (u->backoff_ms > FWU_RETRY_CAP_MS) u->backoff_ms = FWU_RETRY_CAP_MS;
    u->retry_at_ms = now + u->backoff_ms;
    u->phase = FWU_QUEUED;
}

bool fwu_step(fwu_t *u, const fwu_ops_t *ops, fw_state_t *st, bool idle, uint32_t now) {
    switch (u->phase) {
    case FWU_QUEUED:
        if (u->retry_at_ms && (int32_t)(now - u->retry_at_ms) < 0) return false;
        u->phase = FWU_DOWNLOADING;          // reported before the (blocking) fetch
        return true;
    case FWU_DOWNLOADING: {
        fw_stage_begin(&u->stage, u->stage_buf, u->stage_cap);
        int status = ops->fetch(ops->ctx, u->offer.version, &u->stage);
        if (status == 200) {
            if (fw_stage_matches(&u->stage, u->offer.size_bytes, u->offer.sha256)) u->phase = FWU_STAGED;
            else fwu_fail(u, "download did not match the signed hash");
        } else if (status == 404) {
            fwu_fail(u, "release not published");
        } else if (status == 400) {
            fwu_fail(u, "server refused the version");
        } else {
            retry_later(u, now);             // -1, 5xx: transient
        }
        return true;
    }
    case FWU_STAGED:
        if (!idle) return false;             // D6: nothing mounted, motor off, no unsent writes
        u->phase = FWU_APPLYING;             // reported before the flash write
        return true;
    case FWU_APPLYING: {
        uint32_t slot_off = 0;
        fw_apply_result_t r = ops->apply(ops->ctx, u->stage_buf, u->offer.size_bytes,
                                         u->offer.sha256, &slot_off);
        if (r != FWA_OK) { fwu_fail(u, fw_apply_text(r)); return true; }
        st->pending = true;
        st->pending_sequence = u->offer.sequence;
        snprintf(st->pending_version, sizeof st->pending_version, "%s", u->offer.version);
        st->failure[0] = '\0';
        if (!ops->save_state(ops->ctx, st)) {
            st->pending = false;
            fwu_fail(u, "could not record the pending update");
            return true;
        }
        u->phase = FWU_REBOOTING;
        ops->request_reboot(ops->ctx, slot_off);
        return true;
    }
    default:
        return false;
    }
}

const char *fwu_state_text(const fwu_t *u) {
    switch (u->phase) {
    case FWU_QUEUED: case FWU_STAGED:       return "queued";
    case FWU_DOWNLOADING:                   return "downloading";
    case FWU_APPLYING: case FWU_REBOOTING:  return "applying";
    case FWU_FAILED:                        return "failed";
    default:                                return NULL;
    }
}
const char *fwu_error_text(const fwu_t *u) { return u->phase == FWU_FAILED ? u->error : NULL; }

const char *fwu_phase_name(fwu_phase_t p) {
    switch (p) {
    case FWU_IDLE:        return "idle";
    case FWU_QUEUED:      return "queued";
    case FWU_DOWNLOADING: return "downloading";
    case FWU_STAGED:      return "staged";
    case FWU_APPLYING:    return "applying";
    case FWU_REBOOTING:   return "rebooting";
    case FWU_FAILED:      return "failed";
    default:              return "?";
    }
}

static uint32_t diag_sig(const fwu_diag_in_t *in) {
    return (uint32_t)in->mounted | (uint32_t)in->upw << 1 | (uint32_t)in->motor << 2 |
           (uint32_t)in->owed << 3 | (uint32_t)in->preload << 4 | (uint32_t)in->idle << 5 |
           ((uint32_t)(in->slot + 1) & 0xffu) << 8 | ((uint32_t)in->dc_state & 0xffu) << 16 |
           ((uint32_t)in->phase & 0xffu) << 24;
}

bool fwu_diag_due(fwu_diag_t *d, const fwu_diag_in_t *in, uint32_t now) {
    const uint32_t sig = diag_sig(in);
    bool due;
    if (!d->have)                                   due = true;
    else if (now - d->last_ms >= FWU_DIAG_PERIOD_MS) due = true;
    else if (now - d->last_ms < FWU_DIAG_MIN_GAP_MS) due = false;
    else if (in->phase != d->phase)                  due = true;
    else due = in->phase != FWU_IDLE && sig != d->sig;
    if (due) { d->have = true; d->sig = sig; d->phase = in->phase; d->last_ms = now; }
    return due;
}

int fwu_diag_format(char *buf, int cap, const fwu_diag_in_t *in, uint32_t now) {
    char retry[24];
    if (in->retry_at_ms == 0) snprintf(retry, sizeof retry, "none");
    else snprintf(retry, sizeof retry, "%ldms", (long)(int32_t)(in->retry_at_ms - now));
    /* Bench 2026-10-09: motor=1 with the pads ALL LOW is the latch the Amiga's power-off leaves behind. */
    return snprintf(buf, (size_t)cap,
                    "fwdiag: phase=%s retry_in=%s backoff=%lums idle=%s | mounted=%d slot=%d "
                    "upw=%d motor=%d owed=%d preload=%d dc=%d",
                    fwu_phase_name(in->phase), retry, (unsigned long)in->backoff_ms,
                    in->idle ? "YES" : "no", in->mounted, in->slot, in->upw, in->motor,
                    in->owed, in->preload, in->dc_state);
}
