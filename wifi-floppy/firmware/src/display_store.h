#ifndef DISPLAY_STORE_H
#define DISPLAY_STORE_H
// The display layout's own flash record: which display version the board
// holds, for which panel, and the encoded layout blob (spec 2026-10-04
// oled-layouts §6). A separate sector from config_store -- a layout change
// must never touch the credentials or the token. Same two backings as
// config_store (host buffer / one flash sector), same mounted-disk guard.
#include <stdbool.h>
#include <stdint.h>
#include "display_layout.h"

typedef struct {
    uint32_t version;           // the display version this record holds (the board's displayAck after a reboot)
    uint8_t  panel;             // panel_t
    uint8_t  has_layout;        // 0 = the panel's default
    uint8_t  blob_len;          // 0..LAYOUT_BLOB_MAX
    uint8_t  blob[LAYOUT_BLOB_MAX];
} display_record_t;

bool display_store_load(display_record_t *out);     // false: nothing valid stored (erased, bad magic, bad CRC)
bool display_store_save(const display_record_t *r); // false while a disk is mounted, or on a flash error
void display_store_erase(void);                      // tests only, and a future reset

// The deferred-write rule (pure): write when something new is pending and the drive is empty.
bool display_store_should_write(bool pending, bool disk_mounted);

#ifdef WFMF_HOST_TEST
// Flips one payload byte of the stored record (a bit flip after a completed write).
void display_store_corrupt_for_test(void);
#endif

#endif
