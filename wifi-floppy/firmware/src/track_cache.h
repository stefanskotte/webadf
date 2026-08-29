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
#include "floppy_io.h"

void track_cache_init(void);
void track_cache_flush(void);          // disk change: drop SRAM + PSRAM copies

// Core 1. Returns an SRAM buffer for 'track', copied from the PSRAM image.
// NULL means the track is not in the image - do not stream anything.
const uint8_t *track_cache_get(int track, uint32_t *bit_count);

bool track_cache_image_complete(void);
int  track_cache_fill_percent(void);
#endif
