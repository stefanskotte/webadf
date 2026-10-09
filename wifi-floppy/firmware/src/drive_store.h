#ifndef DRIVE_STORE_H
#define DRIVE_STORE_H
// The DF1 setting's own flash record: whether this board also answers as the
// Amiga's second drive (off / next disk of the set). A separate sector from
// config_store and display_store -- changing the drive setting must never
// touch the credentials, the token or the display layout. Same two backings
// as display_store (host buffer / one flash sector). Unlike display_store,
// the save itself does not refuse a mounted disk: WHEN to write is the
// caller's decision (drive_store_should_write, R17), because the setting acts
// at power-on and a board normally always holds a disk.
#include <stdbool.h>
#include <stdint.h>

#ifndef WF_DF1_DEFAULT
#define WF_DF1_DEFAULT 0   // release value: DF1 is off until the operator turns it on
#endif

typedef enum { DF1_MODE_OFF = 0, DF1_MODE_NEXT = 1 } df1_mode_t;

typedef struct {
    uint32_t version;   // the setting's version (the board's ack after a reboot)
    uint8_t  mode;      // df1_mode_t
} drive_record_t;

bool drive_store_load(drive_record_t *out);      // false: nothing valid stored (erased, bad magic, bad CRC)
bool drive_store_save(const drive_record_t *r);  // false on a flash error; the caller decides when (below)
void drive_store_erase(void);                    // tests only, and a future reset

// What DF1 does at boot: the stored mode if there is a valid one (an
// out-of-range mode is OFF -- never guess "on"), else the compiled default.
df1_mode_t drive_boot_mode(bool loaded, const drive_record_t *r);

// The deferred-write rule (pure, Ruling R17). The write is a flash_safe_execute
// on core0: ~45 ms with core0's interrupts off and core1 parked. It may run
//   - while both drives are empty (the original rule, display_store's), or
//   - while the Amiga is IDLE with a disk mounted (drive_store_idle).
// Only "empty" was not enough: a board powered by the Amiga holds a disk in
// DF0 from its first poll on, so a setting changed then was never stored and
// a power-cycle brought the old mode back (final review C1).
bool drive_store_should_write(bool pending, bool drive_empty, bool idle);

// "Idle" for the store (pure): the same test the board makes before releasing
// a mounted disk (swap_gate.h: no write activity -- applied or merely
// attempted -- for SWAP_IDLE_MS, WGATE clear), plus EITHER drive's motor off
// and no captured writes the server has not got (up_holds, `writes_unsent`).
// Unlike the swap hold, a motor that is on is never forced past: a trackloader
// with the motor on all session is reading, and the store can wait for it.
// `last_activity_ms` is the latest of a write, a WGATE edge and the last
// moment either motor was seen on (so the motor must have been off for
// SWAP_IDLE_MS as well). Wraparound-safe.
bool drive_store_idle(uint32_t now, bool motor_on, bool wgate_asserted,
                      uint32_t last_activity_ms, bool writes_unsent);

#ifdef WFMF_HOST_TEST
// Flips one payload byte of the stored record (a bit flip after a completed write).
void drive_store_corrupt_for_test(void);
#endif

#endif
