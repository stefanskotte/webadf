#include "harness.h"
#include "../src/flux_bits.h"
#include "../src/mfm.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

/*
 * The capture path, end to end, with no Amiga.
 *
 * A golden MFM track is turned into the flux intervals a drive would produce
 * from it -- the gaps between its set bits -- and those intervals are fed back
 * through the accumulator and the decoder. If the sectors come out matching
 * the bytes that went in, then the whole chain the firmware will run on real
 * writes is correct apart from the PIO and the DMA, which only a floppy bus
 * can exercise.
 *
 * The fixtures are the TypeScript encoder's output, asserted byte-identical to
 * Greaseweazle; the expected data is regenerated here in C. See test_mfm.c.
 */

#define TRACK_MFM_BYTES  12668
#define CELL_NS          2000u
#define ADF_BYTES        901120u

static void xorshift_fill(uint8_t *out, size_t len, size_t from, uint32_t seed) {
    uint32_t x = seed;
    for (size_t i = from; i < len; i++) {
        x ^= x << 13; x ^= x >> 17; x ^= x << 5;
        out[i] = (uint8_t)(x & 0xff);
    }
}

static uint8_t *synthetic_prng(void) {
    uint8_t *out = calloc(ADF_BYTES, 1);
    if (out) xorshift_fill(out, ADF_BYTES, 0, 0x12345678u);
    return out;
}

static int read_fixture(const char *kind, int track_no, uint8_t *out) {
    char path[256];
    snprintf(path, sizeof path,
             "../../../src/lib/adfmfm/fixtures/%s-t%03d.mfm", kind, track_no);
    FILE *f = fopen(path, "rb");
    if (!f) return 0;
    size_t n = fread(out, 1, TRACK_MFM_BYTES, f);
    fclose(f);
    return n == TRACK_MFM_BYTES;
}

static bool bit_at(const uint8_t *b, size_t i) {
    return (b[i >> 3] >> (7 - (i & 7))) & 1u;
}

/** The intervals a drive reading this track would report, in cells. */
static size_t to_intervals(const uint8_t *mfm, size_t bytes, uint32_t *out, size_t cap,
                           uint32_t *max_gap) {
    size_t n = 0;
    size_t prev = SIZE_MAX;
    *max_gap = 0;
    for (size_t i = 0; i < bytes * 8; i++) {
        if (!bit_at(mfm, i)) continue;
        if (prev != SIZE_MAX && n < cap) {
            uint32_t gap = (uint32_t)(i - prev);
            if (gap > *max_gap) *max_gap = gap;
            out[n++] = gap;
        }
        prev = i;
    }
    return n;
}

/* ------------------------------------------------------------------ */
static void test_a_golden_track_survives_the_round_trip(void) {
    uint8_t mfm[TRACK_MFM_BYTES];
    if (!read_fixture("prng", 0, mfm)) { CHECK(0, "fixture"); return; }
    uint8_t *adf = synthetic_prng();

    static uint32_t cells[200000];
    uint32_t max_gap = 0;
    size_t n = to_intervals(mfm, sizeof mfm, cells, (sizeof cells / sizeof cells[0]), &max_gap);

    // A legal MFM stream never goes more than 4 cells without a transition.
    // If this ever fires, the encoder produced something no drive could read
    // back and the round trip below would be measuring the wrong thing.
    CHECK(max_gap <= 4, "no gap in a golden track may exceed 4 cells");
    CHECK(n > 20000, "a track should yield tens of thousands of transitions");

    static uint8_t rebuilt[TRACK_MFM_BYTES + 16];
    flux_bits_t f;
    flux_bits_init(&f, rebuilt, sizeof rebuilt);
    for (size_t i = 0; i < n; i++) flux_bits_feed(&f, cells[i] * CELL_NS);

    CHECK(!f.overflowed, "the rebuilt stream must fit");
    CHECK_EQ_INT(f.out_of_range, 0);

    static uint8_t got[MFM_TRACK_DATA_BYTES];
    memset(got, 0xAA, sizeof got);
    mfm_decode_result_t r;
    mfm_decode_track(rebuilt, flux_bits_bytes(&f), got, &r);

    CHECK_EQ_INT(r.found, 0x7ff);
    CHECK_EQ_INT(r.bad_checksums, 0);
    CHECK_EQ_INT(r.track_no, 0);
    CHECK(memcmp(got, adf, MFM_TRACK_DATA_BYTES) == 0,
          "flux -> bits -> sectors must give back the bytes that were encoded");
    free(adf);
}

static void test_it_tolerates_the_speed_error_a_real_drive_has(void) {
    /*
     * A drive's spindle is not exact and the capture clock is not the drive's.
     * +-8% is far past the couple of percent a real one drifts by, and well
     * inside the 25% margin the bucket thresholds allow -- so every sector
     * must still come back, not merely most of them.
     */
    uint8_t mfm[TRACK_MFM_BYTES];
    if (!read_fixture("bootblock", 1, mfm)) { CHECK(0, "fixture"); return; }
    uint8_t *adf = calloc(ADF_BYTES, 1);
    static const uint8_t dos[4] = { 0x44, 0x4f, 0x53, 0x00 };
    static const uint8_t root[4] = { 0x00, 0x00, 0x03, 0x70 };
    memcpy(adf, dos, 4); memcpy(adf + 8, root, 4);
    xorshift_fill(adf, ADF_BYTES, 12, 0xdeadbeefu);

    static uint32_t cells[200000];
    uint32_t max_gap = 0;
    size_t n = to_intervals(mfm, sizeof mfm, cells, (sizeof cells / sizeof cells[0]), &max_gap);

    for (int pct = -8; pct <= 8; pct += 4) {
        static uint8_t rebuilt[TRACK_MFM_BYTES + 16];
        flux_bits_t f;
        flux_bits_init(&f, rebuilt, sizeof rebuilt);
        uint32_t jitter = 0x2468ace0u;
        for (size_t i = 0; i < n; i++) {
            // A steady skew plus a little per-interval wobble, so this is not
            // just the same scaling applied uniformly.
            jitter ^= jitter << 13; jitter ^= jitter >> 17; jitter ^= jitter << 5;
            int wobble = (int)(jitter % 5) - 2;                 /* +-2% */
            uint32_t ns = cells[i] * CELL_NS;
            ns = (uint32_t)((int64_t)ns * (100 + pct + wobble) / 100);
            flux_bits_feed(&f, ns);
        }
        static uint8_t got[MFM_TRACK_DATA_BYTES];
        memset(got, 0, sizeof got);
        mfm_decode_result_t r;
        mfm_decode_track(rebuilt, flux_bits_bytes(&f), got, &r);
        CHECK_EQ_INT(r.found, 0x7ff);
        CHECK(memcmp(got, adf + 1 * MFM_TRACK_DATA_BYTES, MFM_TRACK_DATA_BYTES) == 0,
              "every sector must survive a realistic speed error");
    }
    free(adf);
}

static void test_overflow_is_reported_not_hidden(void) {
    /* A capture that ran out of room decodes to a track missing its last
       sectors -- which looks exactly like a damaged disk unless the capture
       says it was cut short. */
    uint8_t small[64];
    flux_bits_t f;
    flux_bits_init(&f, small, sizeof small);
    for (int i = 0; i < 10000; i++) flux_bits_feed(&f, 4000);
    CHECK(f.overflowed, "running out of room must be reported");
    CHECK_EQ_INT(flux_bits_bytes(&f), (int)sizeof small);
    CHECK_EQ_INT(f.intervals, 10000);
}

static void test_an_impossible_gap_is_counted(void) {
    /* WGATE going active mid-cell, or a noisy line, produces intervals no
       encoding generates. They are counted so a caller can tell "this is not
       MFM" from "this is MFM with one glitch". */
    uint8_t buf[256];
    flux_bits_t f;
    flux_bits_init(&f, buf, sizeof buf);
    flux_bits_feed(&f, 4000);
    flux_bits_feed(&f, 40000);      /* 20 us: nothing legal is this long */
    flux_bits_feed(&f, 6000);
    CHECK_EQ_INT(f.out_of_range, 1);
    CHECK_EQ_INT(f.intervals, 3);
}

static void test_bit_layout_is_msb_first(void) {
    /* The order bits go down the wire, and the order mfm_decode_track reads
       them. Getting this backwards produces a stream that is byte-reversed
       per byte -- which still "decodes", into nothing. */
    uint8_t buf[4];
    flux_bits_t f;
    flux_bits_init(&f, buf, sizeof buf);
    flux_bits_feed(&f, 4000);       /* 1 then 1 zero  -> 10        */
    flux_bits_feed(&f, 6000);       /* 1 then 2 zeros -> 100       */
    flux_bits_feed(&f, 8000);       /* 1 then 3 zeros -> 1000      */
    /* 10 100 1000 = 1010 0100 0 */
    CHECK_EQ_INT(buf[0], 0xa4);
    CHECK_EQ_INT(f.bit, 9);
}

static void test_counter_to_ns(void) {
    /* The PIO counts DOWN, two cycles per iteration. At 150 MHz one iteration
       is 13.33 ns, so a 4 us gap is ~300 iterations -- and the pushed word is
       the two's complement of that. */
    const uint32_t clk = 150000000u;
    CHECK_EQ_INT(flux_counter_to_ns((uint32_t)-300, clk), 4000);
    CHECK_EQ_INT(flux_counter_to_ns((uint32_t)-450, clk), 6000);
    CHECK_EQ_INT(flux_counter_to_ns((uint32_t)-600, clk), 8000);
}

int main(void) {
    RUN(test_a_golden_track_survives_the_round_trip);
    RUN(test_it_tolerates_the_speed_error_a_real_drive_has);
    RUN(test_overflow_is_reported_not_hidden);
    RUN(test_an_impossible_gap_is_counted);
    RUN(test_bit_layout_is_msb_first);
    RUN(test_counter_to_ns);
    return REPORT();
}
