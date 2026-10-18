/*
 * PaulaNET LZ4 (spec 2026-10-18 §5-§6): the board's LZ4 block codec against the reference liblz4 (BSD-2, the
 * referee) and against m68k/lz4/lz4_68k.c, the C model the driver's 68000 encoder matches bit for bit.
 */
#include "harness.h"
#include "lz4_corpus.h"
#include "../src/pnet_lz4.h"
#include <lz4.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "../../../m68k/lz4/lz4_68k.c"

static uint8_t g_src[PNET_LZ4_WINDOW], g_blk[PNET_LZ4_WINDOW + 64], g_out[PNET_LZ4_WINDOW + 64];
static uint16_t g_tab[PNET_LZ4_TABLE_ENTRIES], g_tab2[PNET_LZ4_TABLE_ENTRIES];
static const int KINDS[] = { LC_TEXT, LC_HTML, LC_RANDOM, LC_ZEROS, LC_TEXT_ZERO_TAIL };
#define NKINDS (sizeof KINDS / sizeof KINDS[0])

static void decodes_liblz4_blocks(void) {
    unsigned bad = 0, cases = 0;
    for (unsigned k = 0; k < NKINDS; k++)
        for (size_t n = 1; n <= PNET_ETH_MTU; n += (n < 64u ? 1u : 37u)) {
            lc_frame(g_src, n, KINDS[k], (uint32_t)n);
            const int z = LZ4_compress_default((const char *)g_src, (char *)g_blk, (int)n, (int)sizeof g_blk);
            memset(g_out, 0xEE, n + 16u);
            const long got = pnet_lz4_decode(g_blk, (size_t)z, g_out, g_out + n, g_out);
            if (got != (long)n || memcmp(g_out, g_src, n) != 0 || g_out[n] != 0xEE) bad++;
            cases++;
        }
    CHECK(cases > 500, "cases");
    CHECK_EQ_INT(bad, 0);
}

/* liblz4's streaming mode over one contiguous buffer is exactly the batch's linking: each block may refer back into
 * the frames before it. */
static void decodes_liblz4_linked_blocks(void) {
    LZ4_stream_t st;
    LZ4_initStream(&st, sizeof st);
    size_t pos = 0;
    unsigned frames = 0, bad = 0;
    memset(g_out, 0, sizeof g_out);
    while (pos + PNET_ETH_MTU <= PNET_LZ4_WINDOW) {
        const size_t n = 200u + (frames * 97u) % 1319u;
        lc_frame(g_src + pos, n, frames % 3u == 2u ? LC_HTML : LC_TEXT, frames);
        const int z = LZ4_compress_fast_continue(&st, (const char *)g_src + pos, (char *)g_blk, (int)n,
                                                 (int)sizeof g_blk, 1);
        const long got = pnet_lz4_decode(g_blk, (size_t)z, g_out + pos, g_out + pos + n, g_out);
        if (got != (long)n || memcmp(g_out + pos, g_src + pos, n) != 0) bad++;
        pos += n;
        frames++;
    }
    CHECK(frames >= 10, "a window's worth of frames");
    CHECK_EQ_INT(bad, 0);
}

static void its_blocks_decode_with_liblz4(void) {
    for (unsigned e = 0; e < 2; e++) {
        const unsigned entries = e ? 4096u : 1024u;
        memset(g_tab, 0, sizeof g_tab);
        size_t pos = 0, linked = 0, alone = 0;
        unsigned frames = 0, bad = 0;
        while (pos + PNET_ETH_MTU <= PNET_LZ4_WINDOW) {
            const size_t n = 64u + (frames * 131u) % 1455u;
            lc_frame(g_src + pos, n, KINDS[frames % NKINDS], frames + 100u * e);
            const size_t z = pnet_lz4_encode_linked(g_src + pos, n, g_blk, sizeof g_blk, g_tab, entries, g_src);
            const int got = LZ4_decompress_safe_usingDict((const char *)g_blk, (char *)g_out + pos, (int)z, (int)n,
                                                          (const char *)g_out, (int)pos);
            if (z == 0 || got != (int)n || memcmp(g_out + pos, g_src + pos, n) != 0) bad++;
            memset(g_tab2, 0, sizeof g_tab2);
            alone += pnet_lz4_encode_linked(g_src + pos, n, g_blk, sizeof g_blk, g_tab2, entries, g_src + pos);
            linked += z;
            pos += n;
            frames++;
        }
        CHECK_EQ_INT(bad, 0);
        CHECK(linked < alone, "linking to the batch's earlier frames makes it smaller");
    }
}

static void the_encoder_is_the_68k_model_byte_for_byte(void) {
    static uint8_t a[PNET_LZ4_WINDOW], b[PNET_LZ4_WINDOW];
    unsigned diff = 0, cases = 0;
    for (unsigned e = 0; e < 2; e++) {
        const unsigned entries = e ? 4096u : 1024u;
        memset(g_tab, 0, sizeof g_tab);
        memset(g_tab2, 0, sizeof g_tab2);
        size_t pos = 0;
        unsigned f = 0;
        while (pos + PNET_ETH_MTU <= PNET_LZ4_WINDOW) {
            const size_t n = 1u + (f * 211u) % PNET_ETH_MTU;
            lc_frame(g_src + pos, n, KINDS[f % NKINDS], f + 7u);
            const size_t cap = f % 4u == 3u ? n - 1u : sizeof a;     /* every 4th with the board's cap */
            const size_t za = pnet_lz4_encode_linked(g_src + pos, n, a, cap, g_tab, entries, g_src);
            const unsigned long zb = lz4_encode_linked_ref(g_src + pos, n, b, cap, g_tab2, entries, g_src);
            if (za != zb || memcmp(a, b, za) != 0 || memcmp(g_tab, g_tab2, sizeof g_tab) != 0) diff++;
            cases++;
            pos += n;
            f++;
        }
    }
    CHECK(cases > 20, "cases");
    CHECK_EQ_INT(diff, 0);
}

static void the_cap_is_exact(void) {
    unsigned bad = 0;
    for (unsigned k = 0; k < NKINDS; k++)
        for (size_t n = 1; n <= PNET_ETH_MTU; n += 89u) {
            lc_frame(g_src, n, KINDS[k], (uint32_t)(n + k));
            memset(g_tab, 0, sizeof g_tab);
            const size_t s = pnet_lz4_encode_linked(g_src, n, g_blk, sizeof g_blk, g_tab, 4096, g_src);
            memset(g_tab, 0, sizeof g_tab);
            memset(g_out, 0xEE, sizeof g_out);
            const size_t at = pnet_lz4_encode_linked(g_src, n, g_out, s, g_tab, 4096, g_src);
            memset(g_tab, 0, sizeof g_tab);
            const size_t under = pnet_lz4_encode_linked(g_src, n, g_out + 4096, s - 1u, g_tab, 4096, g_src);
            if (s == 0 || at != s || under != 0 || g_out[s] != 0xEE || g_out[4096u + s - 1u] != 0xEE) bad++;
        }
    CHECK_EQ_INT(bad, 0);
}

/* Every cap from 0 to one past the block's size, for inputs long enough to hold many sequences, so the cap also
 * falls inside a sequence that ends in a match and not only in the final literals: the result is the block exactly
 * when it fits and 0 otherwise, nothing is written at or past dst + cap, and a block decodes back to its input. */
static void every_cap_is_honoured(void) {
    static const size_t SIZES[] = { 13, 20, 64, 200, 777, PNET_ETH_MTU };
    static uint8_t blk[PNET_LZ4_BLOCK_MAX + 2 + 64];
    unsigned bad = 0, overrun = 0, caps = 0;
    for (unsigned k = 0; k <= NKINDS; k++)
        for (unsigned z = 0; z < sizeof SIZES / sizeof SIZES[0]; z++) {
            const uint8_t *in = g_src;
            size_t n = SIZES[z];
            if (k == NKINDS) { if (z) break; in = SAME_SIZE; n = sizeof SAME_SIZE; }
            else lc_frame(g_src, n, KINDS[k], (uint32_t)(z * 31u + k));
            memset(g_tab, 0, sizeof g_tab);
            const size_t s = pnet_lz4_encode_linked(in, n, g_blk, sizeof g_blk, g_tab, 4096, in);
            if (s == 0 || s > PNET_LZ4_BLOCK_MAX) { bad++; continue; }
            for (size_t cap = 0; cap <= s + 1u; cap++) {
                memset(blk, 0xEE, sizeof blk);
                memset(g_tab, 0, sizeof g_tab);
                const size_t got = pnet_lz4_encode_linked(in, n, blk, cap, g_tab, 4096, in);
                for (size_t i = cap; i < cap + 64u; i++) if (blk[i] != 0xEE) overrun++;
                if (got != (cap >= s ? s : 0u)) bad++;
                if (got && (LZ4_decompress_safe((const char *)blk, (char *)g_out, (int)got, (int)sizeof g_out) !=
                                (int)n || memcmp(g_out, in, n) != 0)) bad++;
                caps++;
            }
        }
    CHECK(caps > 5000, "caps");
    CHECK_EQ_INT(overrun, 0);
    CHECK_EQ_INT(bad, 0);
}

/* Review Focus, sizes at the edges: the board encodes with cap = len - 1, so a block as long as its frame is not used. */
static void a_block_as_long_as_its_frame_is_not_used(void) {
    memset(g_tab, 0, sizeof g_tab);
    CHECK_EQ_INT(pnet_lz4_encode_linked(SAME_SIZE, 20, g_blk, sizeof g_blk, g_tab, 4096, SAME_SIZE), 20);
    memset(g_tab, 0, sizeof g_tab);
    CHECK_EQ_INT(pnet_lz4_encode_linked(SAME_SIZE, 20, g_blk, 19, g_tab, 4096, SAME_SIZE), 0);
}

static void incompressible_frames_never_shrink(void) {
    lc_frame(g_src, PNET_ETH_MTU, LC_RANDOM, 99);
    memset(g_tab, 0, sizeof g_tab);
    CHECK_EQ_INT(pnet_lz4_encode_linked(g_src, PNET_ETH_MTU, g_blk, PNET_ETH_MTU - 1u, g_tab, 4096, g_src), 0);
    memset(g_tab, 0, sizeof g_tab);
    const size_t z = pnet_lz4_encode_linked(g_src, PNET_ETH_MTU, g_blk, sizeof g_blk, g_tab, 4096, g_src);
    CHECK(z > PNET_ETH_MTU && z <= PNET_LZ4_BLOCK_MAX, "an MTU of random bytes fits PNET_LZ4_BLOCK_MAX");
}

/* Review Focus, malformed LZ4: random and damaged blocks never write outside dst..dst_end (nor into the window
 * before it), and whatever both decoders accept decodes the same. Each block is decoded from a heap copy of exactly
 * its length, so a read past its end is outside any object: run.sh builds this test with ASan, which reports it. */
static void malformed_blocks_never_write_out_of_bounds(void) {
    static uint8_t buf[2048 + PNET_ETH_MTU + 64], ref[2048 + PNET_ETH_MTU + 64];
    uint32_t s = 12345;
    unsigned outside = 0, disagree = 0, both = 0;
    for (unsigned t = 0; t < 20000; t++) {
        size_t n, cap = 1u + lc_next(&s) % PNET_ETH_MTU;
        if (t % 2u) {                                       /* a valid block, damaged */
            const size_t m = 1u + lc_next(&s) % PNET_ETH_MTU;
            lc_frame(g_src, m, KINDS[t % NKINDS], t);
            n = (size_t)LZ4_compress_default((const char *)g_src, (char *)g_blk, (int)m, (int)sizeof g_blk);
            switch (lc_next(&s) % 3u) {
            case 0: n = lc_next(&s) % n; break;                                              /* truncated */
            case 1: g_blk[lc_next(&s) % n] ^= (uint8_t)(1u << (lc_next(&s) % 8u)); break;    /* one bit */
            default: g_blk[lc_next(&s) % n] = (uint8_t)lc_next(&s); break;                   /* one byte */
            }
            cap = m;
        } else {                                            /* random bytes */
            n = 1u + lc_next(&s) % 64u;
            for (size_t i = 0; i < n; i++) g_blk[i] = (uint8_t)lc_next(&s);
        }
        memset(buf, 0x55, sizeof buf);
        uint8_t *dst = buf + 2048;
        uint8_t *const exact = malloc(n ? n : 1u);
        if (!exact) { outside++; break; }
        memcpy(exact, g_blk, n);
        const long got = pnet_lz4_decode(exact, n, dst, dst + cap, dst - 1024);
        free(exact);
        for (size_t i = 0; i < 2048; i++) if (buf[i] != 0x55) outside++;            /* the window is read only */
        for (size_t i = 2048 + cap; i < sizeof buf; i++) if (buf[i] != 0x55) outside++;
        if (got > (long)cap || got < -1) outside++;
        memset(ref, 0x55, sizeof ref);
        const int r = LZ4_decompress_safe_usingDict((const char *)g_blk, (char *)ref + 2048, (int)n, (int)cap,
                                                    (const char *)ref + 1024, 1024);
        if (got >= 0 && r >= 0) {
            both++;
            if (r != got || memcmp(ref + 2048, dst, (size_t)got) != 0) disagree++;
        }
    }
    CHECK_EQ_INT(outside, 0);
    CHECK_EQ_INT(disagree, 0);
    CHECK(both > 0, "some damaged blocks still decode, and then as liblz4 decodes them");
}

static void a_match_below_the_window_or_at_offset_0_is_refused(void) {
    /* token 0x10: 1 literal, a 4-byte match at offset 2 (one byte before the frame), then 5 literals */
    static const uint8_t below[] = { 0x10, 'A', 0x02, 0x00, 0x50, 'b', 'c', 'd', 'e', 'f' };
    static const uint8_t zero[] = { 0x10, 'A', 0x00, 0x00, 0x50, 'b', 'c', 'd', 'e', 'f' };
    static const uint8_t empty[] = { 0x00 };
    uint8_t out[32];
    memset(out, 0, sizeof out);
    CHECK_EQ_INT(pnet_lz4_decode(below, sizeof below, out + 8, out + 32, out + 8), -1);
    CHECK_EQ_INT(pnet_lz4_decode(below, sizeof below, out + 8, out + 32, out + 7), 10);   /* one byte of window */
    CHECK_EQ_INT(pnet_lz4_decode(zero, sizeof zero, out + 8, out + 32, out), -1);
    CHECK_EQ_INT(pnet_lz4_decode(empty, 1, out, out + 32, out), 0);
    CHECK_EQ_INT(pnet_lz4_decode(empty, 0, out, out + 32, out), -1);
    CHECK_EQ_INT(pnet_lz4_decode(below, sizeof below, out + 8, out + 12, out + 7), -1);   /* past dst_end */
}

/* Fix round 1 (controller's ruling, spec §2): every frame at an even window offset; after an odd-length frame one 0x00
 * pad byte, written over whatever the window held. */
static void the_window_pads_an_odd_frame_with_a_zero(void) {
    uint8_t w[16];
    memset(w, 0xAA, sizeof w);
    CHECK_EQ_INT(pnet_lz4_win_advance(w, 0, 5), 6);
    CHECK_EQ_INT(w[5], 0);
    CHECK_EQ_INT(w[6], 0xAA);
    CHECK_EQ_INT(pnet_lz4_win_advance(w, 6, 4), 10);
    CHECK_EQ_INT(w[10], 0xAA);                            /* an even frame: no pad, nothing written */
    CHECK_EQ_INT(pnet_lz4_win_advance(w, 10, 5), 16);     /* the pad of a frame ending at the window's last byte - 1 */
    CHECK_EQ_INT(w[15], 0);
    CHECK_EQ_INT(PNET_LZ4_WIN_BYTES(1517), 1518);
    CHECK_EQ_INT(PNET_LZ4_WIN_BYTES(1518), 1518);
}

int main(void) {
    RUN(decodes_liblz4_blocks);
    RUN(decodes_liblz4_linked_blocks);
    RUN(its_blocks_decode_with_liblz4);
    RUN(the_encoder_is_the_68k_model_byte_for_byte);
    RUN(the_cap_is_exact);
    RUN(every_cap_is_honoured);
    RUN(a_block_as_long_as_its_frame_is_not_used);
    RUN(incompressible_frames_never_shrink);
    RUN(malformed_blocks_never_write_out_of_bounds);
    RUN(a_match_below_the_window_or_at_offset_0_is_refused);
    RUN(the_window_pads_an_odd_frame_with_a_zero);
    return REPORT();
}
