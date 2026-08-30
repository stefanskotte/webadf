#include "harness.h"
#include "../src/image_loader.h"
#include "../src/psram_image.h"
#include "../src/track_cache.h"
#include <stdlib.h>
#include <string.h>

static uint8_t buf[64 * 1024];
static size_t buf_len;

static void put_u32(size_t off, uint32_t v) {
    buf[off]=v&0xff; buf[off+1]=(v>>8)&0xff; buf[off+2]=(v>>16)&0xff; buf[off+3]=(v>>24)&0xff;
}

// A full NUM_TRACKS-track WFMF where track 0 claims `track0_bits` and every
// other track is a small, valid, 16-byte (128-bit) track. A single-track
// image would not do here: image_parse_buffer()'s result is "image
// incomplete" whenever fewer than NUM_TRACKS tracks got marked present, so
// with only 1 of 160 tracks in the container, its return value would be
// `false` regardless of whether the bogus bit count was correctly rejected
// or just silently parsed as a 0-byte track -- the CHECK would pass either
// way and prove nothing. A full image lets the two behaviours actually
// diverge: pre-fix, the corrupt bit count is treated as a 0-byte track and
// parsing sails through the other 159 tracks to a "complete" image; post-fix
// it aborts at track 0 before any other track is even reached.
static void build_full_image_with_bad_track0(uint32_t track0_bits) {
    memset(buf, 0, sizeof buf);
    put_u32(0, IMAGE_MAGIC); put_u32(4, IMAGE_VERSION); put_u32(8, NUM_TRACKS); put_u32(12, 0);
    size_t at = 16;
    for (int t = 0; t < NUM_TRACKS; t++) {
        put_u32(at, t == 0 ? track0_bits : 128u);
        at += 4;
        if (t != 0) {
            memset(buf + at, (uint8_t)t, 16);   // 128 bits = 16 bytes, no padding needed
            at += 16;
        }
        // Track 0's payload is intentionally omitted: if the bug fires, its
        // "payload" is 0 bytes anyway (that is the defect), so there is
        // nothing to write; if the fix fires, parsing never gets this far.
    }
    buf_len = at;
}

// The plan's original version of this test used a 13,313-byte track (one
// over TRACK_MAX_BYTES) and asserted it was refused. That test is WRONG: the
// PSRAM-slot guard in image_loader.c's S_LEN case already rejects anything
// over TRACK_MAX_BYTES, before and after this task's fix, so it passes
// either way and proves nothing.
//
// The real defect was a 13,001-13,312-byte window. image_loader.c's guard
// and psram_image_read()/psram_image.c's guard both only rejected payloads
// > TRACK_MAX_BYTES (13312). But track_cache.c's SRAM staging buffer -- the
// thing track_cache_get() actually copies a track into for the flux DMA --
// was declared `uint8_t data[TRACK_MFM_MAX]` with TRACK_MFM_MAX = 13000. So
// a track of, say, 13100 bytes was accepted into PSRAM, and every read of it
// back into that 13000-byte SRAM buffer wrote 100 bytes past the end.
// Real tracks are 12668 bytes, under both figures, so it never fired.
//
// This test proves the overflow directly. It commits a 13100-byte track
// through the same PSRAM write/commit path image_loader.c's parser uses
// (correctly, since 13100 <= TRACK_MAX_BYTES), then calls psram_image_read()
// into a buffer exactly the size track_cache.c's real staging buffer is
// today (via track_cache_buf_bytes(), not a hardcoded number, so this stays
// correct however that buffer's declaration evolves), immediately followed
// by a canary region. Before this task's fix that buffer is 13000 bytes and
// the canary is clobbered; after the fix it is 13312 and the canary
// survives.
//
// This bypasses image_parse_buffer()/the full WFMF container on purpose: a
// container only ever "completes" with all 160 tracks present, which is
// irrelevant noise for a defect that lives entirely in psram_image_read()
// and track_cache.c's buffer size for a single track.
static void test_read_does_not_overflow_a_track_cache_sized_buffer(void) {
    const uint32_t payload_bytes = 13100u;   // inside the 13001-13312 gap
    uint8_t payload[13100];
    memset(payload, 0x5A, sizeof payload);
    psram_image_reset();
    psram_image_write_at(0, 0, payload, (int)payload_bytes);
    psram_image_commit(0, payload_bytes * 8u);
    CHECK(psram_image_have(0), "a 13100-byte track is within TRACK_MAX_BYTES and must commit");

    size_t cache_buf_bytes = track_cache_buf_bytes();
    size_t canary_bytes = 64;
    uint8_t *victim = malloc(cache_buf_bytes + canary_bytes);
    memset(victim + cache_buf_bytes, 0xAA, canary_bytes);

    uint32_t bit_count = 0;
    CHECK(psram_image_read(0, victim, &bit_count),
          "the committed 13100-byte track must read back");

    bool canary_intact = true;
    for (size_t i = 0; i < canary_bytes; i++)
        if (victim[cache_buf_bytes + i] != 0xAA) canary_intact = false;
    CHECK(canary_intact,
          "psram_image_read wrote past a track_cache-sized SRAM buffer -- "
          "the staging buffer is smaller than the largest track the loader accepts");
    free(victim);
}

// The invariant whose violation *is* the bug above, asserted directly rather
// than only through its symptom: the SRAM buffer track_cache_get() copies a
// track into can never be smaller than the largest payload image_loader.c
// (and psram_image.c's write path) will accept into PSRAM. Before this
// task's fix those were two different constants (TRACK_MAX_BYTES = 13312 vs
// TRACK_MFM_MAX = 13000); the fix reconciles them into one, so this can
// never regress by having two names drift apart again.
static void test_staging_buffer_is_at_least_the_max_accepted_track(void) {
    CHECK(track_cache_buf_bytes() >= (size_t)TRACK_MAX_BYTES,
          "the SRAM staging buffer must be at least as large as the largest "
          "track image_loader.c will accept into PSRAM");
}

static void test_bit_count_overflow_is_refused(void) {
    // (bits + 7) / 8 wraps to 0 on uint32 and sails past a size guard.
    build_full_image_with_bad_track0(0xFFFFFFF9u);
    CHECK(!image_parse_buffer(0, buf, buf_len),
          "a bit_count that overflows (bits+7)/8 must be refused, not parsed as 0 bytes "
          "and let the rest of the image through");
}

int main(void) {
    size_t len = (size_t)TRACK_MAX_BYTES * NUM_TRACKS;
    void *mem = malloc(len);
    psram_image_set_backing(mem, len);
    RUN(test_read_does_not_overflow_a_track_cache_sized_buffer);
    RUN(test_staging_buffer_is_at_least_the_max_accepted_track);
    RUN(test_bit_count_overflow_is_refused);
    free(mem);
    return REPORT();
}
