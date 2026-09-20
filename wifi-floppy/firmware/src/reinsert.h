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
#include <stdint.h>

typedef struct {
    bool known;            // false until the first mounted pass
    bool wprot;
    char disk_id[65];
} reinsert_t;

void reinsert_init(reinsert_t *r);

/** True exactly when `wprot` changed while the same disk stayed mounted. */
bool reinsert_on_wprot(reinsert_t *r, bool mounted, const char *disk_id, bool wprot);

// ---------------------------------------------------------------------------
// "May we announce the pending request now?"
//
// A request (reinsert_on_wprot returning true) is safe to act on only while
// the Amiga is idle: not writing (WGATE clear), motor off (it may otherwise
// be mid-seek, and the very next STEP would clear /CHNG before trackdisk's
// ~2 s change check saw it -- the request would be spent and lost), and no
// write activity -- applied OR merely attempted, see g_wgate_last_ms's
// comment in main.c -- for REINSERT_IDLE_MS (AmigaDOS may still hold
// unwritten buffers for the volume just after a save; a disk change then
// brings up "You MUST replace volume ..."; same interval as the uploader's
// idle close, UP_IDLE_CLOSE_MS, for the same reason).
//
// That gate can starve: dskchg_motor_on() only changes when the Amiga next
// selects DF0, and a powered-off Amiga leaves WGATE reading asserted
// forever. So a request pending since before REINSERT_FORCE_MS is forced
// through regardless -- a step clearing /CHNG early is recoverable, since
// the next flip re-raises it, but a request that never fires would be
// silent.
//
// Pure: every input is a parameter, time wraparound is handled the same way
// the uploader does ((int32_t)(now - x) >= 0), and `*forced_out` says
// whether this decision was the deadline case (only meaningful when the
// return value is true). Host-tested; main.c keeps only the volatile reads
// and the dskchg_image_inserted() call.
// ---------------------------------------------------------------------------
#define REINSERT_IDLE_MS  3000u
#define REINSERT_FORCE_MS 15000u

bool reinsert_may_announce(uint32_t now, uint32_t raised_ms, bool motor_on,
                            bool wgate_asserted, uint32_t last_activity_ms,
                            bool *forced_out);
#endif
