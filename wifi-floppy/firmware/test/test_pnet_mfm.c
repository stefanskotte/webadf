#include "harness.h"
#include "../src/pnet_mfm.h"
#include <stdint.h>
#include <string.h>

/*
 * PaulaNET's byte codecs. Vectors marked GOLDEN are the OUTPUT of RobSmithDev's reference
 * encoders (PaulaNET 0afd5fa: Pico/PaulaNET/rleCompression.cpp and the Pico's mfmEncode), run on
 * a host on 2026-10-09. No code of his is here. PaulaNET protocol (C) 2026 RobSmithDev, used with
 * permission (THIRD-PARTY-NOTICES.md).
 */

static void xorshift_fill(uint8_t *out, size_t len, uint32_t seed) {
    uint32_t x = seed;
    for (size_t i = 0; i < len; i++) {
        x ^= x << 13; x ^= x >> 17; x ^= x << 5;
        out[i] = (uint8_t)(x & 0xffu);
    }
}

static void mfm_matches_the_reference_encoder(void) {   /* GOLDEN */
    const uint8_t in[] = {0x00, 0xFF, 0x54, 0x50, 0xA5, 0x01};
    const uint8_t want[] = {0xAA, 0xAA, 0x55, 0x55, 0x2A, 0x54, 0xAA, 0x52, 0x52, 0xA5, 0x2A, 0xA9};
    uint8_t out[sizeof want];
    uint16_t last = 0;
    CHECK_EQ_INT(pnet_mfm_encode(in, sizeof in, out, &last), sizeof want);
    CHECK(memcmp(out, want, sizeof want) == 0, "MFM words differ from PaulaNET's encoder");
    CHECK_EQ_INT(last, 0x2AA9);
}

static void mfm_decodes_every_byte_back(void) {
    uint8_t in[256], enc[512], back[256];
    uint16_t last = 0;
    for (int i = 0; i < 256; i++) in[i] = (uint8_t)i;
    pnet_mfm_encode(in, 256, enc, &last);
    pnet_mfm_decode(enc, 256, back);
    CHECK(memcmp(in, back, 256) == 0, "decode(encode(b)) != b");
}

/* Legal MFM across word boundaries: never two 1 cells together, never four 0 cells in a row. */
static void mfm_output_is_legal_mfm(void) {
    uint8_t in[600], enc[1200];
    uint16_t last = 0;
    xorshift_fill(in, sizeof in, 99u);
    pnet_mfm_encode(in, sizeof in, enc, &last);
    int prev = 0, zeros = 0, bad = 0;
    for (size_t b = 0; b < sizeof enc * 8u; b++) {
        const int bit = (enc[b >> 3] >> (7u - (b & 7u))) & 1;
        if (bit) { if (prev) bad++; zeros = 0; }
        else if (++zeros > 3) bad++;
        prev = bit;
    }
    CHECK_EQ_INT(bad, 0);
}

static void checksum_is_the_xor_of_big_endian_words(void) {
    const uint8_t a[] = {0x12, 0x34, 0x56, 0x78};
    CHECK_EQ_INT(pnet_checksum(a, 4), 0x444C);
    const uint8_t b[] = {0xAB};
    CHECK_EQ_INT(pnet_checksum(b, 1), 0xAB00);
    CHECK_EQ_INT(pnet_checksum(a, 0), 0);
}

static void check_rle(const uint8_t *in, size_t n, const uint8_t *want, size_t wn, const char *what) {
    uint8_t out[2048], back[2048];
    const size_t got = pnet_rle_encode(in, n, out);
    CHECK_EQ_INT(got, wn);
    CHECK(got == wn && memcmp(out, want, wn) == 0, what);
    CHECK_EQ_INT(pnet_rle_decode(out, got, back, sizeof back), (long)n);
    CHECK(memcmp(back, in, n) == 0, "decode(encode(x)) != x");
}

static void rle_matches_the_reference_encoder(void) {   /* GOLDEN */
    const uint8_t r1[] = {1, 2, 3, 3, 3, 3, 0, 0, 0, 0, 0, 9};
    const uint8_t w1[] = {0x82, 0x01, 0x02, 0x04, 0x03, 0x05, 0x00, 0x81, 0x09, 0x00};
    check_rle(r1, sizeof r1, w1, sizeof w1, "mixed literals and runs");
    const uint8_t r2[] = {7};
    const uint8_t w2[] = {0x81, 0x07};
    check_rle(r2, sizeof r2, w2, sizeof w2, "one byte");
    uint8_t r3[300];
    memset(r3, 0xAB, sizeof r3);
    const uint8_t w3[] = {0x7F, 0xAB, 0x7F, 0xAB, 0x2E, 0xAB};
    check_rle(r3, sizeof r3, w3, sizeof w3, "a 300-byte run splits at 127");
    const uint8_t r5[] = {5, 5, 6, 6, 7};
    const uint8_t w5[] = {0x85, 0x05, 0x05, 0x06, 0x06, 0x07};
    check_rle(r5, sizeof r5, w5, sizeof w5, "pairs stay literal");
}

static void rle_literal_blocks_split_at_127(void) {   /* GOLDEN: 130 distinct bytes */
    uint8_t in[130], out[256];
    for (int i = 0; i < 130; i++) in[i] = (uint8_t)(i * 7 + 1);
    const size_t n = pnet_rle_encode(in, sizeof in, out);
    CHECK_EQ_INT(n, 132);
    CHECK_EQ_INT(out[0], 0xFF);
    CHECK_EQ_INT(out[128], 0x83);
    CHECK(memcmp(out + 1, in, 127) == 0 && memcmp(out + 129, in + 127, 3) == 0, "literal bytes");
}

static void rle_of_random_data_matches_and_fits_the_bound(void) {   /* GOLDEN */
    uint8_t in[1500], out[1600], back[1500];
    xorshift_fill(in, sizeof in, 0x12345678u);
    const size_t n = pnet_rle_encode(in, sizeof in, out);
    CHECK_EQ_INT(n, 1512);
    CHECK(out[0] == 0xFF && out[1] == 0xA5 && out[n - 2] == 0xC5 && out[n - 1] == 0x54,
          "head or tail differs from PaulaNET's encoder");
    CHECK(n <= pnet_rle_bound(sizeof in), "over pnet_rle_bound");
    CHECK_EQ_INT(pnet_rle_decode(out, n, back, sizeof back), 1500);
    CHECK(memcmp(back, in, sizeof in) == 0, "round trip");
}

/* Review Focus 5: malformed RLE never reads past n or writes past cap. */
static void rle_decoder_refuses_what_it_cannot_finish(void) {
    uint8_t out[16];
    const uint8_t trunc_lit[] = {0x85, 1, 2};            /* says 5 literals, has 2 */
    CHECK_EQ_INT(pnet_rle_decode(trunc_lit, sizeof trunc_lit, out, sizeof out), -1);
    const uint8_t trunc_run[] = {0x05};                  /* a repeat with no byte to repeat */
    CHECK_EQ_INT(pnet_rle_decode(trunc_run, sizeof trunc_run, out, sizeof out), -1);
    const uint8_t too_big[] = {0x7F, 0x00};              /* 127 bytes into 16 */
    CHECK_EQ_INT(pnet_rle_decode(too_big, sizeof too_big, out, sizeof out), -1);
    const uint8_t padded[] = {0x03, 0x41, 0x00};         /* the even-length pad is skipped */
    CHECK_EQ_INT(pnet_rle_decode(padded, sizeof padded, out, sizeof out), 3);
    CHECK(out[0] == 0x41 && out[1] == 0x41 && out[2] == 0x41, "AAA");
    const uint8_t zero_mid[] = {0x00, 0x82, 0x10, 0x20}; /* a zero control mid-stream is a no-op */
    CHECK_EQ_INT(pnet_rle_decode(zero_mid, sizeof zero_mid, out, sizeof out), 2);
}

int main(void) {
    RUN(mfm_matches_the_reference_encoder);
    RUN(mfm_decodes_every_byte_back);
    RUN(mfm_output_is_legal_mfm);
    RUN(checksum_is_the_xor_of_big_endian_words);
    RUN(rle_matches_the_reference_encoder);
    RUN(rle_literal_blocks_split_at_127);
    RUN(rle_of_random_data_matches_and_fits_the_bound);
    RUN(rle_decoder_refuses_what_it_cannot_finish);
    return REPORT();
}
