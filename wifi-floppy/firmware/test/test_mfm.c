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

/* Copy `nbits` bits of src into dst starting `at` bits in. dst is zeroed first. */
static void copy_bits(const uint8_t *src, size_t nbits, uint8_t *dst, size_t dst_bytes, size_t at) {
    memset(dst, 0, dst_bytes);
    for (size_t i = 0; i < nbits && (at + i) / 8 < dst_bytes; i++) {
        if (src[i / 8] & (0x80u >> (i % 8))) dst[(at + i) / 8] |= (uint8_t)(0x80u >> ((at + i) % 8));
    }
}

static void test_a_capture_off_a_byte_boundary_still_decodes(void) {
    /*
     * THE case a real write capture is in, and the byte rotation above cannot
     * model: flux_bits starts the stream at whatever edge came first after
     * WGATE, so the Amiga's bit grid lands at any of eight offsets. On
     * 2026-09-15 the first real writes decoded 10 of 11 sectors or none at all
     * from two captures of the same track whose interval histograms differed
     * by ten intervals in 48,850 -- the signature of alignment, not of flux.
     */
    uint8_t mfm[TRACK_MFM_BYTES], two[TRACK_MFM_BYTES * 2];
    uint8_t cap[TRACK_MFM_BYTES * 2 + 1], got[TRACK_DATA_BYTES];
    if (!read_fixture("prng", 80, mfm)) { CHECK(0, "fixture"); return; }
    uint8_t *adf = synthetic_adf("prng");
    memcpy(two, mfm, TRACK_MFM_BYTES);
    memcpy(two + TRACK_MFM_BYTES, mfm, TRACK_MFM_BYTES);

    for (size_t shift = 1; shift < 8; shift++) {
        copy_bits(two, sizeof two * 8, cap, sizeof cap, shift);
        memset(got, 0xAA, sizeof got);
        mfm_decode_result_t r;
        mfm_decode_track(cap, sizeof cap, got, &r);
        printf("    shift %zu bit(s): found 0x%03x\n", shift, r.found);
        CHECK_EQ_INT(r.found, 0x7ff);
        CHECK_EQ_INT(r.track_no, 80);
        CHECK(memcmp(got, adf + 80u * TRACK_DATA_BYTES, TRACK_DATA_BYTES) == 0,
              "a bit-shifted capture must decode to the same bytes");
    }
    free(adf);
}

static void test_a_one_bit_slip_between_sectors_loses_nothing_after_it(void) {
    /*
     * A capture that loses or gains one cell part-way through -- one interval
     * measured into the wrong bucket in the gap before a sector -- changes the
     * alignment of everything after it. Every sector carries its own sync, so
     * every sector after the slip must still be found.
     */
    uint8_t mfm[TRACK_MFM_BYTES], cap[TRACK_MFM_BYTES + 1], got[TRACK_DATA_BYTES];
    if (!read_fixture("prng", 80, mfm)) { CHECK(0, "fixture"); return; }
    /* Sync of sector 5: find the 6th 0x4489 0x4489 pair at a byte offset. */
    size_t syncs = 0, at = 0;
    for (size_t i = 0; i + 3 < TRACK_MFM_BYTES; i++) {
        if (mfm[i] == 0x44 && mfm[i+1] == 0x89 && mfm[i+2] == 0x44 && mfm[i+3] == 0x89) {
            if (syncs++ == 5) { at = i; break; }
        }
    }
    CHECK(at > 8, "fixture must have a sixth sector sync");
    /* Bits before the slip point copied as-is; one extra 0 cell inserted just
       before the sync's preceding gap byte; the rest shifted by one. */
    const size_t slip = (at - 2) * 8;
    copy_bits(mfm, slip, cap, sizeof cap, 0);
    uint8_t tail[TRACK_MFM_BYTES + 1];
    copy_bits(mfm + (at - 2), (TRACK_MFM_BYTES - (at - 2)) * 8, tail, sizeof tail, 0);
    for (size_t i = 0; i < (TRACK_MFM_BYTES - (at - 2)) * 8; i++) {
        size_t o = slip + 1 + i;
        if (o / 8 >= sizeof cap) break;
        if (tail[i / 8] & (0x80u >> (i % 8))) cap[o / 8] |= (uint8_t)(0x80u >> (o % 8));
    }
    mfm_decode_result_t r;
    mfm_decode_track(cap, sizeof cap, got, &r);
    printf("    slip before sector 5's sync: found 0x%03x\n", r.found);
    CHECK_EQ_INT(r.found, 0x7ff);
    CHECK_EQ_INT(r.bad_checksums, 0);
}

static void test_a_capture_ending_right_after_the_last_sector_keeps_it(void) {
    /*
     * A real write is gap first, then eleven sectors, and WGATE releases as the
     * last data bit goes out -- so the capture ends a few bits past the final
     * sector's data. On 2026-09-15 every capture decoded 10 of 11: the last
     * sector ended at bit 108,980 of 108,992, and the decoder demanded 1,084
     * bytes after a sync when a sector needs 1,080. Tried at every bit shift,
     * since the stream's alignment is arbitrary.
     */
    uint8_t mfm[TRACK_MFM_BYTES], cap[TRACK_MFM_BYTES + 1], got[TRACK_DATA_BYTES];
    if (!read_fixture("prng", 80, mfm)) { CHECK(0, "fixture"); return; }
    size_t last = 0, syncs = 0;
    for (size_t i = 0; i + 3 < TRACK_MFM_BYTES; i++) {
        if (mfm[i] == 0x44 && mfm[i+1] == 0x89 && mfm[i+2] == 0x44 && mfm[i+3] == 0x89) {
            last = i; syncs++; i += 3;
        }
    }
    CHECK_EQ_INT((int)syncs, 11);
    const size_t end_bits = (last + 4 + 1080) * 8;       /* just past the data */
    for (size_t shift = 0; shift < 8; shift++) {
        const size_t len = (end_bits + shift + 7) / 8;
        copy_bits(mfm, end_bits, cap, sizeof cap, shift);
        mfm_decode_result_t r;
        mfm_decode_track(cap, len, got, &r);
        printf("    shift %zu, %zu bytes ending at the last data bit: found 0x%03x\n",
               shift, len, r.found);
        CHECK_EQ_INT(r.found, 0x7ff);
        CHECK_EQ_INT(r.bad_checksums, 0);
    }
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

/* ------------------------------------------------------------------ */
/* The encoder must reproduce the golden tracks BYTE FOR BYTE. They are the
 * TypeScript encoder's output, asserted identical to Greaseweazle -- so this
 * checks the C port against an independent implementation, not itself. */
static void test_encoder_matches_every_golden_track(void) {
    uint8_t want[TRACK_MFM_BYTES];
    static uint8_t got[MFM_TRACK_BYTES];
    for (size_t k = 0; k < sizeof KINDS / sizeof KINDS[0]; k++) {
        uint8_t *adf = synthetic_adf(KINDS[k]);
        for (size_t t = 0; t < sizeof TRACKS_TESTED / sizeof TRACKS_TESTED[0]; t++) {
            int track_no = TRACKS_TESTED[t];
            if (!read_fixture(KINDS[k], track_no, want)) { CHECK(0, "fixture missing"); continue; }
            uint32_t bits = mfm_encode_track(adf + (size_t)track_no * TRACK_DATA_BYTES,
                                             (uint8_t)track_no, got);
            CHECK_EQ_INT(bits, MFM_TRACK_BITS);
            if (memcmp(got, want, TRACK_MFM_BYTES) != 0) {
                size_t i = 0;
                while (got[i] == want[i]) i++;
                printf("  %s track %d: first difference at byte %zu (got %02x want %02x)\n",
                       KINDS[k], track_no, i, got[i], want[i]);
                CHECK(0, "encoded track must equal the golden fixture");
            }
        }
        free(adf);
    }
}

/* encode -> decode gives back every byte, on a track no fixture covers. */
static void test_encode_then_decode_round_trips(void) {
    uint8_t *adf = synthetic_adf("prng");
    static uint8_t mfm[MFM_TRACK_BYTES];
    static uint8_t got[TRACK_DATA_BYTES];
    const int track_no = 97;
    mfm_encode_track(adf + (size_t)track_no * TRACK_DATA_BYTES, (uint8_t)track_no, mfm);
    memset(got, 0, sizeof got);
    mfm_decode_result_t r;
    mfm_decode_track(mfm, sizeof mfm, got, &r);
    CHECK_EQ_INT(r.found, 0x7ff);
    CHECK_EQ_INT(r.bad_checksums, 0);
    CHECK_EQ_INT(r.track_no, track_no);
    CHECK(memcmp(got, adf + (size_t)track_no * TRACK_DATA_BYTES, TRACK_DATA_BYTES) == 0,
          "decode(encode(x)) == x");
    free(adf);
}

/*
 * Review (final), Critical C1: mfm_decode_track kept its working buffer in
 * static storage, and it is now called from BOTH cores -- core0 decodes the
 * Amiga's captured writes, core1's uploader decodes PSRAM tracks to upload
 * and to hash for the close. Two decodes overlapping on one static buffer
 * splice one track's sector body into the other's, and every spliced
 * sector still carries a valid checksum (it is a real sector, just the
 * wrong one), so nothing downstream can catch it.
 *
 * A host test cannot show that race: the host build is single-threaded, so
 * no two decodes ever overlap here. What it CAN pin is the property that
 * removes the race -- every byte of mfm_decode_track_r's mutable working
 * state lives in the scratch its caller hands it. So: decode track A
 * through scratch A, snapshot it, decode track B through scratch B, and
 * require (1) both results right, (2) scratch A byte-identical to its
 * snapshot -- B's decode touched nothing A's decode was using -- and (3)
 * each scratch actually used (not merely ignored in favour of a static).
 */
static void test_decodes_through_separate_scratch_do_not_share_state(void) {
    uint8_t *adf = synthetic_adf("prng");
    static uint8_t mfm_a[MFM_TRACK_BYTES], mfm_b[MFM_TRACK_BYTES];
    static uint8_t got_a[TRACK_DATA_BYTES], got_b[TRACK_DATA_BYTES];
    static uint8_t sa[MFM_DECODE_SCRATCH_BYTES], sb[MFM_DECODE_SCRATCH_BYTES];
    static uint8_t snap[MFM_DECODE_SCRATCH_BYTES];
    const int ta = 12, tb = 140;
    mfm_encode_track(adf + (size_t)ta * TRACK_DATA_BYTES, (uint8_t)ta, mfm_a);
    mfm_encode_track(adf + (size_t)tb * TRACK_DATA_BYTES, (uint8_t)tb, mfm_b);
    memset(sa, 0xa5, sizeof sa);
    memset(sb, 0xa5, sizeof sb);
    mfm_decode_result_t ra, rb;

    mfm_decode_track_r(mfm_a, sizeof mfm_a, got_a, &ra, sa);
    memcpy(snap, sa, sizeof snap);
    uint8_t untouched[MFM_DECODE_SCRATCH_BYTES];
    memset(untouched, 0xa5, sizeof untouched);
    CHECK(memcmp(sa, untouched, sizeof sa) != 0, "scratch A is where A's decode worked");

    mfm_decode_track_r(mfm_b, sizeof mfm_b, got_b, &rb, sb);
    CHECK(memcmp(sa, snap, sizeof sa) == 0, "B's decode left A's scratch alone");
    CHECK(memcmp(sb, untouched, sizeof sb) != 0, "scratch B is where B's decode worked");

    // And the core0 wrapper, over its own static scratch, touches neither.
    static uint8_t got_w[TRACK_DATA_BYTES];
    memcpy(snap, sb, sizeof snap);
    uint8_t snap_a[MFM_DECODE_SCRATCH_BYTES];
    memcpy(snap_a, sa, sizeof snap_a);
    mfm_decode_result_t rw;
    mfm_decode_track(mfm_a, sizeof mfm_a, got_w, &rw);
    CHECK(memcmp(sa, snap_a, sizeof sa) == 0 && memcmp(sb, snap, sizeof sb) == 0,
          "mfm_decode_track uses its own scratch, not a caller's");

    CHECK_EQ_INT(ra.found, 0x7ff); CHECK_EQ_INT(ra.track_no, ta);
    CHECK_EQ_INT(rb.found, 0x7ff); CHECK_EQ_INT(rb.track_no, tb);
    CHECK_EQ_INT(rw.found, 0x7ff);
    CHECK(memcmp(got_a, adf + (size_t)ta * TRACK_DATA_BYTES, TRACK_DATA_BYTES) == 0, "A whole");
    CHECK(memcmp(got_b, adf + (size_t)tb * TRACK_DATA_BYTES, TRACK_DATA_BYTES) == 0, "B whole");
    CHECK(memcmp(got_w, got_a, TRACK_DATA_BYTES) == 0, "wrapper agrees");
    free(adf);
}

int main(void) {
    RUN(test_round_trips_every_golden_track);
    RUN(test_a_capture_starting_mid_track_still_decodes);
    RUN(test_a_capture_off_a_byte_boundary_still_decodes);
    RUN(test_a_one_bit_slip_between_sectors_loses_nothing_after_it);
    RUN(test_a_capture_ending_right_after_the_last_sector_keeps_it);
    RUN(test_a_partial_capture_reports_what_is_missing);
    RUN(test_untouched_sectors_are_left_alone);
    RUN(test_a_corrupted_sector_is_rejected_not_accepted);
    RUN(test_a_false_sync_does_not_swallow_the_next_sector);
    RUN(test_noise_decodes_to_nothing);
    RUN(test_interval_buckets);
    RUN(test_encoder_matches_every_golden_track);
    RUN(test_encode_then_decode_round_trips);
    RUN(test_decodes_through_separate_scratch_do_not_share_state);
    return REPORT();
}
