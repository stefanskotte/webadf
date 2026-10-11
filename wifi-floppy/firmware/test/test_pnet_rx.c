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

/* Was Review Focus 1's "a capture that missed the first sync pulse is refused". Bench fix 3 ruled
 * the other way: armed between the sync's pulses, the sync is implied and the batch decodes. */
static void a_capture_that_missed_the_first_sync_pulse_is_implied(void) {
    const uint8_t w[] = {0x00, 0x01, 0x00, 0x01, 0x54, 0x50, 0x12, 0x34, 0xAA, 0xAA};
    const size_t n = to_words(w, sizeof w, 600u, 0, words);
    pnet_rx_t r;
    pnet_rx_init(&r, capbuf, sizeof capbuf);
    pnet_rx_feed(&r, 30000u);                     /* lead (arm -> the SECOND sync pulse) */
    feed_all(&r, words + 2, n - 2);               /* word 1 is then the first data interval */
    CHECK(r.sync_ok && r.implied, "implied");
    CHECK_EQ_INT(r.pw_ns, 600);
    CHECK(pnet_rx_bytes(&r) >= 4 && memcmp(capbuf, w + 4, 4) == 0, "the bytes after the sync");
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
    /* arm -> the first edge seen: 3 us, under PNET_RX_IMPLIED_LEAD_NS, so these exercise the hunt.
     * (Armed 8+ us before a 2-cell lead-in pulse, a capture would take an implied sync at the wrong
     * place and the header would refuse it: bench fix 3 found the write has no lead-in at all.) */
    out[k++] = 3000u;
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
    for (size_t from = sync + 2u; from + 2u < np; from++) {   /* sync + 1 is the implied sync */
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
        words[0] = 3000u;
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
        pnet_rx_feed(&r, 3000u);
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
        pnet_rx_feed(&r, 3000u);
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
    pnet_rx_feed(&r, 3000u);
    for (uint32_t k = 0; k < PNET_RX_HUNT_MAX; k++) pnet_rx_feed(&r, 2u * 2000u - 520u);
    CHECK(!r.hunt_failed, "the cap itself is hunted");
    pnet_rx_feed(&r, 2u * 2000u - 520u);
    CHECK(r.hunt_failed && !r.sync_ok, "past the cap: refused");
    pnet_rx_feed(&r, 16u * 2000u - 520u);
    CHECK(!r.sync_ok && pnet_rx_bytes(&r) == 0, "no sync after the cap");
}

/*
 * BENCH FIX 3 (2026-10-10). The to-board write has no lead-in: Paula starts NetLoop's buffer at
 * 00 01 00 01, and the arm lands ~20-30 us late -- mostly between the sync's two pulses. These place
 * the arm in TIME: edge i is at pulse i's cell x 2000 ns + its jitter; word 0 is the arm to the
 * first falling edge after it (0 when armed inside a pulse's low time, as flux_in pushes at once
 * and then counts the next interval from the rising edge); later words are edge to edge less pw.
 */
static int64_t edge_ns[140000];

static size_t armed_at_time(size_t np, int64_t t_arm, uint32_t pw, uint32_t jit, uint32_t seed,
                            uint32_t *out) {
    for (size_t i = 0; i < np; i++) {
        seed = seed * 1103515245u + 12345u;
        const int32_t j = jit ? (int32_t)((seed >> 16) % (2u * jit + 1u)) - (int32_t)jit : 0;
        edge_ns[i] = (int64_t)pulses[i] * PNET_CELL_NS + j;
    }
    size_t k = 0, i = 0;
    while (i < np && edge_ns[i] + (int64_t)pw <= t_arm) i++;    /* edges whose pulse is over */
    if (i == np) return 0;
    if (edge_ns[i] <= t_arm) out[k++] = 0u;                     /* armed in pulse i's low time */
    else out[k++] = (uint32_t)(edge_ns[i] - t_arm);
    for (i++; i < np; i++) out[k++] = (uint32_t)(edge_ns[i] - edge_ns[i - 1u] - (int64_t)pw);
    return k;
}

static const lead_t no_lead = {"no lead-in", NULL, 0};

/* (a) armed before the sync's first pulse: the measured sync, not implied. */
static void armed_before_pulse_1_syncs_by_measure(void) {
    size_t wn, sync;
    const size_t np = lead_pulses(&no_lead, &wn, &sync);
    const uint32_t pws[] = {300u, 520u, 1200u};
    const int64_t before[] = {-30000, -12000, -8000, -3000, -500, -50};
    for (unsigned pi = 0; pi < 3; pi++)
        for (unsigned ai = 0; ai < sizeof before / sizeof before[0]; ai++) {
            pnet_rx_t r;
            pnet_rx_init(&r, capbuf, sizeof capbuf);
            const size_t n = armed_at_time(np, before[ai] - 140, pws[pi], 140u, 5u + ai, words);
            feed_all(&r, words, n);
            CHECK(decodes_and_parses(&r, wn) && !r.implied && r.hunt_n == 0, "measured sync");
        }
}

/* (b) armed between the two sync pulses, word 0 >= PNET_RX_IMPLIED_LEAD_NS: the implied sync, and
 * the batch byte for byte. Also armed inside pulse 1's low time: word 1 is then the sync itself. */
static void armed_between_the_sync_pulses_syncs_by_implication(void) {
    size_t wn, sync;
    const size_t np = lead_pulses(&no_lead, &wn, &sync);
    const uint32_t pws[] = {300u, 520u, 1200u}, jits[] = {0u, 140u};
    unsigned implied = 0, runs = 0, bad = 0;
    for (unsigned pi = 0; pi < 3; pi++)
        for (unsigned ji = 0; ji < 2; ji++)
            /* the arm from just after pulse 1 ends to 8 us (+ jitter) before pulse 2 */
            for (int64_t t = (int64_t)pws[pi] + 2 * jits[ji] + 1;
                 t <= 32000 - (int64_t)PNET_RX_IMPLIED_LEAD_NS - 2 * (int64_t)jits[ji]; t += 997) {
                pnet_rx_t r;
                pnet_rx_init(&r, capbuf, sizeof capbuf);
                feed_all(&r, words, armed_at_time(np, t, pws[pi], jits[ji], 9u + (uint32_t)t, words));
                runs++;
                implied += r.implied;
                if (!decodes_and_parses(&r, wn) || !r.implied) {
                    if (bad++ < 3) printf("    pw %u jit %u arm %lld: lead %u sync_ok %d imp %d\n",
                                          (unsigned)pws[pi], (unsigned)jits[ji], (long long)t,
                                          (unsigned)r.lead_ns, r.sync_ok, r.implied);
                }
                CHECK(r.pw_ns >= (int32_t)pws[pi] - 280 && r.pw_ns <= (int32_t)pws[pi] + 280,
                      "pw from the first data interval");
            }
    printf("    %u arms between the sync pulses, %u implied\n", runs, implied);
    CHECK(runs > 100u && bad == 0, "every arm between the pulses decodes, by implication");
    for (unsigned pi = 0; pi < 3; pi++) {                /* inside pulse 1's low time */
        pnet_rx_t r;
        pnet_rx_init(&r, capbuf, sizeof capbuf);
        feed_all(&r, words, armed_at_time(np, (int64_t)pws[pi] / 2, pws[pi], 0u, 1u, words));
        CHECK(decodes_and_parses(&r, wn) && !r.implied, "armed in pulse 1: the measured sync");
    }
}

/* (c) armed between the pulses but under PNET_RX_IMPLIED_LEAD_NS before pulse 2: not implied. It
 * HUNTS (the magic's 2,2,2,4,2... are all short), and ends refused at an 18+ cell gap, or with no
 * sync, or on a false 16-cell sync the header refuses: it never parses. */
static void armed_too_close_to_pulse_2_hunts_and_never_parses(void) {
    size_t wn, sync;
    const size_t np = lead_pulses(&no_lead, &wn, &sync);
    const uint32_t pws[] = {300u, 520u, 1200u};
    unsigned runs = 0, parsed = 0, failed = 0;
    for (unsigned pi = 0; pi < 3; pi++)
        for (int64_t lead = 300; lead < (int64_t)PNET_RX_IMPLIED_LEAD_NS - 300; lead += 500) {
            pnet_rx_t r;
            pnet_rx_init(&r, capbuf, sizeof capbuf);
            const size_t n = armed_at_time(np, 32000 - lead, pws[pi], 0u, 1u, words);
            feed_all(&r, words, n);
            runs++;
            CHECK(!r.implied, "not implied under the threshold");
            failed += r.hunt_failed;
            pnet_hdr_t h;
            parsed += r.sync_ok && pnet_parse_hdr_from_amiga(capbuf, pnet_rx_bytes(&r), &h) == PNET_OK;
        }
    printf("    %u arms too close to pulse 2: %u refused in the hunt, %u parsed\n", runs, failed, parsed);
    CHECK(parsed == 0, "an arm too close to pulse 2 never parses");
}

/* (d) armed anywhere in the data, in time steps: may hunt or be implied, never parses. */
static void armed_in_the_data_never_parses_implied_or_not(void) {
    size_t wn, sync;
    const size_t np = lead_pulses(&no_lead, &wn, &sync);
    unsigned runs = 0, implied = 0, parsed = 0;
    const int64_t end = (int64_t)pulses[np - 2u] * PNET_CELL_NS;
    for (int64_t t = 32000 + 600; t < end; t += 1373) {
        pnet_rx_t r;
        pnet_rx_init(&r, capbuf, sizeof capbuf);
        feed_all(&r, words, armed_at_time(np, t, 520u, 140u, 21u + (uint32_t)t, words));
        runs++;
        implied += r.implied;
        pnet_hdr_t h;
        parsed += r.sync_ok && pnet_parse_hdr_from_amiga(capbuf, pnet_rx_bytes(&r), &h) == PNET_OK;
    }
    printf("    %u data arms: %u implied, %u parsed\n", runs, implied, parsed);
    CHECK(runs > 3000u && implied > 0u && parsed == 0, "no data arm parses, implied ones included");
}

/*
 * THE PRE-ARM (2026-10-10). Armed from core0's loop ahead of the write, the capture sees every edge:
 * word 0 is however long WDATA sat idle (anything, flux_in's count wraps), and the first edge is the
 * write's first pulse. It syncs by measure, never by implication -- a 2-cell lead-in pulse after a
 * long idle must not be taken for the magic.
 */
static void a_prearmed_capture_syncs_by_measure_whatever_the_idle(void) {
    size_t wn, sync;
    const size_t np = lead_pulses(&no_lead, &wn, &sync);
    const uint32_t pws[] = {300u, 520u, 1200u};
    const int64_t idle[] = {-40000, -1000000, -4000000000LL};    /* 40 us, 1 ms, 4 s ahead */
    for (unsigned pi = 0; pi < 3; pi++)
        for (unsigned ii = 0; ii < 3; ii++) {
            pnet_rx_t r;
            pnet_rx_init(&r, capbuf, sizeof capbuf);
            r.prearmed = true;
            const size_t n = armed_at_time(np, idle[ii], pws[pi], 140u, 3u + ii, words);
            feed_all(&r, words, n);
            CHECK(decodes_and_parses(&r, wn) && !r.implied && r.hunt_n == 0, "measured sync");
        }
    /* A wrapped count: word 0 small or huge, the same decode. */
    const uint32_t leads[] = {0u, 1u, 7999u, 8000u, 0xFFFFFFFFu};
    for (unsigned li = 0; li < 5; li++) {
        pnet_rx_t r;
        pnet_rx_init(&r, capbuf, sizeof capbuf);
        r.prearmed = true;
        const size_t n = armed_at_time(np, -40000, 520u, 0u, 1u, words);
        words[0] = leads[li];
        feed_all(&r, words, n);
        CHECK(decodes_and_parses(&r, wn) && !r.implied, "any word 0");
    }
}

/* A lead-in of 2-cell pulses ahead of the sync (bench fix 2's AAA8): after a long idle, an ordinary
 * capture would imply a sync at the first of them and decode misaligned; a pre-armed one hunts
 * through them to the measured sync. */
static void a_prearmed_capture_hunts_a_lead_in_instead_of_implying(void) {
    const lead_t aaa8 = {"AAA8 then 17", aaa8_17, 6};
    size_t wn, sync;
    const size_t np = lead_pulses(&aaa8, &wn, &sync);
    pnet_rx_t r;
    pnet_rx_init(&r, capbuf, sizeof capbuf);
    r.prearmed = true;
    size_t n = armed_at_time(np, -1000000, 520u, 140u, 7u, words);
    feed_all(&r, words, n);
    CHECK(decodes_and_parses(&r, wn) && !r.implied && r.hunt_n == 6, "hunted to the sync");
    pnet_rx_init(&r, capbuf, sizeof capbuf);             /* the same flux, not pre-armed */
    n = armed_at_time(np, -1000000, 520u, 140u, 7u, words);
    feed_all(&r, words, n);
    CHECK(r.implied && !decodes_and_parses(&r, wn), "implied at the lead-in: never parses");
}

/* Bench 2026-10-11 (Phase 1, Task 9 Step 3): the A500's cell is not 2000 ns. Paula times a bit cell
 * from the colour clock -- 7 ticks: 1973.6 ns on PAL, 1955.6 on NTSC -- and an empty batch's header
 * holds checksum, data_size and compressed_size all 0: a 59-cell gap, read at the nominal cell as
 * 58, and every bit after it moved (the board refused it as `mode`). Intervals here are in tenths
 * of a ns, edge to edge, less pw, with +-jit ns on every one; the bench's sync readings repeat to
 * the 13 ns count (31386 twice), so +-40 is generous. */
static size_t to_words_cell(const uint8_t *w, size_t n, uint32_t cell_x10, uint32_t pw,
                            uint32_t jit, uint32_t seed, uint32_t *out) {
    size_t k = 0, prev = SIZE_MAX;
    out[k++] = 30000u;
    for (size_t bit = 0; bit < n * 8u; bit++) {
        if (!((w[bit >> 3] >> (7u - (bit & 7u))) & 1u)) continue;
        if (prev != SIZE_MAX) {
            seed = seed * 1103515245u + 12345u;
            const int32_t j = jit ? (int32_t)((seed >> 16) % (2u * jit + 1u)) - (int32_t)jit : 0;
            out[k++] = (uint32_t)((int32_t)(((bit - prev) * cell_x10 + 5u) / 10u) - (int32_t)pw + j);
        }
        prev = bit;
    }
    return k;
}

static const uint32_t amiga_cells[] = {20000u, 19736u, 19556u};   /* crystal, PAL, NTSC (x10 ns) */

static void an_empty_batch_decodes_at_the_amigas_cell(void) {
    const uint32_t pws[] = {192u, 600u, 1200u};    /* 192: the A500's, from its 31386 ns sync */
    unsigned bad = 0;
    for (unsigned c = 0; c < 3; c++)
        for (unsigned p = 0; p < 3; p++)
            for (uint32_t seed = 1; seed <= 50; seed++) {
                const size_t wn = pnet_build_to_board(wire, sizeof wire, (uint8_t)(seed * 5u), 0x80, NULL, 0);
                pnet_rx_t r;
                pnet_rx_init(&r, capbuf, sizeof capbuf);
                feed_all(&r, words, to_words_cell(wire, wn, amiga_cells[c], pws[p], 40u, seed, words));
                pnet_hdr_t h;
                if (pnet_parse_hdr_from_amiga(capbuf, pnet_rx_bytes(&r), &h) != PNET_OK ||
                    h.mode != PNET_MODE_ETHERNET || h.amiga_ctr != (uint8_t)(seed * 5u) ||
                    memcmp(capbuf, wire + 4, wn - 4) != 0 || r.out_of_range)
                    bad++;
            }
    CHECK_EQ_INT(bad, 0);
}

/* The same, armed between the sync's pulses (the implied sync): no 16-cell interval to time, so the
 * fit has only the magic's 2- and 4-cell intervals and is looser. Measured on 6,000 batches per
 * jitter: clean to +-15 ns, 1.4% bad at +-25, 20% at +-40 (a measured sync: clean to +-80). +-15 is
 * one flux_in count either way, what the bench shows; and the pre-arm, which never implies, takes
 * the polls of a running exchange (bench 2026-10-11: prearm used 25 of 25). A refused poll is
 * written again by the Amiga. */
static void an_empty_batch_decodes_at_the_amigas_cell_when_implied(void) {
    unsigned bad = 0;
    for (unsigned c = 0; c < 3; c++)
        for (uint32_t seed = 1; seed <= 50; seed++) {
            const size_t wn = pnet_build_to_board(wire, sizeof wire, 0x21, 0x80, NULL, 0);
            const size_t n = to_words_cell(wire, wn, amiga_cells[c], 192u, 15u, seed, words);
            words[1] = 20000u;                          /* word 0 of the arm: past pulse 1 */
            pnet_rx_t r;
            pnet_rx_init(&r, capbuf, sizeof capbuf);
            feed_all(&r, words + 1, n - 1);             /* from the sync's closing pulse */
            pnet_hdr_t h;
            if (!r.implied || pnet_parse_hdr_from_amiga(capbuf, pnet_rx_bytes(&r), &h) != PNET_OK ||
                memcmp(capbuf, wire + 4, wn - 4) != 0)
                bad++;
        }
    CHECK_EQ_INT(bad, 0);
}

/* Frames too, at each cell: the whole path, as a_batch_survives_flux_and_parses at 2000 ns. */
static void a_framed_batch_decodes_at_the_amigas_cell(void) {
    pnet_frame_ref_t f[3] = {{frames, 64}, {frames + 64, 1500}, {frames + 1564, 7}};
    uint32_t x = 99u;
    for (size_t i = 0; i < 1564; i++) { x ^= x << 13; x ^= x >> 17; x ^= x << 5; frames[i] = (uint8_t)x; }
    memset(frames + 1564, 0, 7);
    unsigned bad = 0;
    for (unsigned c = 0; c < 3; c++)
        for (uint32_t seed = 1; seed <= 20; seed++) {
            const size_t wn = pnet_build_to_board(wire, sizeof wire, 0x10, 0x7F, f, 3);
            pnet_rx_t r;
            pnet_rx_init(&r, capbuf, sizeof capbuf);
            feed_all(&r, words, to_words_cell(wire, wn, amiga_cells[c], 192u, 40u, seed, words));
            if (memcmp(capbuf, wire + 4, wn - 4) != 0 || r.out_of_range) bad++;
        }
    CHECK_EQ_INT(bad, 0);
}

int main(void) {
    RUN(bytes_after_the_sync_come_back);
    RUN(jitter_does_not_move_a_bit);
    RUN(a_batch_survives_flux_and_parses);
    RUN(a_capture_that_missed_the_first_sync_pulse_is_implied);
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
    RUN(armed_before_pulse_1_syncs_by_measure);
    RUN(armed_between_the_sync_pulses_syncs_by_implication);
    RUN(armed_too_close_to_pulse_2_hunts_and_never_parses);
    RUN(armed_in_the_data_never_parses_implied_or_not);
    RUN(a_prearmed_capture_syncs_by_measure_whatever_the_idle);
    RUN(a_prearmed_capture_hunts_a_lead_in_instead_of_implying);
    RUN(an_empty_batch_decodes_at_the_amigas_cell);
    RUN(an_empty_batch_decodes_at_the_amigas_cell_when_implied);
    RUN(a_framed_batch_decodes_at_the_amigas_cell);
    return REPORT();
}
