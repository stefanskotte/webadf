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

// The SRAM staging buffers -- track_cache.c's double buffer and main.c's DMA
// word buffer -- are sized for the LONGEST track either tier hands them: an
// HD track encoded on the board, 202,688 bits = 25,336 bytes, rounded up to a
// multiple of 4 (HD spec §5.2). Separate from TRACK_MAX_BYTES (psram_image.h),
// the PSRAM stride, which stays 14 KB: an HD slot holds 11,264 ADF bytes a
// track. Costs ~33 KB of SRAM over 14336-byte buffers; the spike measured
// ~170 KB free before this.
#define TRACK_BUF_BYTES 25344u

void track_cache_init(void);
// track_cache_flush() was removed -- see track_cache.c for why (it was an
// uncalled, unrequested eject). Do not reintroduce it under that name.

// Review round 1, Critical C-1: a swap or an eject only becomes visible to
// core0 when something re-enters track_cache_get() -- before this task,
// only a STEP pulse (a seek) ever did that. Once core1's device_client.c
// loop can publish a new slot (a swap) or SLOT_NONE (an eject) at any time,
// core0's main() loop must notice even when the Amiga never seeks, or the
// flux DMA keeps replaying a departed disk's last track forever (an eject
// nobody asked for's exact inverse: an eject NOBODY SEES).
//
// Pure and host-testable on purpose: it only reads psram_active_token()/
// psram_token_slot() (task 8), never touches GPIO or DMA, so the "did the
// active image identity change" decision can be exercised from the host
// test build even though the actual dskchg_image_inserted()/ejected() and
// DMA-stopping side effects that main.c drives from it cannot be (they
// need real hardware).
//
// `*last_token` is the caller's own record of the last token it observed;
// pass a variable seeded to 0 (psram_image.c: 0 is never produced by a
// real publish, so it safely means "nothing observed yet", matching the
// unmounted boot state). Returns true at most once per actual change, and
// only then writes `*mounted_out` (true if the NEW token names a real
// slot, false for SLOT_NONE / an eject).
bool track_cache_check_swap(int32_t *last_token, bool *mounted_out);

// Core 0 ONLY, from main()'s service loop -- thread mode, never an interrupt:
// the STEP and SIDE ISRs only set want_track, and dma_irq only re-arms from
// main.c's track_words. (Not core1: its device_client.c loop blocks for tens
// of seconds on a long poll, which would leave the flux DMA replaying a stale
// track after a seek.) Returns an SRAM buffer for 'track' from the PSRAM
// image's active slot (psram_active_slot()): copied for an MFM slot, ENCODED
// for an ADF_HD slot (adf_mfm.c, ~4 ms measured on the RP2350, HD spec §5.2;
// the previous track keeps streaming meanwhile). NULL means no disk is
// mounted or the track is not in the active slot's image - do not stream
// anything.
const uint8_t *track_cache_get(int track, uint32_t *bit_count);

// The same, for any published token: DF0 passes psram_active_token(), DF1
// psram_df1_token(). An eject token (a SLOT_NONE word) gives NULL. The cache
// keys on the whole token, so two drives' copies of one track number never
// collide. track_cache_get(t, b) is track_cache_get_token(psram_active_token(), t, b).
//
// R14: the pointer either function returns is one of TWO SRAM buffers shared
// by both drives, so it is valid only until the next track_cache_get* call on
// EITHER drive. main.c consumes it with start_streaming(d, ...) -- which
// copies it into that drive's DMA word buffer -- before any further get; it
// is never held across one (serve_drive does the get and the copy together).
const uint8_t *track_cache_get_token(int32_t token, int track, uint32_t *bit_count);

// Drop any SRAM copy of `track`. Needed after a write rewrites that track in
// PSRAM: track_cache_get() keys its copies on (track, token), and a write
// changes neither, so without this the OLD bytes would keep being served.
void track_cache_invalidate(int track);

bool track_cache_image_complete(void);
int  track_cache_fill_percent(void);

// Test-only: size of the SRAM staging buffer each track is copied or encoded
// into by track_cache_get(): TRACK_BUF_BYTES. The binding invariant is now
// >= ADF_MFM_HD_TRACK_BYTES (25,336, an HD track encoded on the board), which
// also covers >= TRACK_MAX_BYTES (psram_image.h) for a stored MFM track. A
// gap between what a tier can hand this buffer and what it holds is a live
// SRAM overflow -- it once was, 13312 vs 13000. Exposed as a function of the
// real buffer's sizeof, not a second macro, so the check can't drift.
size_t track_cache_buf_bytes(void);
#endif
