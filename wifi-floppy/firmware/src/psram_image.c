#include "psram_image.h"
#ifndef WFMF_HOST_TEST
#include "hardware/psram.h"
#include "pico/stdlib.h"
#endif
#include <string.h>

#ifndef WFMF_HOST_TEST
// The image lives in PSRAM. __uninitialized_psram keeps it out of the data
// image (no 2 MB of zeroes in flash, no startup memset).
static __uninitialized_psram("image") uint8_t device_image[NUM_TRACKS][TRACK_MAX_BYTES];
#endif

// Metadata stays in SRAM: it is touched from ISR-adjacent code and is tiny.
static uint32_t      bits[NUM_TRACKS];
static track_state_t state[NUM_TRACKS];
static bool          have_psram;

// g_base/g_len point at the backing store: the SDK's PSRAM window on device
// (filled by psram_image_init()), or host memory handed in by
// psram_image_set_backing() under WFMF_HOST_TEST.
static uint8_t *g_base;
static size_t   g_len;

static inline uint8_t *track_ptr(int track) {
    return g_base + (size_t)track * TRACK_MAX_BYTES;
}

bool psram_image_init(void) {
    memset(bits, 0, sizeof bits);
    memset(state, 0, sizeof state);

#ifndef WFMF_HOST_TEST
    g_base = &device_image[0][0];
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
    have_psram = g_base != NULL && g_len >= (size_t)NUM_TRACKS * TRACK_MAX_BYTES;
#endif

    return have_psram;
}

void psram_image_set_backing(void *base, size_t len) {
    g_base = (uint8_t *)base;
    g_len  = len;
    have_psram = g_base != NULL && g_len >= (size_t)NUM_TRACKS * TRACK_MAX_BYTES;
}

bool   psram_image_available(void) { return have_psram; }
size_t psram_image_size(void)      { return have_psram ? g_len : 0; }

track_state_t psram_image_state(int track) {
    if (!have_psram || track < 0 || track >= NUM_TRACKS) return TRK_ABSENT;
    return state[track];
}

bool psram_image_have(int track) {
    return psram_image_state(track) != TRK_ABSENT;
}

uint32_t psram_image_bits(int track) {
    if (!psram_image_have(track)) return 0;
    return bits[track];
}

bool psram_image_read(int track, uint8_t *dst, uint32_t *bit_count) {
    if (!psram_image_have(track)) return false;
    uint32_t nbytes = (bits[track] + 7) / 8;
    if (nbytes > TRACK_MAX_BYTES) return false;
    memcpy(dst, track_ptr(track), nbytes);
    *bit_count = bits[track];
    return true;
}

static void store(int track, const uint8_t *src, uint32_t bit_count,
                  track_state_t st) {
    if (!have_psram || track < 0 || track >= NUM_TRACKS) return;
    uint32_t nbytes = (bit_count + 7) / 8;
    if (nbytes > TRACK_MAX_BYTES) return;          // oversized track, drop
    memcpy(track_ptr(track), src, nbytes);
    bits[track]  = bit_count;
    state[track] = st;
}

void psram_image_write_at(int track, uint32_t offset, const uint8_t *src, int len) {
    if (!have_psram || track < 0 || track >= NUM_TRACKS) return;
    if (offset + (uint32_t)len > TRACK_MAX_BYTES) return;
    memcpy(track_ptr(track) + offset, src, len);
}

void psram_image_commit(int track, uint32_t bit_count) {
    if (!have_psram || track < 0 || track >= NUM_TRACKS) return;
    if ((bit_count + 7) / 8 > TRACK_MAX_BYTES) return;
    bits[track]  = bit_count;
    state[track] = TRK_PRESENT;
}

void psram_image_mark_dirty(int track, const uint8_t *src, uint32_t bit_count) {
    store(track, src, bit_count, TRK_DIRTY);
}

int psram_image_next_dirty(void) {
    if (!have_psram) return -1;
    for (int t = 0; t < NUM_TRACKS; t++)
        if (state[t] == TRK_DIRTY) return t;
    return -1;
}

void psram_image_clear_dirty(int track) {
    if (psram_image_state(track) == TRK_DIRTY) state[track] = TRK_PRESENT;
}

int psram_image_missing_count(void) {
    if (!have_psram) return NUM_TRACKS;
    int n = 0;
    for (int t = 0; t < NUM_TRACKS; t++) if (state[t] == TRK_ABSENT) n++;
    return n;
}

// Scan outwards from 'from_track' so the fill order follows the head, not
// track 0 - the host is most likely to want neighbours next.
int psram_image_next_missing(int from_track) {
    if (!have_psram) return -1;
    if (from_track < 0) from_track = 0;
    for (int d = 0; d < NUM_TRACKS; d++) {
        int up = from_track + d, dn = from_track - d;
        if (up < NUM_TRACKS && state[up] == TRK_ABSENT) return up;
        if (dn >= 0          && state[dn] == TRK_ABSENT) return dn;
    }
    return -1;
}

void psram_image_reset(void) {
    memset(bits, 0, sizeof bits);
    memset(state, 0, sizeof state);
}
