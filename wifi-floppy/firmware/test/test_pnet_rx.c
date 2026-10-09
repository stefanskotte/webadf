#include "harness.h"
#include "../src/pnet_rx.h"
#include "../src/pnet_frame.h"
#include <stdint.h>
#include <string.h>

/*
 * The raw-cell accumulator, fed what flux_in would report for a PaulaNET write: a lead word
 * (arm to first edge), then each gap between pulses, edge to edge MINUS the pulse's low time,
 * with a deterministic jitter. PaulaNET protocol (C) 2026 RobSmithDev, used with permission.
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
    const uint32_t pws[] = {300u, 700u, 1200u};
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

int main(void) {
    RUN(bytes_after_the_sync_come_back);
    RUN(jitter_does_not_move_a_bit);
    RUN(a_batch_survives_flux_and_parses);
    RUN(a_capture_that_missed_the_first_sync_pulse_is_refused);
    RUN(a_long_gap_is_counted_and_clamped);
    RUN(a_full_buffer_says_so);
    return REPORT();
}
