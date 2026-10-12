/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
#include "harness.h"
#include "../src/pnet_link.h"
#include "../src/pnet_mfm.h"
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

static pnet_hdr_t hdr(uint8_t amiga, uint8_t pico) {
    pnet_hdr_t h;
    memset(&h, 0, sizeof h);
    h.mode = PNET_MODE_ETHERNET;
    h.amiga_ctr = amiga;
    h.pico_ctr = pico;
    return h;
}

static uint8_t g_mem[256 * PNET_RING_SLOT];   /* the TX ring's slots */
static uint8_t g_pay[32768];                  /* one batch's payload */

/* A to-board payload of n frames of `len` bytes, packed as PaulaNET's driver packs them with RLE on:
 * the PacketsHeader, then per frame its CompressionHeader (bit 15 set: RLE) and the RLE bytes. Built
 * by hand, because pnet_build_to_board stops at 20 frames and his driver does not. Frame i's bytes
 * are i + 7k (no runs), or all zeros, which RLE packs about 60 to 1. */
static size_t payload_of(uint8_t *out, unsigned n, uint16_t len, bool zeros) {
    static uint8_t f[PNET_ETH_MTU];
    const uint8_t ph[2] = { (uint8_t)n, 0 };
    uint16_t last = 0;
    size_t pos = pnet_mfm_encode(ph, 2, out, &last);
    for (unsigned i = 0; i < n; i++) {
        for (unsigned k = 0; k < len; k++) f[k] = zeros ? 0u : (uint8_t)(i + 7u * k);
        const size_t r = pnet_rle_encode(f, len, out + pos + 8);
        const uint8_t ch[4] = { (uint8_t)(0x80u | (r >> 8)), (uint8_t)r, (uint8_t)(len >> 8), (uint8_t)len };
        last = 0;
        pnet_mfm_encode(ch, 4, out + pos, &last);
        pos += 8u + r;
    }
    return pos;
}

static void tx_ring(pnet_ring_t *r, uint32_t slots) { CHECK(pnet_ring_init(r, g_mem, slots), "ring"); }

static void counters_start_as_paulanets(void) {
    pnet_link_t s;
    pnet_link_init(&s);
    CHECK_EQ_INT(s.last_amiga, 0xFF);
    CHECK_EQ_INT(s.pico, 0x7F);
    CHECK(!s.backup, "nothing out");
}

static void a_new_batch_is_taken_once(void) {
    pnet_link_t s; pnet_ring_t tx;
    pnet_link_init(&s);
    tx_ring(&tx, 32);
    pnet_hdr_t h = hdr(0x00, 0x7F);
    h.compressed_size = (uint16_t)payload_of(g_pay, 2, 60, false);
    CHECK(pnet_link_is_new(&s, &h), "new");
    CHECK_EQ_INT(pnet_link_take(&s, &h, g_pay, &tx), PNET_TAKE_NEW);
    CHECK_EQ_INT(s.last_amiga, 0x00);
    CHECK_EQ_INT(pnet_ring_count(&tx), 2);
    CHECK(!pnet_link_is_new(&s, &h), "now a resend");
    CHECK_EQ_INT(pnet_link_take(&s, &h, g_pay, &tx), PNET_TAKE_DUP);
    CHECK_EQ_INT(pnet_ring_count(&tx), 2);                   /* a resend queues nothing */
    CHECK_EQ_INT(s.fresh, 1);
    CHECK_EQ_INT(s.dup, 1);
    CHECK_EQ_INT(s.queued, 2);
    h = hdr(0x01, 0x7F);                                     /* an empty batch: compressed_size 0 */
    CHECK_EQ_INT(pnet_link_take(&s, &h, g_pay, &tx), PNET_TAKE_NEW);
    CHECK_EQ_INT(s.last_amiga, 0x01);
}

static void batches_of_21_to_255_frames_are_taken_whole(void) {
    static const unsigned sizes[3] = { 21, 100, 255 };
    for (unsigned k = 0; k < 3; k++) {
        pnet_link_t s; pnet_ring_t tx;
        pnet_link_init(&s);
        tx_ring(&tx, 256);
        const unsigned n = sizes[k];
        pnet_hdr_t h = hdr(0x10, 0x7F);
        h.compressed_size = (uint16_t)payload_of(g_pay, n, 60, false);
        CHECK_EQ_INT(pnet_link_take(&s, &h, g_pay, &tx), PNET_TAKE_NEW);
        CHECK_EQ_INT(pnet_ring_count(&tx), n);
        CHECK_EQ_INT(s.over + s.malformed, 0);
        uint16_t len = 0;
        const uint8_t *f = pnet_ring_peek(&tx, n - 1u, &len);
        CHECK(f && len == 60 && f[0] == (uint8_t)(n - 1u) && f[59] == (uint8_t)(n - 1u + 7u * 59u),
              "the last frame, intact");
    }
}

static void a_ring_overflow_is_taken_and_counted(void) {
    pnet_link_t s; pnet_ring_t tx;
    pnet_link_init(&s);
    tx_ring(&tx, 32);
    static const uint8_t earlier[60];
    for (unsigned i = 0; i < 3; i++) CHECK(pnet_ring_push(&tx, earlier, 60), "frames already waiting");
    pnet_hdr_t h = hdr(0x05, 0x7F);
    h.compressed_size = (uint16_t)payload_of(g_pay, 40, 60, false);
    CHECK_EQ_INT(pnet_link_take(&s, &h, g_pay, &tx), PNET_TAKE_NEW);
    CHECK_EQ_INT(s.last_amiga, 0x05);                        /* taken: acknowledged, never resent */
    CHECK_EQ_INT(pnet_ring_count(&tx), 32);                  /* full, and nothing written past it */
    CHECK_EQ_INT(s.queued, 29);
    CHECK_EQ_INT(s.over, 11);
    CHECK_EQ_INT(tx.drops, 0);                               /* the take never claims a slot it lacks */
    uint16_t len = 0;
    const uint8_t *f = pnet_ring_peek(&tx, 31, &len);
    CHECK(f && f[0] == 28, "the batch's 29th frame is the last one in");
}

static void a_batch_that_decodes_past_32_kb_is_taken(void) {
    pnet_link_t s; pnet_ring_t tx;
    pnet_link_init(&s);
    tx_ring(&tx, 128);
    pnet_hdr_t h = hdr(0x06, 0x7F);
    const size_t n = payload_of(g_pay, 100, 1514, true);
    CHECK(n <= 8192u, "inside the driver's 8,192-byte budget");
    h.compressed_size = (uint16_t)n;
    CHECK_EQ_INT(pnet_link_take(&s, &h, g_pay, &tx), PNET_TAKE_NEW);
    CHECK_EQ_INT(s.queued, 100);                             /* 151,400 bytes: Phase 1's 32 KB scratch refused it */
    CHECK_EQ_INT(s.over, 0);
}

static void a_malformed_frame_ends_the_batch_but_not_the_link(void) {
    pnet_link_t s; pnet_ring_t tx;
    pnet_link_init(&s);
    tx_ring(&tx, 32);
    pnet_hdr_t h = hdr(0x07, 0x7F);
    h.compressed_size = (uint16_t)payload_of(g_pay, 10, 60, false);
    CHECK_EQ_INT(h.compressed_size, 4 + 10 * 70);            /* each frame: 8 + 62 (61 bytes of RLE, padded) */
    const uint8_t bad[4] = { 0x80, 62, 0, 0 };               /* frame 6 (index 5): original size 0 */
    uint16_t last = 0;
    pnet_mfm_encode(bad, 4, g_pay + 4 + 5u * 70u, &last);
    CHECK_EQ_INT(pnet_link_take(&s, &h, g_pay, &tx), PNET_TAKE_NEW);
    CHECK_EQ_INT(s.last_amiga, 0x07);
    CHECK_EQ_INT(s.queued, 5);
    CHECK_EQ_INT(s.malformed, 5);                            /* frame 6 and the four after it */
}

static void an_ack_frees_the_batch_out(void) {
    pnet_link_t s;
    pnet_link_init(&s);
    pnet_link_start(&s, 3);
    CHECK(s.backup && s.nframes == 3 && s.pico == 0x80, "out under 0x80");
    pnet_hdr_t h = hdr(0x00, 0x7F);
    CHECK_EQ_INT(pnet_link_ack(&s, &h), 0);                 /* echoes the old counter: no */
    h = hdr(0x00, 0x80);
    CHECK_EQ_INT(pnet_link_ack(&s, &h), 3);
    CHECK(!s.backup && s.nframes == 0, "freed");
    CHECK_EQ_INT(pnet_link_ack(&s, &h), 0);                 /* the same ack again frees nothing */
    CHECK_EQ_INT(s.acked, 1);
}

static void an_unacknowledged_batch_is_rebuilt_unchanged(void) {
    pnet_link_t s;
    pnet_link_init(&s);
    pnet_link_start(&s, 2);
    /* NetLoop restarted (or Ctrl-A-A): its first header echoes some other counter. */
    pnet_hdr_t h = hdr(0x42, 0x13);
    CHECK_EQ_INT(pnet_link_ack(&s, &h), 0);
    pnet_ring_t tx;
    tx_ring(&tx, 32);
    CHECK_EQ_INT(pnet_link_take(&s, &h, g_pay, &tx), PNET_TAKE_NEW);   /* h: an empty batch */
    pnet_link_start(&s, 5);                                 /* a caller trying to start over it */
    CHECK(s.backup && s.nframes == 2 && s.pico == 0x80, "the same two frames, the same counter");
}

static void empty_batches_do_not_move_the_counter(void) {
    pnet_link_t s;
    pnet_link_init(&s);
    pnet_link_start(&s, 0);
    CHECK(!s.backup && s.pico == 0x7F, "nothing out, 0x7F");
}

static void counters_wrap(void) {
    pnet_link_t s;
    pnet_link_init(&s);
    s.pico = 0xFF;
    pnet_link_start(&s, 1);
    CHECK_EQ_INT(s.pico, 0x00);
    pnet_hdr_t h = hdr(0x10, 0x00);
    CHECK_EQ_INT(pnet_link_ack(&s, &h), 1);
}

static void fit_respects_the_buffer_and_twenty_frames(void) {
    uint16_t lens[25];
    for (unsigned i = 0; i < 25; i++) lens[i] = 64;
    CHECK_EQ_INT(pnet_link_fit(lens, 25, 100000), PNET_MAX_FRAMES);
    CHECK_EQ_INT(pnet_link_fit(lens, 3, 100000), 3);
    CHECK_EQ_INT(pnet_link_fit(lens, 0, 100000), 0);
    for (unsigned i = 0; i < 25; i++) lens[i] = PNET_ETH_MTU;
    const size_t cap = 14336u - 80u;                        /* DF1's buffer less the extra lead-in */
    const unsigned n = pnet_link_fit(lens, 25, cap);
    CHECK(n >= 1, "one full frame always fits");
    CHECK(pnet_to_amiga_bound(lens, n) <= cap, "n fits");
    CHECK(pnet_to_amiga_bound(lens, n + 1) > cap, "n + 1 does not");
    /* And the builder agrees: n real frames build into exactly `cap` bytes or fewer. */
    static uint8_t frame[PNET_ETH_MTU], out[14336];
    for (unsigned i = 0; i < sizeof frame; i++) frame[i] = (uint8_t)(i * 37u);   /* RLE's worst case-ish */
    pnet_frame_ref_t f[PNET_MAX_FRAMES];
    for (unsigned i = 0; i < n; i++) { f[i].data = frame; f[i].len = PNET_ETH_MTU; }
    CHECK(pnet_build_to_amiga(out, cap, 0, 0, 0, f, n) != 0, "built within cap");
}

static void ota_waits_for_quiet(void) {
    CHECK(pnet_ota_quiet(5000, 0, false), "never active");
    CHECK(!pnet_ota_quiet(5000, 0, true), "frames still queued");
    CHECK(!pnet_ota_quiet(19999, 10000, false), "9,999 ms");
    CHECK(pnet_ota_quiet(20000, 10000, false), "10,000 ms");
    CHECK(!pnet_ota_quiet(5, 0xFFFFFF00u, false), "across the wrap: 261 ms");
    CHECK(pnet_ota_quiet(10000u + 0x100u - 1u, 0xFFFFFF00u, false), "across the wrap: 10,255 ms");
}

/* Phase 2 (§3.3): whatever DF1's buffer, a batch to the Amiga carries at most 16,128 payload bytes, so
 * its whole track sits inside PaulaNET's driver's largest read (16,640 bytes). */
static void fit_caps_the_payload_at_16128_bytes(void) {
    uint16_t lens[25];
    for (unsigned i = 0; i < 25; i++) lens[i] = PNET_ETH_MTU;
    const size_t hd = 25344u - 80u;                          /* a WF_DF1_HD-sized buffer, larger than the cap */
    const unsigned n = pnet_link_fit(lens, 25, hd);
    CHECK_EQ_INT(n, 10);                                     /* 4 + 10 x 1,539 = 15,394; 11 would be 16,933 */
    CHECK(pnet_payload_bound(lens, n) <= PNET_TO_AMIGA_MAX_PAYLOAD, "n is inside the cap");
    CHECK(pnet_payload_bound(lens, n + 1) > PNET_TO_AMIGA_MAX_PAYLOAD, "n + 1 is not");
    CHECK(pnet_to_amiga_bound(lens, n + 1) <= hd, "and the cap, not the buffer, is what stops it");
    static uint8_t frame[PNET_ETH_MTU], out[25344];
    for (unsigned i = 0; i < sizeof frame; i++) frame[i] = (uint8_t)(i * 37u);
    pnet_frame_ref_t f[PNET_MAX_FRAMES];
    for (unsigned i = 0; i < n; i++) { f[i].data = frame; f[i].len = PNET_ETH_MTU; }
    CHECK(pnet_build_to_amiga(out, hd, 0, 0, 0, f, n) != 0, "built");
    pnet_hdr_t h;
    const long sync_bits = pnet_find_sync(out, sizeof out, sizeof out);   /* where the board's lead-in + sync end */
    CHECK(sync_bits > 0 && sync_bits % 8 == 0, "sync found on a byte boundary");
    const size_t hdr_at = (size_t)sync_bits / 8u;
    CHECK_EQ_INT(pnet_parse_hdr_to_amiga(out + hdr_at, sizeof out - hdr_at, &h, true), PNET_OK);
    CHECK(h.data_size <= PNET_TO_AMIGA_MAX_PAYLOAD, "the built batch is inside the cap");
    CHECK(hdr_at + PNET_HDR_MFM_BYTES + h.data_size <= PNET_DRIVER_MAX_READ, "inside the driver's largest read");
}

int main(void) {
    RUN(counters_start_as_paulanets);
    RUN(a_new_batch_is_taken_once);
    RUN(batches_of_21_to_255_frames_are_taken_whole);
    RUN(a_ring_overflow_is_taken_and_counted);
    RUN(a_batch_that_decodes_past_32_kb_is_taken);
    RUN(a_malformed_frame_ends_the_batch_but_not_the_link);
    RUN(an_ack_frees_the_batch_out);
    RUN(an_unacknowledged_batch_is_rebuilt_unchanged);
    RUN(empty_batches_do_not_move_the_counter);
    RUN(counters_wrap);
    RUN(fit_respects_the_buffer_and_twenty_frames);
    RUN(fit_caps_the_payload_at_16128_bytes);
    RUN(ota_waits_for_quiet);
    return REPORT();
}
