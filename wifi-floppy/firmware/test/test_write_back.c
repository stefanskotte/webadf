#include "harness.h"
#include "../src/write_back.h"
#include "../src/mfm.h"
#include "../src/flux_bits.h"
#include "../src/psram_image.h"
#include "../src/track_cache.h"
#include <stdlib.h>
#include <string.h>

/*
 * Write-back piece 1: whether a captured write may touch the disk, and what
 * applying one does. The capture-shaped test drives the same chain the
 * board runs -- flux intervals -> bits -> sectors -> verdict -> encode ->
 * PSRAM -> served track -- and checks the Amiga would read back exactly what
 * it wrote.
 */

#define CELL_NS 2000u

static mfm_decode_result_t whole(int track) {
    mfm_decode_result_t d;
    memset(&d, 0, sizeof d);
    d.found = 0x7ff; d.track_no = (uint8_t)track; d.track_no_consistent = true;
    return d;
}

static int32_t mounted_token(void) {
    psram_publish_slot(0);
    return psram_active_token();
}

static void verdict_applies_a_whole_clean_track(void) {
    int32_t tok = mounted_token();
    mfm_decode_result_t d = whole(80);
    CHECK_EQ_INT(write_back_verdict(&d, 80, false, tok, tok), WB_APPLY);
}

static void verdict_rejects_each_fault(void) {
    int32_t tok = mounted_token();
    mfm_decode_result_t d = whole(80);

    CHECK_EQ_INT(write_back_verdict(&d, 80, true, tok, tok), WB_REJECT_OVERFLOW);

    d.found = 0x7fe;                        // sector 0 missing
    CHECK_EQ_INT(write_back_verdict(&d, 80, false, tok, tok), WB_REJECT_PARTIAL);
    d.found = 0x3ff;                        // the last sector missing (2026-09-15's bug)
    CHECK_EQ_INT(write_back_verdict(&d, 80, false, tok, tok), WB_REJECT_PARTIAL);

    d = whole(80); d.track_no_consistent = false;
    CHECK_EQ_INT(write_back_verdict(&d, 80, false, tok, tok), WB_REJECT_INCONSISTENT);

    d = whole(69);                          // "track says 69, head is on 70"
    CHECK_EQ_INT(write_back_verdict(&d, 70, false, tok, tok), WB_REJECT_WRONG_TRACK);
}

static void verdict_rejects_a_write_that_outlived_its_disk(void) {
    psram_publish_slot(0);
    int32_t before = psram_active_token();
    psram_publish_slot(1);                  // a swap landed during the write
    int32_t after = psram_active_token();
    mfm_decode_result_t d = whole(10);
    CHECK_EQ_INT(write_back_verdict(&d, 10, false, before, after), WB_REJECT_DISK_CHANGED);

    psram_publish_slot(SLOT_NONE);          // an eject
    int32_t none = psram_active_token();
    CHECK_EQ_INT(write_back_verdict(&d, 10, false, none, none), WB_REJECT_NO_DISK);
}

static void every_verdict_has_a_reason(void) {
    for (int v = WB_APPLY; v <= WB_REJECT_WRONG_TRACK; v++)
        CHECK(write_back_reason((wb_verdict_t)v)[0] != '\0', "a log line needs a reason");
}

/* A disk in slot 0 whose track `t` holds the encoding of `data`. */
static void seed_track(int t, const uint8_t *data) {
    static uint8_t mfm[MFM_TRACK_BYTES];
    uint32_t bits = mfm_encode_track(data, (uint8_t)t, mfm);
    psram_image_write_at(0, t, 0, mfm, MFM_TRACK_BYTES);
    psram_image_commit(0, t, bits);
    psram_publish_slot(0);
}

static void decode_served(int t, uint8_t *out) {
    uint32_t bits = 0;
    const uint8_t *m = track_cache_get(t, &bits);
    memset(out, 0, MFM_TRACK_DATA_BYTES);
    if (!m) { CHECK(0, "track must be served"); return; }
    mfm_decode_result_t r;
    mfm_decode_track(m, (bits + 7u) / 8u, out, &r);
    CHECK_EQ_INT(r.found, 0x7ff);
    CHECK_EQ_INT(r.track_no, t);
}

static void apply_stores_dirty_and_the_new_bytes_are_served(void) {
    static uint8_t oldt[MFM_TRACK_DATA_BYTES], newt[MFM_TRACK_DATA_BYTES], got[MFM_TRACK_DATA_BYTES];
    memset(oldt, 0x11, sizeof oldt);
    for (size_t i = 0; i < sizeof newt; i++) newt[i] = (uint8_t)(i * 7u);
    seed_track(40, oldt);

    decode_served(40, got);                 // caches the OLD copy in SRAM
    CHECK(memcmp(got, oldt, sizeof got) == 0, "before: old bytes");

    CHECK(write_back_apply(0, 40, newt), "apply must land");
    CHECK_EQ_INT(psram_image_state(0, 40), TRK_DIRTY);

    // Without invalidation the SRAM copy is stale -- this is WHY the
    // function exists. Asserted so that deleting it is a test failure.
    decode_served(40, got);
    CHECK(memcmp(got, oldt, sizeof got) == 0, "SRAM still holds the old copy");

    track_cache_invalidate(40);
    decode_served(40, got);
    CHECK(memcmp(got, newt, sizeof got) == 0, "after invalidate: the written bytes");
}

/* ---- the whole chain, from flux, on a capture shaped like a real one ---- */

static bool bit_at(const uint8_t *b, size_t i) { return (b[i >> 3] >> (7 - (i & 7))) & 1u; }

static void capture_shaped_write_applies_and_reads_back(void) {
    // What the Amiga writes: a standard track of NEW data. The capture starts
    // `skew` bits in (any edge after WGATE) -- 1-7 bits off byte alignment is
    // exactly what hid the byte-only sync search (2026-09-15).
    static uint8_t oldt[MFM_TRACK_DATA_BYTES], newt[MFM_TRACK_DATA_BYTES], got[MFM_TRACK_DATA_BYTES];
    static uint8_t wire[MFM_TRACK_BYTES], bitsbuf[MFM_TRACK_BYTES + 16];
    memset(oldt, 0, sizeof oldt);
    for (size_t i = 0; i < sizeof newt; i++) newt[i] = (uint8_t)(i ^ 0x5a);
    const int t = 123;
    seed_track(t, oldt);
    int32_t tok = psram_active_token();
    mfm_encode_track(newt, (uint8_t)t, wire);

    for (unsigned skew = 1; skew <= 7; skew++) {
        flux_bits_t f;
        flux_bits_init(&f, bitsbuf, sizeof bitsbuf);
        size_t prev = SIZE_MAX;
        for (size_t i = skew; i < sizeof wire * 8u; i++) {
            if (!bit_at(wire, i)) continue;
            if (prev != SIZE_MAX) flux_bits_feed(&f, (uint32_t)(i - prev) * CELL_NS);
            prev = i;
        }
        static uint8_t decoded[MFM_TRACK_DATA_BYTES];
        memset(decoded, 0, sizeof decoded);
        mfm_decode_result_t d;
        mfm_decode_track(bitsbuf, flux_bits_bytes(&f), decoded, &d);

        CHECK_EQ_INT(write_back_verdict(&d, t, f.overflowed, tok, psram_active_token()), WB_APPLY);
        CHECK(write_back_apply(0, t, decoded), "apply");
        track_cache_invalidate(t);
        decode_served(t, got);
        CHECK(memcmp(got, newt, sizeof got) == 0, "the Amiga reads back what it wrote");
    }
}

int main(void) {
    size_t len = (size_t)TRACK_MAX_BYTES * NUM_TRACKS * SLOT_COUNT;
    void *mem = malloc(len);
    psram_image_set_backing(mem, len);
    track_cache_init();
    RUN(verdict_applies_a_whole_clean_track);
    RUN(verdict_rejects_each_fault);
    RUN(verdict_rejects_a_write_that_outlived_its_disk);
    RUN(every_verdict_has_a_reason);
    RUN(apply_stores_dirty_and_the_new_bytes_are_served);
    RUN(capture_shaped_write_applies_and_reads_back);
    free(mem);
    return REPORT();
}
