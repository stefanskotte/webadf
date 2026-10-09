#include "df1_live.h"

df1_live_t df1_live_apply(df1_mode_t to, bool enabled) {
    df1_live_t p = { DRIVE_ID_KIND_NONE, false, false, false, false, false, false, false };
    if (to == DF1_MODE_NEXT) {
        p.id = DRIVE_ID_KIND_DD;
        p.set_id = true;
        p.lines = true;
        p.eject = true;
        p.unmount = true;
        p.enable = true;
        p.rescan = true;
        return p;
    }
    if (!enabled) return p;            // OFF -> OFF: an absent drive stays absent
    p.set_id = true;                   // ID NONE
    p.eject = true;
    p.unmount = true;
    p.parked = true;                   // never disabled live: CHNG would be released
    return p;
}

uint8_t df1_serving_mask(unsigned n_drives, bool df1_enabled) {
    return (uint8_t)(1u | (n_drives > 1 && df1_enabled ? 2u : 0u));
}

