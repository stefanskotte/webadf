#include "harness.h"
#include "../src/mfm.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

/*
 * The write path's decoder, checked against an INDEPENDENT encoder.
 *
 * The fixtures are the committed golden tracks in src/lib/adfmfm/fixtures --
 * output of the TypeScript encoder, which src/lib/adfmfm/track.test.ts asserts
 * is byte-identical to Greaseweazle's amigados codec. So the chain is:
 * Greaseweazle encoded it, the TS encoder reproduces it byte for byte, and
 * this decoder has to turn it back into the bytes that went in -- which are
 * regenerated HERE, in C, rather than read from a file.
 *
 * That last part is the point. If the expected data came out of the same
 * fixture directory, this would only prove the decoder is the inverse of
 * whatever produced them. Reproducing the source disk independently (the
 * xorshift32 in synthetic.ts, whose comment says it was chosen to reproduce
 * identically in another language) makes both ends of the round trip
 * independent of this file.
 */

#define TRACK_MFM_BYTES 12668
#define TRACK_DATA_BYTES MFM_TRACK_DATA_BYTES

/* src/lib/adfmfm/synthetic.ts, reproduced. Same seeds, same sequence. */
static void xorshift_fill(uint8_t *out, size_t len, size_t from, uint32_t seed) {
    uint32_t x = seed;
    for (size_t i = from; i < len; i++) {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        out[i] = (uint8_t)(x & 0xff);
    }
}

#define ADF_BYTES 901120u

static uint8_t *synthetic_adf(const char *kind) {
    uint8_t *out = calloc(ADF_BYTES, 1);
    if (!kind || !out) return out;
    if (!strcmp(kind, "zeros")) return out;
    if (!strcmp(kind, "ones")) { memset(out, 0xff, ADF_BYTES); return out; }
    if (!strcmp(kind, "prng")) { xorshift_fill(out, ADF_BYTES, 0, 0x12345678u); return out; }
    if (!strcmp(kind, "bootblock")) {
        static const uint8_t dos[4] = { 0x44, 0x4f, 0x53, 0x00 };
        static const uint8_t root[4] = { 0x00, 0x00, 0x03, 0x70 };
        memcpy(out, dos, 4);
        memcpy(out + 8, root, 4);
        xorshift_fill(out, ADF_BYTES, 12, 0xdeadbeefu);
        return out;
    }
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

static const char *KINDS[] = { "zeros", "ones", "prng", "bootblock" };
static const int TRACKS_TESTED[] = { 0, 1, 80, 159 };

/* ------------------------------------------------------------------ */
static void test_round_trips_every_golden_track(void) {
    uint8_t mfm[TRACK_MFM_BYTES];
    uint8_t got[TRACK_DATA_BYTES];

    for (size_t k = 0; k < sizeof KINDS / sizeof KINDS[0]; k++) {
        uint8_t *adf = synthetic_adf(KINDS[k]);
        for (size_t t = 0; t < sizeof TRACKS_TESTED / sizeof TRACKS_TESTED[0]; t++) {
            int track_no = TRACKS_TESTED[t];
            if (!read_fixture(KINDS[k], track_no, mfm)) {
                printf("  FAIL missing fixture %s-t%03d.mfm\n", KINDS[k], track_no);
                CHECK(0, "fixture must be readable");
                continue;
            }
            memset(got, 0xAA, sizeof got);      /* poison: decode must fill it */
            mfm_decode_result_t r;
            mfm_decode_track(mfm, sizeof mfm, got, &r);

            CHECK_EQ_INT(r.found, 0x7ff);       /* all 11 sectors */
            CHECK_EQ_INT(r.bad_checksums, 0);
            CHECK_EQ_INT(r.track_no, track_no);
            CHECK(r.track_no_consistent, "every sector must name the same track");
            CHECK(memcmp(got, adf + (size_t)track_no * TRACK_DATA_BYTES,
                         TRACK_DATA_BYTES) == 0,
                  "decoded bytes must equal the bytes that were encoded");
        }
        free(adf);
    }
}

static void test_a_capture_starting_mid_track_still_decodes(void) {
    /*
     * THE case the web-side decoder never has to handle. A real capture begins
     * wherever the head happened to be when WGATE went active, so the first
     * sync is not at the start and the last sector is cut in half. Rotating
     * the fixture models exactly that.
     */
    uint8_t mfm[TRACK_MFM_BYTES], rot[TRACK_MFM_BYTES * 2], got[TRACK_DATA_BYTES];
    if (!read_fixture("prng", 0, mfm)) { CHECK(0, "fixture"); return; }
    uint8_t *adf = synthetic_adf("prng");

    for (int shift = 0; shift < TRACK_MFM_BYTES; shift += 997) {   /* prime-ish stride */
        /* One and a bit revolutions, starting `shift` bytes in -- which is
           what the firmware must capture for every sector to appear whole. */
        for (int i = 0; i < TRACK_MFM_BYTES * 2; i++) {
            rot[i] = mfm[(shift + i) % TRACK_MFM_BYTES];
        }
        memset(got, 0xAA, sizeof got);
        mfm_decode_result_t r;
        mfm_decode_track(rot, sizeof rot, got, &r);
        CHECK_EQ_INT(r.found, 0x7ff);
        CHECK(memcmp(got, adf, TRACK_DATA_BYTES) == 0,
              "a mid-track capture must decode to the same bytes");
    }
    free(adf);
}

static void test_a_partial_capture_reports_what_is_missing(void) {
    /* Half a revolution cannot contain 11 sectors. The decoder must say which
       it got rather than claim a track, because the caller's choice between
       "retry" and "this disk is damaged" depends on that answer. */
    uint8_t mfm[TRACK_MFM_BYTES], got[TRACK_DATA_BYTES];
    if (!read_fixture("prng", 0, mfm)) { CHECK(0, "fixture"); return; }

    memset(got, 0, sizeof got);
    mfm_decode_result_t r;
    mfm_decode_track(mfm, TRACK_MFM_BYTES / 2, got, &r);
    CHECK(r.found != 0, "half a track still yields some sectors");
    CHECK(r.found != 0x7ff, "but must not claim a complete track");
}

static void test_untouched_sectors_are_left_alone(void) {
    /* Sectors that were not recovered keep whatever the caller had, so a
       partial read updates only what it actually saw instead of blanking the
       rest of the track. */
    uint8_t mfm[TRACK_MFM_BYTES], got[TRACK_DATA_BYTES];
    if (!read_fixture("prng", 0, mfm)) { CHECK(0, "fixture"); return; }
    memset(got, 0x5A, sizeof got);
    mfm_decode_result_t r;
    mfm_decode_track(mfm, 3000, got, &r);          /* a couple of sectors */
    for (int s = 0; s < MFM_SECTORS; s++) {
        if (r.found & (1u << s)) continue;
        for (int i = 0; i < MFM_SECTOR_DATA_BYTES; i++) {
            if (got[s * MFM_SECTOR_DATA_BYTES + i] != 0x5A) {
                CHECK(0, "an unrecovered sector must not be overwritten");
                return;
            }
        }
    }
    CHECK(1, "unrecovered sectors preserved");
}

static void test_a_corrupted_sector_is_rejected_not_accepted(void) {
    /* One flipped bit inside the data of sector 3. Its checksum must fail and
       the sector must NOT land in the output -- a silently accepted bad
       sector is a corrupted disk image that nothing downstream can detect. */
    uint8_t mfm[TRACK_MFM_BYTES], got[TRACK_DATA_BYTES];
    if (!read_fixture("prng", 0, mfm)) { CHECK(0, "fixture"); return; }

    /* Sector n starts at 256 + n*1088; data begins 60 bytes in. */
    const int at = 256 + 3 * MFM_SECTOR_MFM_BYTES + 60 + 100;
    mfm[at] ^= 0x11;        /* flip bits in the 0x55 data lanes only */

    memset(got, 0, sizeof got);
    mfm_decode_result_t r;
    mfm_decode_track(mfm, sizeof mfm, got, &r);
    CHECK((r.found & (1u << 3)) == 0, "a sector failing its checksum must be dropped");
    CHECK(r.bad_checksums > 0, "and must be counted");
    CHECK_EQ_INT(r.found, 0x7ff & ~(1u << 3));
}

static void test_a_false_sync_does_not_swallow_the_next_sector(void) {
    /*
     * Found by mutation: striding a whole sector after a candidate that FAILED
     * passed every other test here, because none of them put a sync anywhere
     * the scan would meet it out of alignment.
     *
     * Getting this test to bite took two goes, and the first version is worth
     * describing because it looked right: corrupt sector 2 and plant a false
     * sync inside its data. That proves nothing. The scan meets sector 2's
     * REAL sync first, and 1088 bytes from there lands exactly on sector 3's
     * sync -- so the bad stride is indistinguishable from the good one. The
     * fault only shows when the scan meets a sync while UNALIGNED, which means
     * sector 2's real sync has to be destroyed as well.
     *
     * A 0x4489 cannot occur in legally encoded data -- it breaks the MFM clock
     * rule on purpose, which is how Paula locks onto it -- but a damaged or
     * half-written track can contain anything, and only a sector that actually
     * verified may earn the long stride.
     */
    uint8_t mfm[TRACK_MFM_BYTES], got[TRACK_DATA_BYTES];
    if (!read_fixture("prng", 0, mfm)) { CHECK(0, "fixture"); return; }

    const int sec2 = 256 + 2 * MFM_SECTOR_MFM_BYTES;   /* 2432 */
    const int sec3 = 256 + 3 * MFM_SECTOR_MFM_BYTES;   /* 3520 */

    /* Destroy sector 2's sync, so the scan runs on unaligned... */
    mfm[sec2] = 0x00; mfm[sec2 + 1] = 0x00;
    /* ...and plant a false one 500 bytes short of sector 3's, close enough
       that a full-sector stride from it clears sector 3 entirely. */
    const int fake = sec3 - 500;
    mfm[fake] = 0x44; mfm[fake + 1] = 0x89; mfm[fake + 2] = 0x44; mfm[fake + 3] = 0x89;

    memset(got, 0, sizeof got);
    mfm_decode_result_t r;
    mfm_decode_track(mfm, sizeof mfm, got, &r);

    CHECK((r.found & (1u << 2)) == 0, "the sector whose sync was destroyed is lost");
    CHECK((r.found & (1u << 3)) != 0, "but the sector after the FALSE sync must survive");
    CHECK_EQ_INT(r.found, 0x7ff & ~(1u << 2));
}

static void test_noise_decodes_to_nothing(void) {
    /* A capture taken with no disk, or during a seek, is noise. It must
       produce no sectors rather than occasional plausible ones. */
    uint8_t noise[TRACK_MFM_BYTES], got[TRACK_DATA_BYTES];
    uint32_t x = 0xc0ffee;
    for (size_t i = 0; i < sizeof noise; i++) {
        x ^= x << 13; x ^= x >> 17; x ^= x << 5;
        noise[i] = (uint8_t)x;
    }
    memset(got, 0, sizeof got);
    mfm_decode_result_t r;
    mfm_decode_track(noise, sizeof noise, got, &r);
    CHECK_EQ_INT(r.found, 0);
}

static void test_interval_buckets(void) {
    /*
     * 4, 6 and 8 us are the only gaps Amiga MFM produces, and the thresholds
     * sit at the midpoints so each has a full 1 us of margin.
     *
     * The tolerance tested is +-10%, NOT the +-20% this test first claimed:
     * at +-20% the bands overlap (6 us +20% = 7200, 8 us -20% = 6400), so no
     * threshold could satisfy it and the assertion was demanding something
     * impossible rather than something safe. Real drive speed varies by a
     * couple of percent, so 10% is already generous by a wide margin.
     */
    CHECK_EQ_INT(mfm_interval_to_bits(4000), 2);
    CHECK_EQ_INT(mfm_interval_to_bits(6000), 3);
    CHECK_EQ_INT(mfm_interval_to_bits(8000), 4);

    CHECK_EQ_INT(mfm_interval_to_bits(3600), 2);   /* 4us -10% */
    CHECK_EQ_INT(mfm_interval_to_bits(4400), 2);   /* 4us +10% */
    CHECK_EQ_INT(mfm_interval_to_bits(5400), 3);   /* 6us -10% */
    CHECK_EQ_INT(mfm_interval_to_bits(6600), 3);   /* 6us +10% */
    CHECK_EQ_INT(mfm_interval_to_bits(7200), 4);   /* 8us -10% */
    CHECK_EQ_INT(mfm_interval_to_bits(8800), 4);   /* 8us +10% */
}

int main(void) {
    RUN(test_round_trips_every_golden_track);
    RUN(test_a_capture_starting_mid_track_still_decodes);
    RUN(test_a_partial_capture_reports_what_is_missing);
    RUN(test_untouched_sectors_are_left_alone);
    RUN(test_a_corrupted_sector_is_rejected_not_accepted);
    RUN(test_a_false_sync_does_not_swallow_the_next_sector);
    RUN(test_noise_decodes_to_nothing);
    RUN(test_interval_buckets);
    return REPORT();
}
