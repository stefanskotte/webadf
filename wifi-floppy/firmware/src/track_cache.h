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

// Core 0 (see psram_image.h/.c: "core0 (track_cache.c's track_cache_get())
// is the only reader" of the published active slot -- this comment
// previously said "Core 1", which task 10 corrects: main.c's core1 runs
// the network/device_client.c loop, which blocks for tens of seconds at a
// time on a long poll, and calling this from that same core would leave
// the flux DMA replaying a stale track for the whole time a poll is in
// flight after a seek). Returns an SRAM buffer for 'track', copied from
// the PSRAM image's active slot (psram_active_slot()). NULL means either
// no disk is mounted
// or the track is not in the active slot's image - do not stream anything.
const uint8_t *track_cache_get(int track, uint32_t *bit_count);

// Drop any SRAM copy of `track`. Needed after a write rewrites that track in
// PSRAM: track_cache_get() keys its copies on (track, token), and a write
// changes neither, so without this the OLD bytes would keep being served.
void track_cache_invalidate(int track);

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
