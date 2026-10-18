/*
 * lz4_68k.c: the portable C reference model of lz4_68k.asm's LZ4 block encoder.
 *
 * Copyright (c) 2026 Stefan Skotte and contributors. MIT licence (LICENSE in this directory).
 * Written from the LZ4 block format description (github.com/lz4/lz4, doc/lz4_Block_format.md);
 * no code copied from any implementation.
 *
 * lz4_68k.asm's lz4_encode and lz4_encode_linked produce exactly the bytes these functions do,
 * from the same arguments and the same hash table contents (the tests check that under an
 * emulated 68000). The model is plain C and runs anywhere; it is the specification of the asm.
 *
 * The algorithm (greedy, one hash probe per position, LZ4's "fast" shape):
 *   - Positions are counted from `base` (the window start: src itself, or for a linked block the
 *     start of the earlier data it may refer to) and must stay below 65536.
 *   - The 4 bytes b0 b1 b2 b3 at a position are seen as X = b0:b2 and Y = b1:b3 (the 68000
 *     reads both with MOVEP at any address); the hash is h = ((2X + Y) mod 65536 >> 1) masked
 *     to the table size, i.e. bits 1.. of 2X + Y.
 *   - The table holds 16-bit positions XOR 0x8000 and is never cleared: an entry at or past the
 *     current position is ignored; any other is only a candidate whose 4 bytes are compared, so
 *     a stale entry costs a compare, never a wrong match.
 *   - Skip strength 6: the step grows by one every 64 misses since the last match.
 *   - A match is extended forwards up to 5 bytes before the end, and backwards into the pending
 *     literals (down to the window start); no table update inside a match.
 *   - The LZ4 end rules: a match starts at least 12 bytes before the end; the last 5 bytes are
 *     literals.
 *   - n > 65535, a window after src, or (src - window) + n > 65536: the result is 0.
 *   - The cap is exact: the result is the block's size if it is <= cap, else 0, and nothing is
 *     ever written at or past dst + cap.
 */
#include <stddef.h>
#include "lz4_68k.h"

static size_t extlen(size_t x) { return x < 15 ? 0 : (x - 15) / 255 + 1; }

static size_t put_len(uint8_t *d, size_t o, size_t len) {   /* the 255-run after a nibble of 15 */
    while (len >= 255) { d[o++] = 255; len -= 255; }
    d[o++] = (uint8_t)len;
    return o;
}

unsigned long lz4_encode_linked_ref(const void *srcv, unsigned long n, void *dstv, unsigned long cap,
                                    uint16_t *tab, unsigned long entries, const void *basev) {
    const uint8_t *base = basev, *src = srcv;
    uint8_t *dst = dstv;
    if (n > 65535 || base > src || (unsigned long)(src - base) + n > 65536) return 0;
    const size_t p0 = (size_t)(src - base), end = p0 + n;
    const unsigned mask = (unsigned)(entries - 1) << 1;
    size_t pos = p0, anchor = p0, o = 0;
    unsigned long misses = 0;
    if (n >= 13) {
        const size_t mflimit = end - 12, mend = end - 5;
        while (pos <= mflimit) {
            const uint8_t *p = base + pos;
            const unsigned X = (unsigned)p[0] << 8 | p[2], Y = (unsigned)p[1] << 8 | p[3];
            const unsigned h = ((2u * X + Y) & mask) >> 1;
            size_t ref = tab[h] ^ 0x8000u;
            tab[h] = (uint16_t)(pos ^ 0x8000u);
            if (ref >= pos || base[ref] != p[0] || base[ref + 1] != p[1] || base[ref + 2] != p[2] ||
                base[ref + 3] != p[3]) {
                pos += 1 + (misses++ >> 6);
                continue;
            }
            size_t len = 4;
            while (pos + len < mend && base[ref + len] == base[pos + len]) len++;
            while (pos > anchor && ref > 0 && base[pos - 1] == base[ref - 1]) { pos--; ref--; len++; }
            const size_t lit = pos - anchor, ml = len - 4;
            if (3 + lit + extlen(lit) + extlen(ml) > cap - o) return 0;
            const size_t tok = o++;
            dst[tok] = (uint8_t)((lit >= 15 ? 15 : lit) << 4 | (ml >= 15 ? 15 : ml));
            if (lit >= 15) o = put_len(dst, o, lit - 15);
            for (size_t i = 0; i < lit; i++) dst[o++] = base[anchor + i];
            const size_t off = pos - ref;
            dst[o++] = (uint8_t)off;                 /* little-endian, as the format says */
            dst[o++] = (uint8_t)(off >> 8);
            if (ml >= 15) o = put_len(dst, o, ml - 15);
            pos += len;
            anchor = pos;
            misses = 0;
        }
    }
    const size_t lit = end - anchor;
    if (1 + lit + extlen(lit) > cap - o) return 0;
    dst[o++] = (uint8_t)((lit >= 15 ? 15 : lit) << 4);
    if (lit >= 15) o = put_len(dst, o, lit - 15);
    for (size_t i = 0; i < lit; i++) dst[o++] = base[anchor + i];
    return (unsigned long)o;
}

unsigned long lz4_encode_ref(const void *src, unsigned long n, void *dst, unsigned long cap,
                             uint16_t *tab, unsigned long entries) {
    return lz4_encode_linked_ref(src, n, dst, cap, tab, entries, src);
}
