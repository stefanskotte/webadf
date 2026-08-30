#include "psram_image.h"
#ifndef WFMF_HOST_TEST
#include "hardware/psram.h"
#include "pico/stdlib.h"
#endif
#include <string.h>

#ifndef WFMF_HOST_TEST
// The image lives in PSRAM. __uninitialized_psram keeps it out of the data
// image (no 4 MB of zeroes in flash, no startup memset). Two slots back to
// back: device_image[0] and device_image[1] are two independent whole-disk
// images, each addressed exactly as the single-slot layout used to be.
static __uninitialized_psram("image") uint8_t device_image[SLOT_COUNT][NUM_TRACKS][TRACK_MAX_BYTES];
#endif

// Metadata stays in SRAM: it is touched from ISR-adjacent code and is tiny.
static uint32_t      bits[SLOT_COUNT][NUM_TRACKS];
static track_state_t state[SLOT_COUNT][NUM_TRACKS];
static bool          have_psram;

// g_base/g_len point at the backing store: the SDK's PSRAM window on device
// (filled by psram_image_init()), or host memory handed in by
// psram_image_set_backing() under WFMF_HOST_TEST. Sized for SLOT_COUNT
// whole-disk images back to back.
static uint8_t *g_base;
static size_t   g_len;

// The swap word. See psram_publish_slot() below for the safety argument.
// Starts at SLOT_NONE: nothing is mounted until a fetch-and-verify sequence
// (device_client.c) explicitly publishes a slot, exactly like the old
// single-image code presented no disk until the image was fully loaded.
static volatile int32_t active_slot = SLOT_NONE;

static inline bool slot_ok(int slot) {
    return slot >= 0 && slot < SLOT_COUNT;
}

static inline uint8_t *track_ptr(int slot, int track) {
    return g_base + ((size_t)slot * NUM_TRACKS + (size_t)track) * TRACK_MAX_BYTES;
}

bool psram_image_init(void) {
    memset(bits, 0, sizeof bits);
    memset(state, 0, sizeof state);
    active_slot = SLOT_NONE;

#ifndef WFMF_HOST_TEST
    g_base = &device_image[0][0][0];
    g_len  = sizeof device_image;

    // psram_get_size() reports the board-header size (8 MB here) or the
    // auto-detected size; 0 means nothing is fitted.
    size_t sz = psram_get_size();
    have_psram = psram_is_available() && sz >= g_len;

    // With auto-detection enabled the tail of the array could fall outside
    // real PSRAM, which faults on access - check the last byte before use.
    if (have_psram && !psram_check_address((void *)(g_base + g_len - 1)))
        have_psram = false;
#else
    // Host tests call psram_image_set_backing() instead of relying on init()
    // to discover PSRAM; nothing to do here beyond the metadata reset above.
    have_psram = g_base != NULL && g_len >= (size_t)SLOT_COUNT * NUM_TRACKS * TRACK_MAX_BYTES;
#endif

    return have_psram;
}

void psram_image_set_backing(void *base, size_t len) {
    g_base = (uint8_t *)base;
    g_len  = len;
    have_psram = g_base != NULL && g_len >= (size_t)SLOT_COUNT * NUM_TRACKS * TRACK_MAX_BYTES;
}

bool   psram_image_available(void) { return have_psram; }
size_t psram_image_size(void)      { return have_psram ? g_len : 0; }

track_state_t psram_image_state(int slot, int track) {
    if (!have_psram || !slot_ok(slot) || track < 0 || track >= NUM_TRACKS) return TRK_ABSENT;
    return state[slot][track];
}

bool psram_image_have(int slot, int track) {
    return psram_image_state(slot, track) != TRK_ABSENT;
}

uint32_t psram_image_bits(int slot, int track) {
    if (!psram_image_have(slot, track)) return 0;
    return bits[slot][track];
}

bool psram_image_read(int slot, int track, uint8_t *dst, uint32_t *bit_count) {
    if (!psram_image_have(slot, track)) return false;
    uint32_t nbytes = (bits[slot][track] + 7) / 8;
    if (nbytes > TRACK_MAX_BYTES) return false;
    memcpy(dst, track_ptr(slot, track), nbytes);
    *bit_count = bits[slot][track];
    return true;
}

static void store(int slot, int track, const uint8_t *src, uint32_t bit_count,
                  track_state_t st) {
    if (!have_psram || !slot_ok(slot) || track < 0 || track >= NUM_TRACKS) return;
    uint32_t nbytes = (bit_count + 7) / 8;
    if (nbytes > TRACK_MAX_BYTES) return;          // oversized track, drop
    memcpy(track_ptr(slot, track), src, nbytes);
    bits[slot][track]  = bit_count;
    state[slot][track] = st;
}

void psram_image_write_at(int slot, int track, uint32_t offset, const uint8_t *src, int len) {
    if (!have_psram || !slot_ok(slot) || track < 0 || track >= NUM_TRACKS) return;
    if (offset + (uint32_t)len > TRACK_MAX_BYTES) return;
    memcpy(track_ptr(slot, track) + offset, src, len);
}

void psram_image_commit(int slot, int track, uint32_t bit_count) {
    if (!have_psram || !slot_ok(slot) || track < 0 || track >= NUM_TRACKS) return;
    if ((bit_count + 7) / 8 > TRACK_MAX_BYTES) return;
    bits[slot][track]  = bit_count;
    state[slot][track] = TRK_PRESENT;
}

void psram_image_mark_dirty(int slot, int track, const uint8_t *src, uint32_t bit_count) {
    store(slot, track, src, bit_count, TRK_DIRTY);
}

int psram_image_next_dirty(int slot) {
    if (!have_psram || !slot_ok(slot)) return -1;
    for (int t = 0; t < NUM_TRACKS; t++)
        if (state[slot][t] == TRK_DIRTY) return t;
    return -1;
}

void psram_image_clear_dirty(int slot, int track) {
    if (psram_image_state(slot, track) == TRK_DIRTY) state[slot][track] = TRK_PRESENT;
}

int psram_image_missing_count(int slot) {
    if (!have_psram || !slot_ok(slot)) return NUM_TRACKS;
    int n = 0;
    for (int t = 0; t < NUM_TRACKS; t++) if (state[slot][t] == TRK_ABSENT) n++;
    return n;
}

// Scan outwards from 'from_track' so the fill order follows the head, not
// track 0 - the host is most likely to want neighbours next.
int psram_image_next_missing(int slot, int from_track) {
    if (!have_psram || !slot_ok(slot)) return -1;
    if (from_track < 0) from_track = 0;
    for (int d = 0; d < NUM_TRACKS; d++) {
        int up = from_track + d, dn = from_track - d;
        if (up < NUM_TRACKS && state[slot][up] == TRK_ABSENT) return up;
        if (dn >= 0          && state[slot][dn] == TRK_ABSENT) return dn;
    }
    return -1;
}

void psram_image_reset_slot(int slot) {
    if (!slot_ok(slot)) return;
    memset(bits[slot],  0, sizeof bits[slot]);
    memset(state[slot], 0, sizeof state[slot]);
}

// The one place `active_slot` is ever written, and the entire safety
// argument for a tear-free swap rests on this being a single store.
//
// active_slot is a naturally-aligned int32_t, so on this MCU the store
// itself is atomic without a lock: core0's track_cache_get() reads it with
// no critical section and always sees either the value from before this
// call or the value from after it, never a torn mix of the two. That much
// is a property of the hardware and would be true no matter what value was
// being published.
//
// The actual safety property -- that core0 never streams a half-fetched
// disk -- comes from a rule the CALLER must uphold, not from the store
// itself: this may only be called with a slot that already holds a
// COMPLETE, VERIFIED image (device_client.c calls this only after an image
// fetch's body has arrived in full and every track has been committed), or
// with SLOT_NONE for an explicit eject. Given that rule is honoured, the
// two slots either side of any given call are each internally whole, so
// whichever one core0's next read of this word lands on, it names a real,
// playable disk (or "no disk" for SLOT_NONE) -- never a slot mid-fetch.
// Losing that discipline (e.g. publishing the fetch target before its body
// is known to be complete) reopens exactly the diskless-gap failure mode
// this two-slot design exists to close, even though the store itself would
// still be perfectly atomic.
void psram_publish_slot(int slot) {
    active_slot = (int32_t)slot;
}

int psram_active_slot(void) {
    return (int)active_slot;
}

int psram_inactive_slot(void) {
    int a = (int)active_slot;
    if (a == SLOT_NONE) return 0;
    return (a + 1) % SLOT_COUNT;
}
