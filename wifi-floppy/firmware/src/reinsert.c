#include "reinsert.h"
#include <string.h>

void reinsert_init(reinsert_t *r) {
    memset(r, 0, sizeof *r);
}

bool reinsert_on_wprot(reinsert_t *r, bool mounted, const char *disk_id, bool wprot) {
    if (!mounted) { r->known = false; return false; }
    // An empty id (the poll omitted diskId) identifies nothing: never "same"
    // on this pass, and never overwrites the id remembered from an earlier
    // one -- keep the last identity actually known. Overwriting it with ""
    // would make the NEXT poll that DOES carry the real id look like a
    // different disk and swallow the flip it should announce.
    const bool same = r->known && disk_id[0] != '\0' && strcmp(r->disk_id, disk_id) == 0;
    const bool flip = same && r->wprot != wprot;
    r->known = true;
    r->wprot = wprot;
    if (disk_id[0] != '\0') {
        strncpy(r->disk_id, disk_id, sizeof r->disk_id - 1);
        r->disk_id[sizeof r->disk_id - 1] = '\0';
    }
    return flip;
}

bool reinsert_may_announce(uint32_t now, uint32_t raised_ms, bool motor_on,
                            bool wgate_asserted, uint32_t last_activity_ms,
                            bool *forced_out) {
    const bool forced = (int32_t)(now - raised_ms) >= (int32_t)REINSERT_FORCE_MS;
    if (forced_out) *forced_out = forced;
    if (forced) return true;
    if (motor_on) return false;
    if (wgate_asserted) return false;
    if ((int32_t)(now - last_activity_ms) < (int32_t)REINSERT_IDLE_MS) return false;
    return true;
}
