#ifndef TRACK_CACHE_H
#define TRACK_CACHE_H
// ---------------------------------------------------------------------------
// Three-tier track store:
//   tier 0  two SRAM buffers (~26 KB)  - the only thing the flux DMA reads
//   tier 1  PSRAM whole-disk image     - 2 MB, survives WiFi dropouts
//   tier 2  HTTP GET from the server   - demand path + background filler
//
// The old 16-slot / 205 KB SRAM LRU is gone: PSRAM makes it redundant and
// gives most of that SRAM back.
// ---------------------------------------------------------------------------
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include "floppy_io.h"

void track_cache_init(void);
void track_cache_flush(void);          // disk change: drop SRAM + PSRAM copies,
                                        // eject (both slots reset, active -> none)

// Core 1. Returns an SRAM buffer for 'track', copied from the PSRAM image's
// active slot (psram_active_slot()). NULL means either no disk is mounted
// or the track is not in the active slot's image - do not stream anything.
const uint8_t *track_cache_get(int track, uint32_t *bit_count);

bool track_cache_image_complete(void);
int  track_cache_fill_percent(void);

// Test-only: size of the SRAM staging buffer each track is copied into by
// track_cache_get(). Must be >= TRACK_MAX_BYTES (psram_image.h) -- that gap
// between what image_loader.c will accept into PSRAM and what this buffer
// could actually hold (13312 vs 13000, before this fix) was a live SRAM
// overflow for any track in between. Exposed as a function of the real
// buffer's sizeof, not a second macro, so the check can't drift the same way.
size_t track_cache_buf_bytes(void);
#endif
