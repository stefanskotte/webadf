#ifndef REINSERT_H
#define REINSERT_H
// ---------------------------------------------------------------------------
// When a write-protect change must be announced to the Amiga as a disk change.
//
// AmigaDOS reads a disk's write-protect state only when it believes a disk was
// inserted -- a real floppy's tab slid while it is in the drive changes nothing
// until it is re-inserted. The board flips WPROT live (the server bumps it for
// a flag-only change), so a flip on the SAME mounted disk must also be told to
// the Amiga the way an insert is: /CHNG asserted until the next step
// (dskchg_image_inserted). A flip that arrives with a different disk, or with
// none, is not announced here: the mount/eject path already says so.
//
// "Same disk" is the disk's ID, never its digest: write-back gives the disk a
// new digest at every close, and to the Amiga it is still the disk it wrote.
// Pure, host-tested; core1 calls it once per loop pass.
// ---------------------------------------------------------------------------
#include <stdbool.h>

typedef struct {
    bool known;            // false until the first mounted pass
    bool wprot;
    char disk_id[65];
} reinsert_t;

void reinsert_init(reinsert_t *r);

/** True exactly when `wprot` changed while the same disk stayed mounted. */
bool reinsert_on_wprot(reinsert_t *r, bool mounted, const char *disk_id, bool wprot);
#endif
