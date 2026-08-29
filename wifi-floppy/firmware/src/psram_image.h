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
// ---------------------------------------------------------------------------
#include <stdint.h>
#include <stdbool.h>
#include "floppy_io.h"

#define NUM_TRACKS       (NUM_CYL * NUM_SIDES)      // 160
#define TRACK_SLOT_BYTES 13312u                     // 13 KB, 4-byte aligned
// 160 * 13312 = 2,129,920 B (~2.03 MB) per disk. 8 MB fits 3 with room over.

typedef enum {
    TRK_ABSENT = 0,     // not fetched yet
    TRK_PRESENT,        // valid, matches server
    TRK_DIRTY           // written by the host, needs flushing back
} track_state_t;

// True once PSRAM is detected and the image area fits. If this returns false
// the cache silently degrades to network-only operation (still works).
bool psram_image_init(void);
bool psram_image_available(void);
size_t psram_image_size(void);

track_state_t psram_image_state(int track);
bool     psram_image_have(int track);
uint32_t psram_image_bits(int track);

// Copy a track out of PSRAM into an SRAM destination. False if not present.
bool psram_image_read(int track, uint8_t *dst, uint32_t *bit_count);

// Streaming store, used by the image loader: bytes arrive in arbitrary
// chunks, so payload is written at an offset and the track is committed
// (marked present) only once it is complete.
void psram_image_write_at(int track, uint32_t offset, const uint8_t *src, int len);
void psram_image_commit(int track, uint32_t bit_count);

// Host wrote this track: keep the data, mark for later flush to the server.
void psram_image_mark_dirty(int track, const uint8_t *src, uint32_t bit_count);

// Next dirty track for the writeback walker, or -1 when the image is clean.
int  psram_image_next_dirty(void);
void psram_image_clear_dirty(int track);

// Fill progress, for the background loader and any UI.
int  psram_image_missing_count(void);
int  psram_image_next_missing(int from_track);

void psram_image_reset(void);        // eject / disk change
#endif
