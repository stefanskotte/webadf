/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
#include "harness.h"
#include "../src/pnet_rx.h"
#include "../src/pnet_frame.h"
#include <stdint.h>
#include <string.h>
#include <stdio.h>

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
 * BENCH FIXES 1 AND 2 (2026-10-10). On the A500 the write reaches the board as a few lead-in
 * pulses (Paula's, replayed from trackdisk's last write) and THEN the 00 01 00 01 sync, and the
 * capture arms (at WGATE) before or among them: the first tests all started at the sync, which no
 * real capture did. These build the real batch with pnet_build_to_board and put a lead-in below it,
 * given as its gaps in cells, the last being the gap to the sync's first pulse. The interval stream
 * starts at pulse `from` -- the arm. Jitter is per EDGE (each pulse moves +-jit, so an interval
 * moves up to +-2 jit), and word 0 is the arm-to-first-edge lead, as flux_in reports them.
 */
static size_t pulses[140000];
static int32_t edge_j[140000];

typedef struct { const char *name; const uint8_t *gaps; size_t n; } lead_t;

/* The batch's pulses, after the lead-in's; returns the count, *sync the sync's first pulse. */
static size_t lead_pulses(const lead_t *l, size_t *wn, size_t *sync) {
    pnet_frame_ref_t f[2] = {{frames, 900}, {frames + 900, 40}};
    uint32_t x = 99u;
    for (size_t i = 0; i < 900; i++) { x ^= x << 13; x ^= x >> 17; x ^= x << 5; frames[i] = (uint8_t)x; }
    memset(frames + 900, 0, 40);                         /* a zero run: long RLE gaps */
    *wn = pnet_build_to_board(wire, sizeof wire, 0x21, 0x80, f, 2);
    size_t k = 0, at = 0;
    for (size_t i = 0; i < l->n; i++) { pulses[k++] = at; at += l->gaps[i]; }
    *sync = k;
    for (size_t bit = 0, first = SIZE_MAX; bit < *wn * 8u; bit++) {
        if (!((wire[bit >> 3] >> (7u - (bit & 7u))) & 1u)) continue;
        if (first == SIZE_MAX) first = bit;
        pulses[k++] = at + (bit - first);
    }
    return k;
}

/* Words for an arm just before pulse `from`: pw, +-jit ns per edge (seeded, deterministic). */
static size_t armed_at(size_t np, size_t from, uint32_t pw, uint32_t jit, uint32_t seed,
                       uint32_t *out) {
    for (size_t i = 0; i < np; i++) {
        seed = seed * 1103515245u + 12345u;
        edge_j[i] = jit ? (int32_t)((seed >> 16) % (2u * jit + 1u)) - (int32_t)jit : 0;
    }
    size_t k = 0;
    out[k++] = 44000u;                                   /* arm -> the first edge seen */
    for (size_t i = from + 1u; i < np; i++)
        out[k++] = (uint32_t)((int32_t)((pulses[i] - pulses[i - 1u]) * PNET_CELL_NS) +
                              edge_j[i] - edge_j[i - 1u] - (int32_t)pw);
    return k;
}

/* The capture decodes to the batch byte for byte, and parses with both frames. */
static int decodes_and_parses(const pnet_rx_t *r, size_t wn) {
    if (!r->sync_ok || r->hunt_failed || r->overflowed || r->out_of_range) return 0;
    const size_t got = pnet_rx_bytes(r);
    if (got <= PNET_HDR_BYTES || got > wn - 4u || memcmp(capbuf, wire + 4, got) != 0) return 0;
    pnet_hdr_t h;
    if (pnet_parse_hdr_from_amiga(capbuf, got, &h) != PNET_OK || h.amiga_ctr != 0x21) return 0;
    uint16_t lens[PNET_MAX_FRAMES]; unsigned m = 0;
    if (pnet_parse_frames(capbuf + PNET_HDR_BYTES, h.compressed_size, PNET_TO_BOARD, dec,
                          sizeof dec, lens, PNET_MAX_FRAMES, &m) != PNET_OK) return 0;
    return m == 2 && lens[0] == 900 && lens[1] == 40 && memcmp(dec, frames, 940) == 0;
}

static uint8_t aa_lead[480], l55_lead[480];
/* The bench's (fix 2): ~5 pulses 2 cells apart, then a 4-cell gap (an AAA8-style word); then
 * either straight to the sync's first pulse, 16 or 17 cells, or more 2-cell pulses first. */
static const uint8_t aaa8_17[] = {2, 2, 2, 2, 4, 17}, aaa8_16[] = {2, 2, 2, 2, 4, 16},
                     aaa8_aa[] = {2, 2, 2, 2, 4, 2, 2, 2, 17}, aaa8_1[] = {2, 2, 2, 2, 4, 1, 3, 17};

/* (a)-(c): armed at EVERY lead-in pulse, at pw 300 / 520 / 1200, no jitter and +-140 ns per edge:
 * every arm decodes byte for byte, and hunt_n counts the intervals before the sync exactly. */
static void a_capture_armed_in_the_lead_in_hunts_to_the_sync(void) {
    for (size_t i = 0; i < 480; i++) { aa_lead[i] = 2; l55_lead[i] = 2; }
    aa_lead[479] = 17;                                   /* AA's last pulse (bit 6) -> 00 01's bit 15 */
    l55_lead[479] = 16;                                  /* 55's last pulse (bit 7) */
    const lead_t leads[] = {
        {"AAAA x120", aa_lead, 480}, {"5555 x120", l55_lead, 480},
        {"AAA8 then 17", aaa8_17, 6}, {"AAA8 then 16", aaa8_16, 6},
        {"AAA8 AA then 17", aaa8_aa, 9}, {"AAA8 1 3 then 17", aaa8_1, 8},
    };
    const uint32_t pws[] = {300u, 520u, 1200u}, jits[] = {0u, 140u};
    for (unsigned li = 0; li < sizeof leads / sizeof leads[0]; li++) {
        size_t wn, sync;
        const size_t np = lead_pulses(&leads[li], &wn, &sync);
        unsigned bad = 0, badhunt = 0, runs = 0;
        for (unsigned pi = 0; pi < 3; pi++)
            for (unsigned ji = 0; ji < 2; ji++)
                for (size_t from = 0; from <= sync; from++) {     /* every lead pulse, and the sync's */
                    pnet_rx_t r;
                    pnet_rx_init(&r, capbuf, sizeof capbuf);
                    feed_all(&r, words, armed_at(np, from, pws[pi], jits[ji],
                                                 (uint32_t)(7u + from + 1000u * pi), words));
                    runs++;
                    if (!decodes_and_parses(&r, wn)) {
                        if (bad++ < 3) printf("    %s pw %u jit %u from %zu: sync_ok %d failed %d "
                                              "sync %u hunt %u\n", leads[li].name,
                                              (unsigned)pws[pi], (unsigned)jits[ji], from,
                                              r.sync_ok, r.hunt_failed, (unsigned)r.sync_ns,
                                              (unsigned)r.hunt_n);
                    }
                    if (r.hunt_n != sync - from) badhunt++;
                }
        CHECK(runs > 0 && bad == 0, leads[li].name);
        CHECK(badhunt == 0, "hunt_n is the intervals before the sync");
    }
}

/* A 0000 word (32/33 cells) or any 18+ cell gap between the lead-in and the sync is refused. */
static void a_long_gap_before_the_sync_is_refused(void) {
    const uint8_t g32[] = {2, 2, 2, 2, 4, 32}, g33[] = {2, 2, 2, 33}, g18[] = {2, 2, 2, 2, 18};
    const lead_t leads[] = {{"0000 word, 32", g32, 6}, {"0000 word, 33", g33, 4}, {"18 cells", g18, 5}};
    for (unsigned li = 0; li < 3; li++) {
        size_t wn, sync;
        const size_t np = lead_pulses(&leads[li], &wn, &sync);
        unsigned ok = 0;
        for (size_t from = 0; from + 1u < sync; from++) {
            pnet_rx_t r;
            pnet_rx_init(&r, capbuf, sizeof capbuf);
            feed_all(&r, words, armed_at(np, from, 520u, 140u, 3u + from, words));
            ok += r.hunt_failed && !r.sync_ok && pnet_rx_bytes(&r) == 0;
        }
        CHECK(ok == sync - 1u, leads[li].name);
    }
}

/* (d) Review Focus 1: armed after the sync's first pulse -- at its second, or anywhere in the
 * data -- a capture may hunt, but never PARSES: it finds no sync (0 bytes), or a false one the
 * DataHeader's magic and checksum refuse. Every pulse of the batch is tried. */
static void a_capture_armed_after_the_sync_never_parses(void) {
    size_t wn, sync;
    const lead_t l = {"AAA8 then 17", aaa8_17, 6};
    const size_t np = lead_pulses(&l, &wn, &sync);
    unsigned parsed = 0, falsesync = 0, tried = 0;
    for (size_t from = sync + 1u; from + 2u < np; from++) {
        pnet_rx_t r;
        pnet_rx_init(&r, capbuf, sizeof capbuf);
        feed_all(&r, words, armed_at(np, from, 520u, 140u, 11u + from, words));
        tried++;
        if (!r.sync_ok) { parsed += pnet_rx_bytes(&r) != 0; continue; }
        falsesync++;
        pnet_hdr_t h;
        parsed += pnet_parse_hdr_from_amiga(capbuf, pnet_rx_bytes(&r), &h) == PNET_OK;
    }
    printf("    %u data arms, %u took a false sync, %u parsed\n", tried, falsesync, parsed);
    CHECK(tried > 1000u && parsed == 0, "no data-armed capture parses");
    /* None of those happened to meet a 16-cell gap, so force one: a 16-cell interval just before
     * each arm in the data is a false sync at the wrong alignment, and the header refuses it. */
    unsigned forced = 0, fparsed = 0;
    for (size_t from = sync + 2u; from + 2u < np; from += 7u) {   /* sync + 1 IS the alignment */
        const size_t n = armed_at(np, from, 520u, 140u, 13u + from, words + 1);
        words[0] = 44000u;
        words[1] = 16u * 2000u - 520u;                   /* the false sync */
        pnet_rx_t r;
        pnet_rx_init(&r, capbuf, sizeof capbuf);
        feed_all(&r, words, n + 1u);
        if (!r.sync_ok) continue;
        forced++;
        pnet_hdr_t h;
        if (pnet_parse_hdr_from_amiga(capbuf, pnet_rx_bytes(&r), &h) == PNET_OK) {
            fparsed++;
            printf("    forced false sync at pulse %zu parsed\n", from);
        }
    }
    printf("    %u forced false syncs, %u parsed\n", forced, fparsed);
    CHECK(forced > 300u && fparsed == 0, "a false sync in the data never parses");
}

/* (e) The hunt passes 1..17-cell intervals and refuses past the 17-cell window; it is capped. */
static void the_hunt_refuses_only_long_gaps_and_ends(void) {
    const uint32_t pass[] = {2000u - 520u, 3u * 2000u - 520u, 4u * 2000u - 520u,
                             15u * 2000u - 520u, 17u * 2000u - 520u, PNET_RX_GAP17_MAX_NS};
    for (unsigned i = 0; i < sizeof pass / sizeof pass[0]; i++) {
        pnet_rx_t r;
        pnet_rx_init(&r, capbuf, sizeof capbuf);
        pnet_rx_feed(&r, 44000u);
        pnet_rx_feed(&r, 2u * 2000u - 520u);
        pnet_rx_feed(&r, pass[i]);
        CHECK(!r.hunt_failed && !r.sync_ok, "hunted through");
        pnet_rx_feed(&r, 16u * 2000u - 520u);
        CHECK(r.sync_ok && r.pw_ns == 520, "then the sync");
    }
    const uint32_t bad[] = {PNET_RX_GAP17_MAX_NS + 1u, 18u * 2000u - 520u, 32u * 2000u - 520u,
                            200000u};
    for (unsigned i = 0; i < sizeof bad / sizeof bad[0]; i++) {
        pnet_rx_t r;
        pnet_rx_init(&r, capbuf, sizeof capbuf);
        pnet_rx_feed(&r, 44000u);
        for (int k = 0; k < 5; k++) pnet_rx_feed(&r, 2u * 2000u - 520u);
        pnet_rx_feed(&r, bad[i]);
        CHECK(r.hunt_failed && !r.sync_ok, "refused past the 17-cell window");
        CHECK_EQ_INT(r.sync_ns, bad[i]);
        CHECK_EQ_INT(r.hunt_n, 6);
        pnet_rx_feed(&r, 16u * 2000u - 520u);            /* a sync after the refusal changes nothing */
        for (int k = 0; k < 40; k++) pnet_rx_feed(&r, 2u * 2000u - 520u);
        CHECK(!r.sync_ok && pnet_rx_bytes(&r) == 0, "nothing decoded after a refusal");
    }
    pnet_rx_t r;                                         /* the hunt is capped */
    pnet_rx_init(&r, capbuf, sizeof capbuf);
    pnet_rx_feed(&r, 44000u);
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
    RUN(a_long_gap_before_the_sync_is_refused);
    RUN(a_capture_armed_after_the_sync_never_parses);
    RUN(the_hunt_refuses_only_long_gaps_and_ends);
    return REPORT();
}
