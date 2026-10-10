/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
#include "harness.h"
#include "../src/pnet_rx.h"
#include "../src/pnet_frame.h"
#include <stdint.h>
#include <string.h>

/*
 * The raw-cell accumulator, fed what flux_in would report for a PaulaNET write: a lead word
 * (arm to first edge), then each gap between pulses, edge to edge MINUS the pulse's low time,
 * with a deterministic jitter.
 */

static uint8_t wire[16384], capbuf[32768], frames[12000], dec[16384];
static uint32_t words[140000];

static size_t to_words(const uint8_t *w, size_t n, uint32_t pw, uint32_t jit, uint32_t *out) {
    size_t k = 0, prev = SIZE_MAX;
    uint32_t seed = 12345u;
    out[k++] = 30000u;                                   /* lead: arm -> first edge */
    for (size_t bit = 0; bit < n * 8u; bit++) {
        if (!((w[bit >> 3] >> (7u - (bit & 7u))) & 1u)) continue;
        if (prev != SIZE_MAX) {
            seed = seed * 1103515245u + 12345u;
            const int32_t j = jit ? (int32_t)((seed >> 16) % (2u * jit + 1u)) - (int32_t)jit : 0;
            out[k++] = (uint32_t)((int32_t)((bit - prev) * PNET_CELL_NS) - (int32_t)pw + j);
        }
        prev = bit;
    }
    return k;
}

static void feed_all(pnet_rx_t *r, const uint32_t *w, size_t n) {
    for (size_t i = 0; i < n; i++) pnet_rx_feed(r, w[i]);
}

static void bytes_after_the_sync_come_back(void) {
    const uint8_t w[] = {0x00, 0x01, 0x00, 0x01, 0x54, 0x50, 0x00, 0x00, 0xFF, 0x01, 0x80, 0x00,
                         0xAA, 0xAA};
    const uint32_t pws[] = {300u, 700u, 1200u};   /* 300 and 1200 per the fix ruling */
    for (unsigned i = 0; i < 3; i++) {
        pnet_rx_t r;
        pnet_rx_init(&r, capbuf, sizeof capbuf);
        const size_t n = to_words(w, sizeof w, pws[i], 0, words);
        feed_all(&r, words, n);
        CHECK(r.sync_ok, "sync found");
        CHECK_EQ_INT(r.pw_ns, (int32_t)pws[i]);
        CHECK(pnet_rx_bytes(&r) >= 10 && memcmp(capbuf, w + 4, 8) == 0, "the 8 bytes after the sync");
        CHECK_EQ_INT(r.out_of_range, 0);
    }
}

/* +-300 ns on every interval, the sync included, against a 1000 ns rounding margin. */
static void jitter_does_not_move_a_bit(void) {
    pnet_frame_ref_t f[6];
    uint32_t x = 77u;
    for (size_t i = 0; i < 8000; i++) { x ^= x << 13; x ^= x >> 17; x ^= x << 5; frames[i] = (uint8_t)x; }
    for (unsigned i = 0; i < 6; i++) { f[i].data = frames + 1500u * i; f[i].len = i < 5 ? 1500 : 500; }
    const size_t wn = pnet_build_to_board(wire, sizeof wire, 9, 0x80, f, 6);
    CHECK(wn > 0, "built");
    pnet_rx_t r;
    pnet_rx_init(&r, capbuf, sizeof capbuf);
    feed_all(&r, words, to_words(wire, wn, 800u, 300u, words));
    CHECK(r.sync_ok && !r.overflowed, "clean capture");
    CHECK(memcmp(capbuf, wire + 4, wn - 4) == 0, "every byte of an 8,000-byte batch");
}

/* The whole Amiga -> board path: build, flux, accumulate, parse. */
static void a_batch_survives_flux_and_parses(void) {
    pnet_frame_ref_t f[3] = {{frames, 64}, {frames + 64, 1500}, {frames + 1564, 7}};
    memset(frames + 1564, 0, 7);
    const size_t wn = pnet_build_to_board(wire, sizeof wire, 0x10, 0x7F, f, 3);
    pnet_rx_t r;
    pnet_rx_init(&r, capbuf, sizeof capbuf);
    feed_all(&r, words, to_words(wire, wn, 600u, 250u, words));
    pnet_hdr_t h;
    CHECK_EQ_INT(pnet_parse_hdr_from_amiga(capbuf, pnet_rx_bytes(&r), &h), PNET_OK);
    CHECK_EQ_INT(h.amiga_ctr, 0x10);
    uint16_t lens[PNET_MAX_FRAMES]; unsigned m = 0;
    CHECK_EQ_INT(pnet_parse_frames(capbuf + PNET_HDR_BYTES, h.compressed_size, PNET_TO_BOARD, dec,
                                   sizeof dec, lens, PNET_MAX_FRAMES, &m), PNET_OK);
    CHECK(m == 3 && memcmp(dec, frames, 1571) == 0, "frames");
}

/* Review Focus 1: a capture armed late (the first sync pulse missed) is refused, not parsed. */
static void a_capture_that_missed_the_first_sync_pulse_is_refused(void) {
    const uint8_t w[] = {0x00, 0x01, 0x00, 0x01, 0x54, 0x50, 0x12, 0x34, 0xAA, 0xAA};
    const size_t n = to_words(w, sizeof w, 600u, 0, words);
    pnet_rx_t r;
    pnet_rx_init(&r, capbuf, sizeof capbuf);
    pnet_rx_feed(&r, 30000u);                     /* lead (arm -> the SECOND sync pulse) */
    feed_all(&r, words + 2, n - 2);               /* word 1 is then a data interval */
    CHECK(!r.sync_ok, "not a 16-cell sync");
    CHECK_EQ_INT(pnet_rx_bytes(&r), 0);
}

static void a_long_gap_is_counted_and_clamped(void) {
    pnet_rx_t r;
    pnet_rx_init(&r, capbuf, sizeof capbuf);
    pnet_rx_feed(&r, 30000u);
    pnet_rx_feed(&r, 31400u);                     /* sync, pw 600 */
    pnet_rx_feed(&r, 70u * 2000u - 600u);
    CHECK_EQ_INT(r.out_of_range, 1);
    CHECK_EQ_INT(r.bit, PNET_RX_MAX_CELLS);
}

static void a_full_buffer_says_so(void) {
    uint8_t small[2];
    pnet_rx_t r;
    pnet_rx_init(&r, small, sizeof small);
    pnet_rx_feed(&r, 30000u);
    pnet_rx_feed(&r, 31400u);
    for (int i = 0; i < 20; i++) pnet_rx_feed(&r, 2000u - 600u);
    CHECK(r.overflowed, "overflowed");
    CHECK_EQ_INT(r.bit, 16);
}

static void a_late_capture_is_refused_whatever_the_pulse_width(void) {
    pnet_rx_t r;
    pnet_rx_init(&r, capbuf, sizeof capbuf);          /* 15-cell gap, pw 300 */
    pnet_rx_feed(&r, 30000u); pnet_rx_feed(&r, 15u * 2000u - 300u);
    for (int i = 0; i < 20; i++) pnet_rx_feed(&r, 1700u);
    CHECK(!r.sync_ok, "15 cells, pw 300"); CHECK_EQ_INT(pnet_rx_bytes(&r), 0);
    pnet_rx_init(&r, capbuf, sizeof capbuf);          /* 17-cell gap, pw 1600 */
    pnet_rx_feed(&r, 30000u); pnet_rx_feed(&r, 17u * 2000u - 1600u);
    for (int i = 0; i < 20; i++) pnet_rx_feed(&r, 400u);
    CHECK(!r.sync_ok, "17 cells, pw 1600"); CHECK_EQ_INT(pnet_rx_bytes(&r), 0);
}

static void a_wgate_blip_decodes_nothing(void) {
    pnet_rx_t r;
    pnet_rx_init(&r, capbuf, sizeof capbuf);
    pnet_rx_feed(&r, 30000u);                         /* one pulse */
    CHECK(!r.sync_ok && pnet_rx_bytes(&r) == 0, "one pulse");
    pnet_rx_feed(&r, 900u);                           /* two pulses, short gap */
    CHECK(!r.sync_ok && pnet_rx_bytes(&r) == 0, "two pulses");
}

static void the_pulse_width_range_edges_are_accepted(void) {
    const unsigned pws[] = {150u, 1700u};
    for (unsigned i = 0; i < 2; i++) {
        pnet_rx_t r;
        pnet_rx_init(&r, capbuf, sizeof capbuf);
        pnet_rx_feed(&r, 30000u); pnet_rx_feed(&r, 16u * 2000u - pws[i]);
        CHECK(r.sync_ok, "edge pw accepted");
    }
}

/* Final review Important 2: init is O(1) (it runs in the WGATE ISR before the PIO starts), so the
 * buffer is cleared lazily. A buffer full of the last capture's bytes must still come back exact,
 * init must not touch it, and word 0 is kept as lead_ns for the refusal log. */
static void a_dirty_buffer_is_cleared_as_bits_land(void) {
    pnet_frame_ref_t f[2] = {{frames, 700}, {frames + 700, 64}};
    memset(frames + 700, 0, 64);                      /* zero runs: bytes with no bit of their own */
    const size_t wn = pnet_build_to_board(wire, sizeof wire, 3, 0x81, f, 2);
    memset(capbuf, 0xA5, sizeof capbuf);
    pnet_rx_t r;
    pnet_rx_init(&r, capbuf, sizeof capbuf);
    CHECK(capbuf[0] == 0xA5 && capbuf[sizeof capbuf - 1] == 0xA5, "init leaves the buffer alone");
    const size_t n = to_words(wire, wn, 900u, 200u, words);
    words[0] = 27613u;                                /* the lead, as a bench capture logs it */
    feed_all(&r, words, n);
    CHECK_EQ_INT(r.lead_ns, 27613);
    const size_t got = pnet_rx_bytes(&r);
    CHECK(got > PNET_HDR_BYTES && got <= wn - 4, "bytes up to the last pulse");
    CHECK(memcmp(capbuf, wire + 4, got) == 0, "every byte up to the last pulse, none of the old");
    CHECK(capbuf[got] == 0xA5, "nothing past the last pulse's byte is touched");
    pnet_hdr_t h;
    CHECK_EQ_INT(pnet_parse_hdr_from_amiga(capbuf, got, &h), PNET_OK);
    uint16_t lens[PNET_MAX_FRAMES]; unsigned m = 0;
    CHECK_EQ_INT(pnet_parse_frames(capbuf + PNET_HDR_BYTES, h.compressed_size, PNET_TO_BOARD, dec,
                                   sizeof dec, lens, PNET_MAX_FRAMES, &m), PNET_OK);
    CHECK(m == 2 && memcmp(dec, frames, 764) == 0, "frames");
}

/*
 * BENCH FIX 1 (2026-10-10). On the A500 the write reaches the board as a run of 2-cell pulses
 * and THEN the 00 01 00 01 sync, and the capture arms (at WGATE) anywhere in that run: the
 * tests above all started at the sync, which no real capture did (68 of 1,000 rounds passed).
 * These build the real batch with pnet_build_to_board, put a lead-in of `lead` bytes of `fill`
 * (AA or 55: the two phases a 2-cell run can end in) below it, and start the interval stream at
 * pulse `from` -- the arm. Word 0 is the arm-to-first-edge lead, as flux_in reports it.
 */
static uint8_t track[16384 + 4096];
static size_t pulses[140000];

static size_t to_pulses(const uint8_t *w, size_t n, size_t *out) {
    size_t k = 0;
    for (size_t bit = 0; bit < n * 8u; bit++)
        if ((w[bit >> 3] >> (7u - (bit & 7u))) & 1u) out[k++] = bit;
    return k;
}

/* Words for an arm just before pulse `from`, with pw and +-jit ns (seeded, deterministic). */
static size_t armed_at(const size_t *p, size_t np, size_t from, uint32_t pw, uint32_t jit,
                       uint32_t seed, uint32_t *out) {
    size_t k = 0;
    out[k++] = 17000u;                                   /* arm -> the first edge seen */
    for (size_t i = from + 1u; i < np; i++) {
        seed = seed * 1103515245u + 12345u;
        const int32_t j = jit ? (int32_t)((seed >> 16) % (2u * jit + 1u)) - (int32_t)jit : 0;
        out[k++] = (uint32_t)((int32_t)((p[i] - p[i - 1u]) * PNET_CELL_NS) - (int32_t)pw + j);
    }
    return k;
}

/* A two-frame batch below `lead` bytes of `fill`; returns the track length, *wn the batch's. */
static size_t lead_track(uint8_t fill, size_t lead, size_t *wn) {
    pnet_frame_ref_t f[2] = {{frames, 900}, {frames + 900, 40}};
    uint32_t x = 99u;
    for (size_t i = 0; i < 900; i++) { x ^= x << 13; x ^= x >> 17; x ^= x << 5; frames[i] = (uint8_t)x; }
    memset(frames + 900, 0, 40);                         /* a zero run: long RLE gaps */
    memset(track, fill, lead);
    *wn = pnet_build_to_board(track + lead, sizeof track - lead, 0x21, 0x80, f, 2);
    return lead + *wn;
}

/* The capture decodes to the batch byte for byte, and parses with both frames. */
static void decodes_and_parses(const pnet_rx_t *r, const uint8_t *batch, size_t wn, uint32_t pw,
                               const char *what) {
    CHECK(r->sync_ok && !r->hunt_failed && !r->overflowed && r->out_of_range == 0, what);
    CHECK(r->pw_ns >= (int32_t)pw - 150 && r->pw_ns <= (int32_t)pw + 150, what);
    const size_t got = pnet_rx_bytes(r);
    CHECK(got > PNET_HDR_BYTES && got <= wn - 4u && memcmp(capbuf, batch + 4, got) == 0, what);
    pnet_hdr_t h;
    CHECK_EQ_INT(pnet_parse_hdr_from_amiga(capbuf, got, &h), PNET_OK);
    CHECK_EQ_INT(h.amiga_ctr, 0x21);
    uint16_t lens[PNET_MAX_FRAMES]; unsigned m = 0;
    CHECK_EQ_INT(pnet_parse_frames(capbuf + PNET_HDR_BYTES, h.compressed_size, PNET_TO_BOARD, dec,
                                   sizeof dec, lens, PNET_MAX_FRAMES, &m), PNET_OK);
    CHECK(m == 2 && lens[0] == 900 && lens[1] == 40 && memcmp(dec, frames, 940) == 0, what);
}

/* (a)-(c): armed at the first lead-in pulse, inside it, and at its last pulse -- AA and 55 leads,
 * pw 300 / 520 / 1200, no jitter and +-150 ns. Every arm decodes to the same bytes. */
static void a_capture_armed_in_the_lead_in_hunts_to_the_sync(void) {
    const uint8_t fills[] = {0xAA, 0x55};
    const uint32_t pws[] = {300u, 520u, 1200u}, jits[] = {0u, 150u};
    for (unsigned fi = 0; fi < 2; fi++) {
        size_t wn;
        const size_t tn = lead_track(fills[fi], PNET_LEAD_BYTES, &wn);
        const size_t np = to_pulses(track, tn, pulses);
        const size_t lead_pulses = PNET_LEAD_BYTES * 4u;   /* AA and 55 each have 4 per byte */
        const size_t froms[] = {0, 1, 7, 123, 240, 401, lead_pulses - 2u, lead_pulses - 1u};
        for (unsigned pi = 0; pi < 3; pi++)
            for (unsigned ji = 0; ji < 2; ji++)
                for (unsigned ai = 0; ai < sizeof froms / sizeof froms[0]; ai++) {
                    pnet_rx_t r;
                    pnet_rx_init(&r, capbuf, sizeof capbuf);
                    feed_all(&r, words, armed_at(pulses, np, froms[ai], pws[pi], jits[ji],
                                                 7u + ai, words));
                    decodes_and_parses(&r, track + PNET_LEAD_BYTES, wn, pws[pi], "armed in the lead-in");
                    /* the lead-in pulses after the arm, the 55 lead's 16-cell last gap included */
                    CHECK_EQ_INT(r.hunt_n, (uint32_t)(lead_pulses - 1u - froms[ai]) + 1u);
                }
    }
}

/* A lead-in of a few words, and the old case: armed after the lead-in, at the first sync pulse. */
static void short_and_absent_lead_ins_still_sync(void) {
    const size_t leads[] = {0, 2, 6};
    for (unsigned li = 0; li < 3; li++) {
        size_t wn;
        const size_t tn = lead_track(0xAA, leads[li], &wn);
        const size_t np = to_pulses(track, tn, pulses);
        pnet_rx_t r;
        pnet_rx_init(&r, capbuf, sizeof capbuf);
        feed_all(&r, words, armed_at(pulses, np, 0, 520u, 150u, 3u, words));
        decodes_and_parses(&r, track + leads[li], wn, 520u, "short lead-in");
    }
    size_t wn;                                           /* armed at the sync's first pulse */
    const size_t tn = lead_track(0xAA, PNET_LEAD_BYTES, &wn);
    const size_t np = to_pulses(track, tn, pulses);
    pnet_rx_t r;
    pnet_rx_init(&r, capbuf, sizeof capbuf);
    feed_all(&r, words, armed_at(pulses, np, PNET_LEAD_BYTES * 4u, 520u, 150u, 5u, words));
    decodes_and_parses(&r, track + PNET_LEAD_BYTES, wn, 520u, "armed at the sync");
    CHECK_EQ_INT(r.hunt_n, 0);
}

/* (d) Review Focus 1 with a lead-in: armed at the sync's second pulse, or anywhere in the data,
 * the capture is never decoded (refused in the hunt), or -- when the data happens to hold a
 * 2-cell run and a 16-cell gap -- decodes to bytes the DataHeader check refuses. */
static void a_capture_armed_after_the_sync_is_refused(void) {
    size_t wn;
    const size_t tn = lead_track(0xAA, PNET_LEAD_BYTES, &wn);
    const size_t np = to_pulses(track, tn, pulses);
    const size_t first = PNET_LEAD_BYTES * 4u + 1u;      /* the sync's second pulse */
    unsigned hunted_out = 0;
    for (size_t from = first; from + 8u < np; from += 37u) {
        pnet_rx_t r;
        pnet_rx_init(&r, capbuf, sizeof capbuf);
        feed_all(&r, words, armed_at(pulses, np, from, 520u, 150u, 11u, words));
        if (!r.sync_ok) {
            CHECK(r.hunt_failed, "refused in the hunt");
            CHECK_EQ_INT(pnet_rx_bytes(&r), 0);
            hunted_out++;
        } else {
            pnet_hdr_t h;
            CHECK(pnet_parse_hdr_from_amiga(capbuf, pnet_rx_bytes(&r), &h) != PNET_OK,
                  "a false sync in the data does not parse");
        }
    }
    CHECK(hunted_out > 0, "data-armed captures are refused in the hunt");
    pnet_rx_t r;                                         /* exactly at the second sync pulse */
    pnet_rx_init(&r, capbuf, sizeof capbuf);
    feed_all(&r, words, armed_at(pulses, np, first, 520u, 0u, 1u, words));
    CHECK(!r.sync_ok && r.hunt_failed && pnet_rx_bytes(&r) == 0, "armed at the second sync pulse");
}

/* (e) A lead-in that runs into a data-like interval instead of a sync, and one that never ends. */
static void a_lead_in_without_a_sync_is_refused(void) {
    const uint32_t bad[] = {2000u - 520u, 3u * 2000u - 520u, 4u * 2000u - 520u,
                            15u * 2000u - 520u, 18u * 2000u - 520u, 200000u};
    for (unsigned i = 0; i < sizeof bad / sizeof bad[0]; i++) {
        pnet_rx_t r;
        pnet_rx_init(&r, capbuf, sizeof capbuf);
        pnet_rx_feed(&r, 17000u);
        for (int k = 0; k < 50; k++) pnet_rx_feed(&r, 2u * 2000u - 520u);
        pnet_rx_feed(&r, bad[i]);
        CHECK(r.hunt_failed && !r.sync_ok, "refused at the first non-lead interval");
        CHECK_EQ_INT(r.sync_ns, bad[i]);
        pnet_rx_feed(&r, 16u * 2000u - 520u);            /* a sync after the refusal changes nothing */
        for (int k = 0; k < 40; k++) pnet_rx_feed(&r, 2u * 2000u - 520u);
        CHECK(!r.sync_ok && pnet_rx_bytes(&r) == 0, "nothing decoded after a refusal");
    }
    pnet_rx_t r;                                         /* the hunt is capped */
    pnet_rx_init(&r, capbuf, sizeof capbuf);
    pnet_rx_feed(&r, 17000u);
    for (uint32_t k = 0; k < PNET_RX_HUNT_MAX; k++) pnet_rx_feed(&r, 2u * 2000u - 520u);
    CHECK(!r.hunt_failed, "the cap itself is hunted");
    pnet_rx_feed(&r, 2u * 2000u - 520u);
    CHECK(r.hunt_failed && !r.sync_ok, "past the cap: refused");
    pnet_rx_feed(&r, 16u * 2000u - 520u);
    CHECK(!r.sync_ok && pnet_rx_bytes(&r) == 0, "no sync after the cap");
}

int main(void) {
    RUN(bytes_after_the_sync_come_back);
    RUN(jitter_does_not_move_a_bit);
    RUN(a_batch_survives_flux_and_parses);
    RUN(a_capture_that_missed_the_first_sync_pulse_is_refused);
    RUN(a_long_gap_is_counted_and_clamped);
    RUN(a_full_buffer_says_so);
    RUN(a_late_capture_is_refused_whatever_the_pulse_width);
    RUN(a_wgate_blip_decodes_nothing);
    RUN(the_pulse_width_range_edges_are_accepted);
    RUN(a_dirty_buffer_is_cleared_as_bits_land);
    RUN(a_capture_armed_in_the_lead_in_hunts_to_the_sync);
    RUN(short_and_absent_lead_ins_still_sync);
    RUN(a_capture_armed_after_the_sync_is_refused);
    RUN(a_lead_in_without_a_sync_is_refused);
    return REPORT();
}
