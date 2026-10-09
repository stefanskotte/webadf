#ifndef DRIVE_STORE_H
#define DRIVE_STORE_H
// The DF1 setting's own flash record: whether this board also answers as the
// Amiga's second drive (off / next disk of the set). A separate sector from
// config_store and display_store -- changing the drive setting must never
// touch the credentials, the token or the display layout. Same two backings
// as display_store (host buffer / one flash sector), same mounted-disk guard.
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
bool drive_store_save(const drive_record_t *r);  // false while a disk is mounted, or on a flash error
void drive_store_erase(void);                    // tests only, and a future reset

// What DF1 does at boot: the stored mode if there is a valid one (an
// out-of-range mode is OFF -- never guess "on"), else the compiled default.
df1_mode_t drive_boot_mode(bool loaded, const drive_record_t *r);

// The deferred-write rule (pure): write when something new is pending and the drive is empty.
bool drive_store_should_write(bool pending, bool drive_empty);

#ifdef WFMF_HOST_TEST
// Flips one payload byte of the stored record (a bit flip after a completed write).
void drive_store_corrupt_for_test(void);
#endif

#endif
