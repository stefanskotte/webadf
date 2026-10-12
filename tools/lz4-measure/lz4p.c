/*
 * lz4p: a PROTOTYPE LZ4 block compressor shaped for a 68000 (research, not product code).
 * Our own, written from the public LZ4 block format description
 * (https://github.com/lz4/lz4/blob/dev/doc/lz4_Block_format.md); no LZ4 library code.
 *
 * This C file is the reference model: m68k/lz4p.S must produce exactly these bytes, which
 * lz4bench checks under vamos, and the host checks that the reference liblz4 decodes them.
 *
 * Greedy, one hash probe per position, like LZ4's fast mode, with choices that suit a 68000:
 *   - the 4 bytes at a position are read with one aligned long (an odd position: the long at
 *     pos - 1, shifted, plus one byte), so src must be at an even address;
 *   - hash: x = hi16 ^ lo16 of those 4 bytes; h = (x ^ (x >> 5)) & (LZ4P_HASH - 1);
 *   - the table holds 16-bit positions and is never cleared: an entry at or past the current
 *     position is ignored, any other is only a candidate whose 4 bytes are compared, so stale
 *     entries from an earlier frame cost a compare, never a wrong match;
 *   - the step grows by one every 64 misses since the last match (LZ4's skip strength 6), so
 *     incompressible data is crossed quickly;
 *   - a match is extended forwards to 5 bytes before the end, and backwards into the pending
 *     literals; no table insert inside a match;
 *   - the LZ4 end rules: the last match starts at least 12 bytes before the end, the last 5
 *     bytes are literals.
 * Returns the block's size, or 0 if it would be larger than cap (the caller then sends RLE).
 */
#include "lz4p.h"

static uint32_t rd4(const uint8_t *s, size_t p) {
    return (uint32_t)s[p] << 24 | (uint32_t)s[p + 1] << 16 | (uint32_t)s[p + 2] << 8 | s[p + 3];
}

static unsigned hash(uint32_t v) {
    unsigned x = (unsigned)((v >> 16) ^ (v & 0xFFFFu));
    return (x ^ (x >> 5)) & (LZ4P_HASH - 1u);
}

static size_t put_len(uint8_t *d, size_t o, size_t len) {   /* the 255-run after a nibble of 15 */
    while (len >= 255) { d[o++] = 255; len -= 255; }
    d[o++] = (uint8_t)len;
    return o;
}

size_t lz4p_encode(const uint8_t *src, size_t n, uint8_t *dst, size_t cap, uint16_t *tab) {
    size_t pos = 0, anchor = 0, o = 0;
    unsigned misses = 0;
    if (n >= 13) {
        const size_t mflimit = n - 12, mend = n - 5;
        while (pos <= mflimit) {
            const uint32_t v = rd4(src, pos);
            const unsigned h = hash(v);
            const size_t ref0 = tab[h];
            tab[h] = (uint16_t)pos;
            if (ref0 >= pos || rd4(src, ref0) != v) {
                pos += 1u + (misses++ >> 6);
                continue;
            }
            size_t ref = ref0, len = 4;
            while (pos + len < mend && src[ref + len] == src[pos + len]) len++;
            while (pos > anchor && ref > 0 && src[pos - 1] == src[ref - 1]) { pos--; ref--; len++; }
            const size_t lit = pos - anchor, ml = len - 4;
            if (5 + lit + (lit >> 7) + (ml >> 7) > cap - o) return 0;   /* >= the true size */
            const size_t tok = o++;
            dst[tok] = (uint8_t)((lit >= 15 ? 15 : lit) << 4 | (ml >= 15 ? 15 : ml));
            if (lit >= 15) o = put_len(dst, o, lit - 15);
            for (size_t i = 0; i < lit; i++) dst[o++] = src[anchor + i];
            const size_t off = pos - ref;
            dst[o++] = (uint8_t)off;                 /* little-endian, as the format says */
            dst[o++] = (uint8_t)(off >> 8);
            if (ml >= 15) o = put_len(dst, o, ml - 15);
            pos += len;
            anchor = pos;
            misses = 0;
        }
    }
    const size_t lit = n - anchor;
    if (2 + lit + (lit >> 7) > cap - o) return 0;
    dst[o++] = (uint8_t)((lit >= 15 ? 15 : lit) << 4);
    if (lit >= 15) o = put_len(dst, o, lit - 15);
    for (size_t i = 0; i < lit; i++) dst[o++] = src[anchor + i];
    return o;
}
