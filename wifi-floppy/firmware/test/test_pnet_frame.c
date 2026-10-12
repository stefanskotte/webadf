/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
#include "harness.h"
#include "../src/pnet_frame.h"
#include "../src/pnet_mfm.h"
#include <stdint.h>
#include <string.h>

/* PaulaNET's cylinder-77 wire format, both directions. */

static uint8_t payload[12000], out[20000], dec[16384];

static void xorshift_fill(uint8_t *p, size_t len, uint32_t seed) {
    uint32_t x = seed;
    for (size_t i = 0; i < len; i++) { x ^= x << 13; x ^= x >> 17; x ^= x << 5; p[i] = (uint8_t)x; }
}

/* Three frames: 64 random bytes, 1500 random bytes, 7 zero bytes. */
static unsigned three_frames(pnet_frame_ref_t *f, uint16_t *lens) {
    xorshift_fill(payload, 1564, 0xC0FFEEu);
    memset(payload + 1564, 0, 7);
    lens[0] = 64; lens[1] = 1500; lens[2] = 7;
    f[0].data = payload;        f[0].len = 64;
    f[1].data = payload + 64;   f[1].len = 1500;
    f[2].data = payload + 1564; f[2].len = 7;
    return 3;
}

static void to_board_header_is_raw_and_checks_out(void) {
    pnet_frame_ref_t f[3]; uint16_t lens[3];
    const unsigned n = three_frames(f, lens);
    const size_t w = pnet_build_to_board(out, sizeof out, 0x05, 0x80, f, n);
    CHECK(w > 0, "built");
    CHECK(out[0] == 0x00 && out[1] == 0x01 && out[2] == 0x00 && out[3] == 0x01, "sync 00 01 00 01");
    CHECK(out[4] == 0x54 && out[5] == 0x50, "raw magic, big-endian");
    CHECK_EQ_INT(out[12], PNET_MODE_ETHERNET);
    CHECK_EQ_INT(out[13], 0x42);   /* 2 "MFM" | 0x40 "from driver", as PaulaNET's driver sends */
    CHECK_EQ_INT(out[14], 0x05);
    CHECK_EQ_INT(out[15], 0x80);
    CHECK(out[w - 2] == 0xAA && out[w - 1] == 0xAA, "AA AA trailer");
    pnet_hdr_t h;
    CHECK_EQ_INT(pnet_parse_hdr_from_amiga(out + 4, w - 4, &h), PNET_OK);
    CHECK_EQ_INT(h.compressed_size, w - 4 - PNET_HDR_BYTES - 2);
    CHECK_EQ_INT(h.data_size, h.compressed_size);
}

static void to_board_frames_round_trip(void) {
    pnet_frame_ref_t f[3]; uint16_t lens[3], got[PNET_MAX_FRAMES];
    const unsigned n = three_frames(f, lens);
    const size_t w = pnet_build_to_board(out, sizeof out, 1, 2, f, n);
    pnet_hdr_t h;
    CHECK_EQ_INT(pnet_parse_hdr_from_amiga(out + 4, w - 4, &h), PNET_OK);
    unsigned m = 0;
    CHECK_EQ_INT(pnet_parse_frames(out + 4 + PNET_HDR_BYTES, h.compressed_size, PNET_TO_BOARD,
                                   dec, sizeof dec, got, PNET_MAX_FRAMES, &m), PNET_OK);
    CHECK_EQ_INT(m, 3);
    CHECK(got[0] == 64 && got[1] == 1500 && got[2] == 7, "lengths");
    CHECK(memcmp(dec, payload, 1571) == 0, "bytes");
}

static void a_damaged_batch_is_refused(void) {
    pnet_frame_ref_t f[3]; uint16_t lens[3];
    const unsigned n = three_frames(f, lens);
    const size_t w = pnet_build_to_board(out, sizeof out, 1, 2, f, n);
    pnet_hdr_t h;
    out[40] ^= 0x10;
    CHECK_EQ_INT(pnet_parse_hdr_from_amiga(out + 4, w - 4, &h), PNET_E_CHECKSUM);
    out[40] ^= 0x10;
    out[4] = 0x55;
    CHECK_EQ_INT(pnet_parse_hdr_from_amiga(out + 4, w - 4, &h), PNET_E_MAGIC);
    out[4] = 0x54;
    /* PaulaNET's receiver wants MORE than header + payload: exactly that much is refused */
    CHECK_EQ_INT(pnet_parse_hdr_from_amiga(out + 4, PNET_HDR_BYTES + h.compressed_size, &h),
                 PNET_E_SIZE);
    CHECK_EQ_INT(pnet_parse_hdr_from_amiga(out + 4, 11, &h), PNET_E_SHORT);
}

static void to_amiga_track_has_lead_in_sync_and_words(void) {
    pnet_frame_ref_t f[3]; uint16_t lens[3];
    const unsigned n = three_frames(f, lens);
    const size_t w = pnet_build_to_amiga(out, sizeof out, 0x05, 0x81, 0, f, n);
    CHECK(w > 0, "built");
    CHECK_EQ_INT(w % 4, 0);
    CHECK(w <= pnet_to_amiga_bound(lens, n), "within the bound");
    int lead = 1;
    for (unsigned i = 0; i < PNET_LEAD_BYTES; i++) if (out[i] != 0xAA) lead = 0;
    CHECK(lead, "120 x AA lead-in");
    CHECK(out[120] == 0x44 && out[121] == 0x89 && out[122] == 0x44 && out[123] == 0x89, "sync");
    pnet_hdr_t h;
    CHECK_EQ_INT(pnet_parse_hdr_to_amiga(out + 124, w - 124, &h, true), PNET_OK);
    CHECK_EQ_INT(h.amiga_ctr, 0x05);
    CHECK_EQ_INT(h.pico_ctr, 0x81);
    CHECK_EQ_INT(h.compressed, 0);
    int trail = 1;
    for (size_t i = 124 + 24 + h.data_size; i < w; i++) if (out[i] != 0xAA) trail = 0;
    CHECK(trail && w - (124 + 24 + h.data_size) >= PNET_TRAIL_BYTES, ">= 120 x AA trailer");
    uint16_t got[PNET_MAX_FRAMES]; unsigned m = 0;
    CHECK_EQ_INT(pnet_parse_frames(out + 148, h.data_size, PNET_TO_AMIGA, dec, sizeof dec, got,
                                   PNET_MAX_FRAMES, &m), PNET_OK);
    CHECK(m == 3 && memcmp(dec, payload, 1571) == 0, "frames round trip");
}

/* Bit 15 of a frame's size means RLE toward the board and MFM toward the Amiga. */
static void the_rle_flag_depends_on_the_direction(void) {
    pnet_frame_ref_t f[3]; uint16_t lens[3], got[PNET_MAX_FRAMES];
    const unsigned n = three_frames(f, lens);
    const size_t w = pnet_build_to_amiga(out, sizeof out, 1, 2, 0, f, n);
    pnet_hdr_t h;
    CHECK_EQ_INT(pnet_parse_hdr_to_amiga(out + 124, w - 124, &h, true), PNET_OK);
    unsigned m = 0;
    CHECK(pnet_parse_frames(out + 148, h.data_size, PNET_TO_BOARD, dec, sizeof dec, got,
                            PNET_MAX_FRAMES, &m) != PNET_OK, "read the wrong way, it must fail");
}

static void an_empty_batch_is_a_bare_header(void) {
    const size_t w = pnet_build_to_amiga(out, sizeof out, 0xFF, 0x7F, 0, NULL, 0);
    CHECK_EQ_INT(w, (120 + 4 + 24 + 120 + 3) & ~3);
    pnet_hdr_t h;
    CHECK_EQ_INT(pnet_parse_hdr_to_amiga(out + 124, w - 124, &h, true), PNET_OK);
    CHECK_EQ_INT(h.data_size, 0);
    uint16_t got[PNET_MAX_FRAMES]; unsigned m = 9;
    CHECK_EQ_INT(pnet_parse_frames(out + 148, 0, PNET_TO_AMIGA, dec, sizeof dec, got,
                                   PNET_MAX_FRAMES, &m), PNET_OK);
    CHECK_EQ_INT(m, 0);
}

/* The Amiga's read starts anywhere in the lead-in, at any bit. */
static void the_amiga_finds_the_sync_at_any_bit(void) {
    static uint8_t buf[2200];
    pnet_frame_ref_t f[1] = {{payload, 1000}};
    xorshift_fill(payload, 1000, 7u);
    const size_t w = pnet_build_to_amiga(out, sizeof out, 3, 4, 0, f, 1);
    for (unsigned k = 0; k < 16; k++) {
        memset(buf, 0xAA, sizeof buf);
        for (size_t i = 0; i < w * 8; i++) {          /* 5 bytes of lead-in, then k bits late */
            const size_t to = 40 + k + i;
            if ((out[i >> 3] >> (7 - (i & 7))) & 1) buf[to >> 3] |= (uint8_t)(0x80u >> (to & 7));
            else buf[to >> 3] &= (uint8_t)~(0x80u >> (to & 7));
        }
        const long at = pnet_find_sync(buf, w + 8, 512);
        CHECK_EQ_INT(at, 40 + (long)k + 124 * 8);
        const size_t valid = pnet_shift_left(buf, w + 8, (size_t)at);
        pnet_hdr_t h;
        CHECK_EQ_INT(pnet_parse_hdr_to_amiga(buf, valid, &h, true), PNET_OK);
        uint16_t got[PNET_MAX_FRAMES]; unsigned m = 0;
        CHECK_EQ_INT(pnet_parse_frames(buf + 24, h.data_size, PNET_TO_AMIGA, dec, sizeof dec, got,
                                       PNET_MAX_FRAMES, &m), PNET_OK);
        CHECK(m == 1 && got[0] == 1000 && memcmp(dec, payload, 1000) == 0, "frame after alignment");
    }
    memset(buf, 0xAA, sizeof buf);
    CHECK_EQ_INT(pnet_find_sync(buf, sizeof buf, 512), -1);
}

/* Review Focus 4: too big for the store or for DF1's 14,336-byte buffer is refused cleanly. */
static void what_does_not_fit_is_refused(void) {
    pnet_frame_ref_t f[3]; uint16_t lens[3], got[PNET_MAX_FRAMES];
    const unsigned n = three_frames(f, lens);
    CHECK_EQ_INT(pnet_build_to_amiga(out, 1000, 1, 2, 0, f, n), 0);
    CHECK_EQ_INT(pnet_build_to_board(out, 100, 1, 2, f, n), 0);
    const size_t w = pnet_build_to_board(out, sizeof out, 1, 2, f, n);
    pnet_hdr_t h;
    CHECK_EQ_INT(pnet_parse_hdr_from_amiga(out + 4, w - 4, &h), PNET_OK);
    unsigned m = 0;
    CHECK_EQ_INT(pnet_parse_frames(out + 16, h.compressed_size, PNET_TO_BOARD, dec, 1000, got,
                                   PNET_MAX_FRAMES, &m), PNET_E_FULL);
    CHECK_EQ_INT(pnet_parse_frames(out + 16, h.compressed_size, PNET_TO_BOARD, dec, sizeof dec, got,
                                   2, &m), PNET_E_FRAMES);
    pnet_frame_ref_t big = {payload, PNET_ETH_MTU + 1};
    CHECK_EQ_INT(pnet_build_to_board(out, sizeof out, 1, 2, &big, 1), 0);
    /* 12,000 bytes in 8 frames, the largest NetLoop sends, fits DF1's 14,336-byte buffer */
    pnet_frame_ref_t g[8]; uint16_t gl[8];
    xorshift_fill(payload, 12000, 3u);
    for (unsigned i = 0; i < 8; i++) {
        gl[i] = 1500;
        g[i].data = payload + 1500u * i; g[i].len = gl[i];
    }
    CHECK(pnet_to_amiga_bound(gl, 8) <= 14336u, "12,000 B echo fits DF1's stream buffer");
    CHECK(pnet_build_to_amiga(out, 14336, 1, 2, 0, g, 8) > 0, "and builds into it");
}

static void shift_left_keeps_whole_bytes_only(void) {
    uint8_t b[4] = {0x0F, 0xF0, 0x0F, 0xF0};
    CHECK_EQ_INT(pnet_shift_left(b, 4, 4), 3);
    CHECK(b[0] == 0xFF && b[1] == 0x00 && b[2] == 0xFF, "nibble shift");
    uint8_t c[3] = {1, 2, 3};
    CHECK_EQ_INT(pnet_shift_left(c, 3, 8), 2);
    CHECK(c[0] == 2 && c[1] == 3, "byte shift");
    CHECK_EQ_INT(pnet_shift_left(c, 3, 24), 0);
}

static void every_error_has_its_own_text(void) {
    for (int e = 0; e < PNET_E_COUNT; e++)
        CHECK(pnet_err_text((pnet_err_t)e) != NULL && pnet_err_text((pnet_err_t)e)[0], "text");
    CHECK(strcmp(pnet_err_text(PNET_E_NOSYNC), "no sync") == 0, "nosync text");
    CHECK(strcmp(pnet_err_text(PNET_E_RANGE), "out of range") == 0, "range text");
    CHECK(strcmp(pnet_err_text(PNET_E_COUNT), "?") == 0, "past the end");
}

/* Phase 2: one frame at a time, as the board now decodes the Amiga's batch into its TX ring. */
static void frames_come_one_at_a_time(void) {
    pnet_frame_ref_t f[3]; uint16_t lens[3];
    const unsigned n = three_frames(f, lens);
    const size_t w = pnet_build_to_board(out, sizeof out, 1, 2, f, n);
    pnet_hdr_t h;
    CHECK_EQ_INT(pnet_parse_hdr_from_amiga(out + 4, w - 4, &h), PNET_OK);
    const uint8_t *pay = out + 4 + PNET_HDR_BYTES;
    pnet_frame_iter_t it;
    CHECK_EQ_INT(pnet_frame_iter_init(&it, pay, h.compressed_size, PNET_TO_BOARD), PNET_OK);
    CHECK_EQ_INT(it.count, 3);
    size_t at = 0;
    for (unsigned i = 0; i < 3; i++) {
        uint16_t len = 0;
        CHECK_EQ_INT(pnet_frame_iter_next(&it, dec, PNET_ETH_MTU, &len), PNET_OK);
        CHECK_EQ_INT(len, lens[i]);
        CHECK(memcmp(dec, payload + at, len) == 0, "the frame's bytes");
        at += len;
    }
    uint16_t len = 0;
    CHECK_EQ_INT(pnet_frame_iter_next(&it, dec, PNET_ETH_MTU, &len), PNET_E_FRAMES);   /* none left */
    CHECK_EQ_INT(pnet_frame_iter_init(&it, pay, 0, PNET_TO_BOARD), PNET_OK);
    CHECK_EQ_INT(it.count, 0);                                                         /* an empty payload */
    CHECK_EQ_INT(pnet_frame_iter_init(&it, pay, 3, PNET_TO_BOARD), PNET_E_FRAMES);     /* under 4 bytes */
    CHECK_EQ_INT(pnet_frame_iter_init(&it, pay, h.compressed_size, PNET_TO_BOARD), PNET_OK);
    CHECK_EQ_INT(pnet_frame_iter_next(&it, dec, 63, &len), PNET_E_FULL);               /* 64 bytes into 63 */
    CHECK_EQ_INT(it.i, 0);                                                             /* an error stays put */
}

/* Phase 2: cylinder 76's header is mode 2 with an RLE payload; its checksum covers the bytes sent. */
static void a_mode_2_rle_header_parses_as_mode_2_only(void) {
    uint8_t rec[4 + PNET_HDR_MFM_BYTES + 32];
    uint8_t pay[32];
    for (unsigned i = 0; i < sizeof pay; i++) pay[i] = (uint8_t)(0x81u + i);
    const pnet_hdr_t h = { .checksum = pnet_checksum(pay, sizeof pay), .data_size = 156, .compressed_size = 32,
                           .mode = 2, .compressed = 1, .amiga_ctr = 0x37, .pico_ctr = 0x81 };
    CHECK_EQ_INT(pnet_put_hdr_to_amiga(rec, &h), 4 + PNET_HDR_MFM_BYTES);
    CHECK(rec[0] == 0x44 && rec[1] == 0x89 && rec[2] == 0x44 && rec[3] == 0x89, "the sync");
    memcpy(rec + 4 + PNET_HDR_MFM_BYTES, pay, sizeof pay);
    pnet_hdr_t g;
    CHECK_EQ_INT(pnet_parse_hdr_to_amiga_as(rec + 4, sizeof rec - 4, &g, true, 2), PNET_OK);
    CHECK(g.data_size == 156 && g.compressed_size == 32 && g.compressed == 1 && g.amiga_ctr == 0x37 &&
          g.pico_ctr == 0x81, "the fields");
    CHECK_EQ_INT(pnet_parse_hdr_to_amiga(rec + 4, sizeof rec - 4, &g, true), PNET_E_MODE);   /* not cylinder 77's */
    rec[sizeof rec - 1] ^= 1u;
    CHECK_EQ_INT(pnet_parse_hdr_to_amiga_as(rec + 4, sizeof rec - 4, &g, true, 2), PNET_E_CHECKSUM);
}

int main(void) {
    RUN(to_board_header_is_raw_and_checks_out);
    RUN(to_board_frames_round_trip);
    RUN(a_damaged_batch_is_refused);
    RUN(to_amiga_track_has_lead_in_sync_and_words);
    RUN(the_rle_flag_depends_on_the_direction);
    RUN(an_empty_batch_is_a_bare_header);
    RUN(the_amiga_finds_the_sync_at_any_bit);
    RUN(what_does_not_fit_is_refused);
    RUN(shift_left_keeps_whole_bytes_only);
    RUN(every_error_has_its_own_text);
    RUN(frames_come_one_at_a_time);
    RUN(a_mode_2_rle_header_parses_as_mode_2_only);
    return REPORT();
}
