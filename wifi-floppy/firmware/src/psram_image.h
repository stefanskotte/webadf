#ifndef PSRAM_IMAGE_H
#define PSRAM_IMAGE_H
// ---------------------------------------------------------------------------
// Whole-disk MFM image held in PSRAM (Pimoroni Pico Plus 2 W: 8 MB APS6404
// on QMI CS1 / GPIO 47, size + CS come from the board header, so the SDK's
// runtime init brings it up before main()).
//
// Tier 1 of the cache. Nothing here is ever a DMA source: the flux DMA always
// reads an SRAM buffer, because a QMI cache miss contending with XIP could add
// latency on a 2 us bitcell. PSRAM is bulk storage only, copied into SRAM on
// track change (~13 KB memcpy, microseconds).
//
// Two slots (task 8): one is always what core0's track_cache_get() streams
// from (the "active" slot); the other is free for core1 to fetch a
// replacement disk into while the active one keeps playing. A slot is never
// exposed to core0 until it holds a complete, verified image -- see
// psram_publish_slot()'s comment in psram_image.c for the full argument.
// ---------------------------------------------------------------------------
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include "floppy_io.h"

#define NUM_TRACKS       (NUM_CYL * NUM_SIDES)      // 160

// One constant for both the PSRAM slot and the SRAM staging buffer. These
// were TRACK_SLOT_BYTES=13312 (PSRAM) and TRACK_MFM_MAX=13000 (SRAM); the
// 312-byte gap was a latent overflow for any track between the two, since
// the loader accepted up to the larger and track_cache copied into the
// smaller. Real tracks are 12668, under both, so it never fired.
//
// Reconciled UPWARDS to 13312: the SRAM staging buffer grows by 312 bytes,
// which is free, and no previously-valid image becomes invalid. Reconciling
// downwards to 13000 would have been a silent format restriction.
//
// Raised to 14336 (14 KB) on 2026-09-24 for HFE disks with long tracks:
// Turrican's custom format writes 13,500 bytes per side (108,000 cells, a
// 216 ms revolution at our fixed 2 us cell), every byte of it data. The
// server learns a board's limit from the status report ("trackMaxBytes")
// and will not mount a disk with longer tracks on a board that cannot hold
// them; a board too old to report is assumed to hold 13312.
#define TRACK_MAX_BYTES 14336u                      // 14 KB, 4-byte aligned
// 160 * 14336 = 2,293,760 B (~2.19 MB) per disk; two slots use ~4.37 MiB.
// With the 2 MiB firmware-update stage (g_fw_stage, main.c) behind them,
// ~6.4 MiB of the 8 MB part is spoken for.

#define SLOT_COUNT 2
#define SLOT_NONE  (-1)

typedef enum {
    TRK_ABSENT = 0,     // not fetched yet
    TRK_PRESENT,        // valid, matches server
    TRK_DIRTY           // written by the host, needs flushing back
} track_state_t;

// True once PSRAM is detected and the image area (both slots) fits. If this
// returns false the cache silently degrades to network-only operation
// (still works).
bool psram_image_init(void);
bool psram_image_available(void);
size_t psram_image_size(void);

track_state_t psram_image_state(int slot, int track);
bool     psram_image_have(int slot, int track);
uint32_t psram_image_bits(int slot, int track);

// Copy a track out of PSRAM into an SRAM destination. False if not present.
bool psram_image_read(int slot, int track, uint8_t *dst, uint32_t *bit_count);

// Streaming store, used by the image loader: bytes arrive in arbitrary
// chunks, so payload is written at an offset and the track is committed
// (marked present) only once it is complete.
void psram_image_write_at(int slot, int track, uint32_t offset, const uint8_t *src, int len);
void psram_image_commit(int slot, int track, uint32_t bit_count);

// Host wrote this track: keep the data, mark for later flush to the server.
void psram_image_mark_dirty(int slot, int track, const uint8_t *src, uint32_t bit_count);

// Next dirty track for the writeback walker, or -1 when the image is clean.
int  psram_image_next_dirty(int slot);
void psram_image_clear_dirty(int slot, int track);
void psram_image_set_dirty(int slot, int track);      // flag only; a PRESENT track becomes DIRTY
int  psram_image_dirty_count(int slot);
void psram_image_discard_dirty(int slot);             // every DIRTY track becomes PRESENT

// Fill progress, for the background loader and any UI.
int  psram_image_missing_count(int slot);
int  psram_image_next_missing(int slot, int from_track);

void psram_image_reset_slot(int slot);   // clear one slot, leaving the other alone

// --- The active/inactive swap -----------------------------------------
//
// The published word is a single volatile, naturally-aligned int32_t:
// core1 (this file, driven by device_client.c's fetch-and-swap sequence)
// is the only writer, core0 (track_cache.c's track_cache_get()) is the
// only reader. It packs a generation counter together with the slot index
// -- NOT a bare slot index -- because a slot index is reused across disk
// generations and a bare index cannot tell today's occupant of slot 0
// apart from yesterday's. See psram_publish_slot()'s definition in
// psram_image.c for the full safety argument (atomicity, ordering, and
// why the generation matters).
void psram_publish_slot(int slot);      // the single volatile store core0 reads

// The full published token (generation + slot, or the unmounted word).
// track_cache.c tags its cached SRAM copies with this whole value, not
// with psram_active_slot()'s decoded slot number, so a copy cached under
// an earlier occupant of a slot can never be mistaken for a later one that
// reuses it. Reading this applies the acquire barrier that pairs with
// psram_publish_slot()'s release barrier -- see psram_image.c.
int32_t psram_active_token(void);
int     psram_token_slot(int32_t token);   // decode a token; no barrier, no re-read

int  psram_active_slot(void);           // SLOT_NONE when ejected
int  psram_inactive_slot(void);         // the fetch target; SLOT_NONE -> 0

// Host tests only: point the image store at ordinary memory. On device the
// SDK's PSRAM window is used and this is never called.
void psram_image_set_backing(void *base, size_t len);
#endif
