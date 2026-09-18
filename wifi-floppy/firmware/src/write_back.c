#include "write_back.h"
#include "psram_image.h"

wb_verdict_t write_back_verdict(const mfm_decode_result_t *d, int head_track,
                                bool overflowed, int32_t token_at_wgate,
                                int32_t token_now) {
    // Disk identity first: a write belongs to the disk that was mounted when
    // WGATE asserted, and to no other -- however good its sectors are.
    if (psram_token_slot(token_now) == SLOT_NONE) return WB_REJECT_NO_DISK;
    if (token_now != token_at_wgate)              return WB_REJECT_DISK_CHANGED;
    if (overflowed)                               return WB_REJECT_OVERFLOW;
    if (d->found != 0x7ffu)                       return WB_REJECT_PARTIAL;
    if (!d->track_no_consistent)                  return WB_REJECT_INCONSISTENT;
    // The one corruption a checksum cannot see: a valid track for a cylinder
    // the head is not on.
    if ((int)d->track_no != head_track)           return WB_REJECT_WRONG_TRACK;
    return WB_APPLY;
}

const char *write_back_reason(wb_verdict_t v) {
    switch (v) {
    case WB_APPLY:               return "applied";
    case WB_REJECT_NO_DISK:      return "no disk mounted";
    case WB_REJECT_DISK_CHANGED: return "disk changed during the write";
    case WB_REJECT_OVERFLOW:     return "capture overflowed";
    case WB_REJECT_PARTIAL:      return "not all 11 sectors verified";
    case WB_REJECT_INCONSISTENT: return "sector headers disagree about the track";
    case WB_REJECT_WRONG_TRACK:  return "sectors name another track";
    }
    return "unknown";
}

bool write_back_apply(int slot, int track, const uint8_t *adf_track) {
    // Static: 12.6 KB would not fit core0's frame. Not re-entrant, and only
    // ever called from core0's service loop.
    static uint8_t mfm[MFM_TRACK_BYTES];
    const uint32_t bits = mfm_encode_track(adf_track, (uint8_t)track, mfm);
    psram_image_mark_dirty(slot, track, mfm, bits);
    return psram_image_state(slot, track) == TRK_DIRTY;
}
