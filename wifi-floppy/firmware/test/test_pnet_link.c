/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
#include "harness.h"
#include "../src/pnet_link.h"
#include "../src/pnet_mfm.h"
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "lz4_corpus.h"
#include "../src/pnet_lz4.h"

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
    CHECK_EQ_INT(n, 5);                                      /* MFM: 4 + 5 x 3,044 = 15,224; 6 would be 18,268 */
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

static void cylinder_76_is_the_status_track_in_l2(void) {
    CHECK_EQ_INT(pnet_df1_for_track_l2(153), PNET_DF1_STATUS);
    CHECK_EQ_INT(pnet_df1_for_track_l2(152), PNET_DF1_SILENT);
    CHECK_EQ_INT(pnet_df1_for_track_l2(155), PNET_DF1_ECHO);
    CHECK_EQ_INT(pnet_df1_for_track_l2(154), PNET_DF1_SILENT);
    CHECK_EQ_INT(pnet_df1_for_track_l2(150), PNET_DF1_DISK);
    CHECK_EQ_INT(pnet_df1_wprot(76), true);                  /* 76 stays write-protected (correction 3) */
}

/* An Amiga -> board payload as webadf's driver variant writes it (spec 2026-10-18 §2): per frame RLE ('r', 0x8000|n),
 * raw LZ4 ('z', 0x4000|n, padded to even) or MFM-wrapped LZ4 ('w', 0xC000|n), every frame laid back to back in the
 * encoder's window so that the LZ4 ones link to the earlier frames. */
static size_t lz4_payload(uint8_t *out, uint8_t (*f)[PNET_ETH_MTU], const uint16_t *lens, const char *how, unsigned n) {
    static uint8_t win[65536], blk[2048];
    static uint16_t table[PNET_LZ4_TABLE_ENTRIES];
    memset(table, 0, sizeof table);
    const uint8_t ph[2] = { (uint8_t)n, 0 };
    uint16_t last = 0;
    size_t pos = pnet_mfm_encode(ph, 2, out, &last), at = 0;
    for (unsigned i = 0; i < n; i++) {
        memcpy(win + at, f[i], lens[i]);
        uint16_t field;
        size_t wire;
        if (how[i] == 'r') {
            wire = pnet_rle_encode(f[i], lens[i], out + pos + 8);
            field = (uint16_t)(0x8000u | wire);
        } else {
            const size_t z = pnet_lz4_encode_linked(win + at, lens[i], blk, sizeof blk, table, PNET_LZ4_TABLE_ENTRIES, win);
            if (how[i] == 'z') {
                memcpy(out + pos + 8, blk, z);
                if (z & 1u) out[pos + 8 + z] = 0;
                wire = z + (z & 1u);
                field = (uint16_t)(PNET_SIZE_LZ4 | z);
            } else {
                uint16_t l2 = 0;
                pnet_mfm_encode(blk, z, out + pos + 8, &l2);
                wire = 2u * z;
                field = (uint16_t)(0x8000u | PNET_SIZE_LZ4 | z);
            }
        }
        const uint8_t ch[4] = { (uint8_t)(field >> 8), (uint8_t)field, (uint8_t)(lens[i] >> 8), (uint8_t)lens[i] };
        last = 0;
        pnet_mfm_encode(ch, 4, out + pos, &last);
        pos += 8u + wire;
        at += lens[i];
    }
    return pos;
}

static uint8_t g_lf[16][PNET_ETH_MTU];
static uint8_t g_win[PNET_LZ4_WINDOW], g_scr[PNET_LZ4_BLOCK_MAX];

static pnet_hdr_t lz4_hdr(uint8_t amiga, bool word) {
    pnet_hdr_t h = hdr(amiga, 0x7F);
    h.compressed = (uint8_t)(PNET_COMPRESSED_MFM | PNET_FROM_DRIVER | (word ? PNET_DRIVER_LZ4 : 0u));
    return h;
}

/* Review Focus, mixed batches: RLE frames sit in the window too, so the LZ4 frames after them decode exactly. */
static void an_lz4_batch_is_decoded_linked_into_the_ring(void) {
    static const int kinds[5] = { LC_TEXT, LC_TEXT, LC_RANDOM, LC_HTML, LC_TEXT };
    static const uint16_t lens[5] = { 900, 1100, 700, 1300, 500 };
    pnet_link_t s; pnet_ring_t tx;
    pnet_link_init(&s);
    tx_ring(&tx, 32);
    for (unsigned i = 0; i < 5; i++) lc_frame(g_lf[i], lens[i], kinds[i], 40u + i);
    pnet_hdr_t h = lz4_hdr(0x00, true);
    h.compressed_size = (uint16_t)lz4_payload(g_pay, g_lf, lens, "rzrwz", 5);
    CHECK_EQ_INT(pnet_link_take_lz4(&s, &h, g_pay, &tx, g_win, g_scr), PNET_TAKE_NEW);
    CHECK_EQ_INT(pnet_ring_count(&tx), 5);
    for (unsigned i = 0; i < 5; i++) {
        uint16_t len = 0;
        const uint8_t *f = pnet_ring_peek(&tx, i, &len);
        CHECK(f != NULL && len == lens[i] && memcmp(f, g_lf[i], len) == 0, "the frame, whole");
    }
    CHECK_EQ_INT(s.lz4_in, 3);
    CHECK_EQ_INT(s.lz4_bad, 0);
    CHECK_EQ_INT(s.malformed, 0);
    CHECK(s.amiga_lz4, "the driver asked for LZ4");
}

static void lz4_frames_need_the_drivers_word_and_the_window(void) {
    static const uint16_t lens[3] = { 900, 1100, 700 };
    for (unsigned i = 0; i < 3; i++) lc_frame(g_lf[i], lens[i], LC_TEXT, 60u + i);
    for (unsigned k = 0; k < 2; k++) {
        pnet_link_t s; pnet_ring_t tx;
        pnet_link_init(&s);
        tx_ring(&tx, 32);
        pnet_hdr_t h = lz4_hdr(0x00, k == 1);           /* k 0: no 0x10; k 1: 0x10 but no window (pnet_link_take) */
        h.compressed_size = (uint16_t)lz4_payload(g_pay, g_lf, lens, "rzz", 3);
        if (k == 0) CHECK_EQ_INT(pnet_link_take_lz4(&s, &h, g_pay, &tx, g_win, g_scr), PNET_TAKE_NEW);
        else CHECK_EQ_INT(pnet_link_take(&s, &h, g_pay, &tx), PNET_TAKE_NEW);
        CHECK_EQ_INT(pnet_ring_count(&tx), 1);          /* the RLE frame; the LZ4 ones are unreadable */
        CHECK_EQ_INT(s.malformed, 2);
        CHECK_EQ_INT(s.lz4_in, 0);
    }
}

/* Review Focus, the driver swap: the word follows the latest header, a resend's included. */
static void the_drivers_word_follows_the_latest_header(void) {
    pnet_link_t s; pnet_ring_t tx;
    pnet_link_init(&s);
    tx_ring(&tx, 32);
    CHECK(!s.amiga_lz4, "nothing heard yet: no LZ4");
    pnet_hdr_t h = lz4_hdr(0x00, true);
    CHECK_EQ_INT(pnet_link_take_lz4(&s, &h, g_pay, &tx, g_win, g_scr), PNET_TAKE_NEW);
    CHECK(s.amiga_lz4, "our driver");
    h = lz4_hdr(0x00, false);                           /* the same counter: a resend, from Rob's driver now */
    CHECK_EQ_INT(pnet_link_take_lz4(&s, &h, g_pay, &tx, g_win, g_scr), PNET_TAKE_DUP);
    CHECK(!s.amiga_lz4, "Rob's driver: MFM from now on");
    h = lz4_hdr(0x01, true);
    CHECK_EQ_INT(pnet_link_take_lz4(&s, &h, g_pay, &tx, g_win, g_scr), PNET_TAKE_NEW);
    CHECK(s.amiga_lz4, "ours again");
}

/* Review Focus, sizes at the edges: frames fill the window to exactly 16,128 bytes and an LZ4 frame still links; one
 * frame past it is decoded straight into its slot, and an LZ4 frame after it is refused (and counted). */
static void the_window_ends_at_16128_bytes(void) {
    uint16_t lens[12];
    for (unsigned i = 0; i < 11; i++) { lens[i] = PNET_ETH_MTU; lc_frame(g_lf[i], PNET_ETH_MTU, LC_ZEROS, 0); }
    lens[10] = 948;                                     /* 10 x 1,518 + 948 = 16,128 */
    lc_frame(g_lf[10], 948, LC_ZEROS, 0);
    {
        pnet_link_t s; pnet_ring_t tx;
        pnet_link_init(&s);
        tx_ring(&tx, 32);
        pnet_hdr_t h = lz4_hdr(0x00, true);
        h.compressed_size = (uint16_t)lz4_payload(g_pay, g_lf, lens, "rrrrrrrrrrz", 11);
        pnet_link_take_lz4(&s, &h, g_pay, &tx, g_win, g_scr);
        CHECK_EQ_INT(pnet_ring_count(&tx), 11);
        CHECK_EQ_INT(s.lz4_in, 1);
        CHECK_EQ_INT(s.malformed, 0);
    }
    lens[10] = PNET_ETH_MTU;                            /* 11 x 1,518 = 16,698: the 11th does not fit */
    lc_frame(g_lf[10], PNET_ETH_MTU, LC_ZEROS, 0);
    lens[11] = 600;
    lc_frame(g_lf[11], 600, LC_TEXT, 5);
    {
        pnet_link_t s; pnet_ring_t tx;
        pnet_link_init(&s);
        tx_ring(&tx, 32);
        pnet_hdr_t h = lz4_hdr(0x00, true);
        h.compressed_size = (uint16_t)lz4_payload(g_pay, g_lf, lens, "rrrrrrrrrrrz", 12);
        pnet_link_take_lz4(&s, &h, g_pay, &tx, g_win, g_scr);
        CHECK_EQ_INT(pnet_ring_count(&tx), 11);
        CHECK_EQ_INT(s.lz4_bad, 1);
        CHECK_EQ_INT(s.malformed, 1);
    }
}

/* Review Focus, malformed LZ4: damaged batches (blocks and size words alike) never write past the window, the scratch
 * or a ring slot; every refusal is counted. */
static void malformed_lz4_never_overruns_the_board(void) {
    static struct {
        uint8_t win[PNET_LZ4_WINDOW]; uint8_t g1[256];
        uint8_t scr[PNET_LZ4_BLOCK_MAX]; uint8_t g2[256];
        uint8_t ring[8 * PNET_RING_SLOT]; uint8_t g3[256];
    } m;
    static const uint16_t lens[5] = { 900, 1100, 700, 1300, 500 };
    static const char *const hows[3] = { "zwzwz", "rzwrz", "wwwww" };
    memset(&m, 0xA5, sizeof m);
    pnet_link_t s; pnet_ring_t tx;
    pnet_link_init(&s);
    CHECK(pnet_ring_init(&tx, m.ring, 8), "ring");
    uint32_t r = 777;
    for (unsigned t = 0; t < 3000; t++) {
        for (unsigned i = 0; i < 5; i++) lc_frame(g_lf[i], lens[i], (int)(t + i) % 2 ? LC_HTML : LC_TEXT, t * 5u + i);
        pnet_hdr_t h = lz4_hdr((uint8_t)t, true);
        const size_t len = lz4_payload(g_pay, g_lf, lens, hows[t % 3u], 5);
        h.compressed_size = (uint16_t)len;
        const unsigned hits = 1u + lc_next(&r) % 4u;
        for (unsigned k = 0; k < hits; k++) g_pay[4u + lc_next(&r) % (len - 4u)] = (uint8_t)lc_next(&r);
        pnet_link_take_lz4(&s, &h, g_pay, &tx, m.win, m.scr);
        for (uint32_t i = 0; i < pnet_ring_count(&tx); i++) {
            uint16_t l = 0;
            (void)pnet_ring_peek(&tx, i, &l);
            CHECK(l >= 1 && l <= PNET_RING_MTU, "a committed frame is 1..MTU bytes");
        }
        pnet_ring_drop(&tx, pnet_ring_count(&tx));
    }
    unsigned touched = 0;
    for (unsigned i = 0; i < 256; i++) touched += (m.g1[i] != 0xA5) + (m.g2[i] != 0xA5) + (m.g3[i] != 0xA5);
    CHECK_EQ_INT(touched, 0);
    CHECK(s.lz4_bad + s.malformed > 0, "the damage was seen and counted");
    CHECK(s.queued > 0, "and undamaged frames still went through");
}

/* Not in the brief's list: the window is reset per batch -- a batch that broke its window does not stop the next one's
 * LZ4 frames from decoding. */
static void the_window_starts_empty_every_batch(void) {
    uint16_t lens[12];
    for (unsigned i = 0; i < 11; i++) { lens[i] = PNET_ETH_MTU; lc_frame(g_lf[i], PNET_ETH_MTU, LC_ZEROS, 0); }
    lens[11] = 600;
    lc_frame(g_lf[11], 600, LC_TEXT, 5);
    pnet_link_t s; pnet_ring_t tx;
    pnet_link_init(&s);
    tx_ring(&tx, 64);
    pnet_hdr_t h = lz4_hdr(0x00, true);
    h.compressed_size = (uint16_t)lz4_payload(g_pay, g_lf, lens, "rrrrrrrrrrrz", 12);
    pnet_link_take_lz4(&s, &h, g_pay, &tx, g_win, g_scr);
    CHECK_EQ_INT(s.lz4_bad, 1);                         /* the first batch's window broke */
    static const uint16_t l2[3] = { 900, 1100, 700 };
    for (unsigned i = 0; i < 3; i++) lc_frame(g_lf[i], l2[i], LC_TEXT, 90u + i);
    h = lz4_hdr(0x01, true);
    h.compressed_size = (uint16_t)lz4_payload(g_pay, g_lf, l2, "zwz", 3);
    CHECK_EQ_INT(pnet_link_take_lz4(&s, &h, g_pay, &tx, g_win, g_scr), PNET_TAKE_NEW);
    CHECK_EQ_INT(s.lz4_in, 3);                          /* the next batch decodes from an empty window */
    CHECK_EQ_INT(s.lz4_bad, 1);
    CHECK_EQ_INT(pnet_ring_count(&tx), 14);
    for (unsigned i = 0; i < 3; i++) {
        uint16_t len = 0;
        const uint8_t *f = pnet_ring_peek(&tx, 11u + i, &len);
        CHECK(f != NULL && len == l2[i] && memcmp(f, g_lf[i], len) == 0, "the frame, whole");
    }
}

/* Not in the brief's list: the edge to the byte -- an LZ4 frame ending at 16,129 is refused. */
static void an_lz4_frame_one_byte_past_the_window_is_refused(void) {
    uint16_t lens[11];
    for (unsigned i = 0; i < 10; i++) { lens[i] = PNET_ETH_MTU; lc_frame(g_lf[i], PNET_ETH_MTU, LC_ZEROS, 0); }
    lens[10] = 949;                                     /* 10 x 1,518 + 949 = 16,129 */
    lc_frame(g_lf[10], 949, LC_ZEROS, 0);
    pnet_link_t s; pnet_ring_t tx;
    pnet_link_init(&s);
    tx_ring(&tx, 32);
    pnet_hdr_t h = lz4_hdr(0x00, true);
    h.compressed_size = (uint16_t)lz4_payload(g_pay, g_lf, lens, "rrrrrrrrrrz", 11);
    pnet_link_take_lz4(&s, &h, g_pay, &tx, g_win, g_scr);
    CHECK_EQ_INT(pnet_ring_count(&tx), 10);
    CHECK_EQ_INT(s.lz4_in, 0);
    CHECK_EQ_INT(s.lz4_bad, 1);
    CHECK_EQ_INT(s.malformed, 1);
}

/* Not in the brief's list: toward the Amiga an LZ4 block is always MFM-wrapped; a raw one is refused (HANDOFF 3bu). */
static void raw_lz4_toward_the_amiga_is_refused(void) {
    static const uint16_t lens[2] = { 900, 900 };
    for (unsigned i = 0; i < 2; i++) lc_frame(g_lf[i], lens[i], LC_TEXT, 70u + i);
    for (unsigned k = 0; k < 2; k++) {
        const size_t n = lz4_payload(g_pay, g_lf, lens, k ? "ww" : "zz", 2);
        pnet_frame_iter_t it;
        CHECK_EQ_INT(pnet_frame_iter_init(&it, g_pay, n, PNET_TO_AMIGA), PNET_OK);
        pnet_lz4_win_t w = { g_win, 0, g_scr };
        static uint8_t out[PNET_ETH_MTU];
        uint16_t len = 0;
        bool z = false;
        const pnet_err_t e = pnet_lz4_iter_next(&it, &w, out, sizeof out, &len, &z);
        if (k == 0) {
            CHECK_EQ_INT(e, PNET_E_LZ4);
            CHECK_EQ_INT(it.i, 0);
        } else {
            CHECK_EQ_INT(e, PNET_OK);
            CHECK(z && len == 900 && memcmp(out, g_lf[0], 900) == 0, "wrapped: decoded");
        }
    }
}

/* pnet_link_shrink: only while a batch is out, only downward, never to 0. */
static void shrink_only_lowers_the_batch_out(void) {
    pnet_link_t s;
    pnet_link_init(&s);
    pnet_link_shrink(&s, 3);
    CHECK_EQ_INT(s.nframes, 0);                         /* nothing out: nothing to shrink */
    pnet_link_start(&s, 8);
    pnet_link_shrink(&s, 9);
    CHECK_EQ_INT(s.nframes, 8);
    pnet_link_shrink(&s, 8);
    CHECK_EQ_INT(s.nframes, 8);
    pnet_link_shrink(&s, 0);
    CHECK_EQ_INT(s.nframes, 8);
    pnet_link_shrink(&s, 5);
    CHECK_EQ_INT(s.nframes, 5);
    pnet_hdr_t h = hdr(0x00, s.pico);
    CHECK_EQ_INT(pnet_link_ack(&s, &h), 5);             /* the ack frees what went out */
}

/* Fix round 1 (review I1): an MFM-wrapped (0xC000) block is MFM-decoded into the scratch before LZ4 sees it, so the
 * block-size check is all that keeps it inside PNET_LZ4_BLOCK_MAX bytes. One frame, original size 1,518, block bytes
 * i & 0x7F with the last one 0x5A, MFM-wrapped. */
static size_t wrapped_block_payload(uint8_t *out, size_t blk) {
    static uint8_t raw[PNET_LZ4_BLOCK_MAX + 256];
    for (size_t i = 0; i < blk; i++) raw[i] = (uint8_t)(i & 0x7Fu);
    raw[blk - 1u] = 0x5A;
    const uint8_t ph[2] = { 1, 0 };
    uint16_t last = 0;
    size_t pos = pnet_mfm_encode(ph, 2, out, &last);
    const uint16_t field = (uint16_t)(0x8000u | PNET_SIZE_LZ4 | blk);
    const uint8_t ch[4] = { (uint8_t)(field >> 8), (uint8_t)field, PNET_ETH_MTU >> 8, PNET_ETH_MTU & 0xFF };
    last = 0;
    pnet_mfm_encode(ch, 4, out + pos, &last);
    last = 0;
    pnet_mfm_encode(raw, blk, out + pos + 8, &last);
    return pos + 8u + 2u * blk;
}

static void a_wrapped_block_over_the_scratch_is_refused(void) {
    static struct {
        uint8_t win[PNET_LZ4_WINDOW]; uint8_t g1[256];
        uint8_t scr[PNET_LZ4_BLOCK_MAX]; uint8_t g2[256];
    } m;
    static const size_t blks[4] = { PNET_LZ4_BLOCK_MAX - 1u, PNET_LZ4_BLOCK_MAX, PNET_LZ4_BLOCK_MAX + 1u,
                                    PNET_LZ4_BLOCK_MAX + 256u };
    for (unsigned k = 0; k < 4; k++) {
        memset(&m, 0xA5, sizeof m);
        pnet_link_t s; pnet_ring_t tx;
        pnet_link_init(&s);
        tx_ring(&tx, 8);
        pnet_hdr_t h = lz4_hdr((uint8_t)k, true);
        h.compressed_size = (uint16_t)wrapped_block_payload(g_pay, blks[k]);
        CHECK_EQ_INT(pnet_link_take_lz4(&s, &h, g_pay, &tx, m.win, m.scr), PNET_TAKE_NEW);
        CHECK_EQ_INT(pnet_ring_count(&tx), 0);          /* not a valid block either way: nothing queued */
        CHECK_EQ_INT(s.lz4_bad, 1);                     /* ...refused as LZ4, and counted */
        CHECK_EQ_INT(s.malformed, 1);
        unsigned touched = 0;
        for (unsigned i = 0; i < 256; i++) touched += (m.g1[i] != 0xA5) + (m.g2[i] != 0xA5);
        CHECK_EQ_INT(touched, 0);                       /* nothing past the window or the scratch */
        if (blks[k] <= PNET_LZ4_BLOCK_MAX)              /* up to the limit it reached the scratch, to its last byte */
            CHECK_EQ_INT(m.scr[blks[k] - 1u], 0x5A);
        else                                            /* past it: refused before a byte was decoded */
            CHECK_EQ_INT(m.scr[0], 0xA5);
    }
    /* The same under ASan: window and scratch on the heap at exactly their sizes, so any write past them is a report. */
    uint8_t *win = malloc(PNET_LZ4_WINDOW), *scr = malloc(PNET_LZ4_BLOCK_MAX);
    CHECK(win != NULL && scr != NULL, "heap");
    for (unsigned k = 0; k < 4 && win && scr; k++) {
        pnet_link_t s; pnet_ring_t tx;
        pnet_link_init(&s);
        tx_ring(&tx, 8);
        pnet_hdr_t h = lz4_hdr((uint8_t)k, true);
        h.compressed_size = (uint16_t)wrapped_block_payload(g_pay, blks[k]);
        pnet_link_take_lz4(&s, &h, g_pay, &tx, win, scr);
        CHECK_EQ_INT(s.lz4_bad, 1);
    }
    free(win);
    free(scr);
}

/* ...and the longest real block, 1,518 random bytes as literals (1,525 bytes), MFM-wrapped, still decodes. */
static void the_longest_real_wrapped_block_decodes(void) {
    static const uint16_t lens[1] = { PNET_ETH_MTU };
    lc_frame(g_lf[0], PNET_ETH_MTU, LC_RANDOM, 3);
    uint8_t *win = malloc(PNET_LZ4_WINDOW), *scr = malloc(PNET_LZ4_BLOCK_MAX);
    CHECK(win != NULL && scr != NULL, "heap");
    if (!win || !scr) { free(win); free(scr); return; }
    pnet_link_t s; pnet_ring_t tx;
    pnet_link_init(&s);
    tx_ring(&tx, 8);
    pnet_hdr_t h = lz4_hdr(0x00, true);
    h.compressed_size = (uint16_t)lz4_payload(g_pay, g_lf, lens, "w", 1);
    pnet_link_take_lz4(&s, &h, g_pay, &tx, win, scr);
    uint16_t len = 0;
    const uint8_t *f = pnet_ring_peek(&tx, 0, &len);
    CHECK(f != NULL && len == PNET_ETH_MTU && memcmp(f, g_lf[0], len) == 0, "the frame, whole");
    CHECK_EQ_INT(s.lz4_in, 1);
    free(win);
    free(scr);
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
    RUN(cylinder_76_is_the_status_track_in_l2);
    RUN(an_lz4_batch_is_decoded_linked_into_the_ring);
    RUN(lz4_frames_need_the_drivers_word_and_the_window);
    RUN(the_drivers_word_follows_the_latest_header);
    RUN(the_window_ends_at_16128_bytes);
    RUN(malformed_lz4_never_overruns_the_board);
    RUN(the_window_starts_empty_every_batch);
    RUN(an_lz4_frame_one_byte_past_the_window_is_refused);
    RUN(raw_lz4_toward_the_amiga_is_refused);
    RUN(shrink_only_lowers_the_batch_out);
    RUN(a_wrapped_block_over_the_scratch_is_refused);
    RUN(the_longest_real_wrapped_block_decodes);
    return REPORT();
}
