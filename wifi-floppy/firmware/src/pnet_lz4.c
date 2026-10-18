/* PaulaNET LZ4 (pnet_lz4.h). Ours, MIT: written from the LZ4 block format description; the encoder is
 * m68k/lz4/lz4_68k.c's algorithm, kept bit-exact with it (test/test_pnet_lz4.c):
 *   - positions count from `window`; the 4 bytes b0 b1 b2 b3 at one are X = b0:b2, Y = b1:b3 and the hash is bits 1..
 *     of 2X + Y, masked to the table;
 *   - the table holds positions XOR 0x8000 and is never trusted: an entry at or past the current position is ignored,
 *     any other is a candidate whose 4 bytes are compared;
 *   - skip strength 6 (the step grows every 64 misses); a match extends forwards to 5 bytes before the end and back
 *     into the pending literals; the LZ4 end rules (a match starts 12+ bytes before the end, the last 5 are literals).
 */
#include "pnet_lz4.h"
#include "pnet_mfm.h"
#include <string.h>

static size_t extlen(size_t x) { return x < 15u ? 0u : (x - 15u) / 255u + 1u; }

static size_t put_len(uint8_t *d, size_t o, size_t len) {    /* the 255-run after a nibble of 15 */
    while (len >= 255u) { d[o++] = 255u; len -= 255u; }
    d[o++] = (uint8_t)len;
    return o;
}

size_t pnet_lz4_encode_linked(const uint8_t *src, size_t n, uint8_t *dst, size_t cap, uint16_t *tab,
                              unsigned entries, const uint8_t *base) {
    if (n > 65535u || base > src || (size_t)(src - base) + n > 65536u) return 0;
    const size_t p0 = (size_t)(src - base), end = p0 + n;
    const unsigned mask = (entries - 1u) << 1;
    size_t pos = p0, anchor = p0, o = 0;
    unsigned long misses = 0;
    if (n >= 13u) {
        const size_t mflimit = end - 12u, mend = end - 5u;
        while (pos <= mflimit) {
            const uint8_t *p = base + pos;
            const unsigned X = (unsigned)p[0] << 8 | p[2], Y = (unsigned)p[1] << 8 | p[3];
            const unsigned h = ((2u * X + Y) & mask) >> 1;
            size_t ref = (size_t)(tab[h] ^ 0x8000u);
            tab[h] = (uint16_t)(pos ^ 0x8000u);
            if (ref >= pos || base[ref] != p[0] || base[ref + 1] != p[1] || base[ref + 2] != p[2] ||
                base[ref + 3] != p[3]) {
                pos += 1u + (misses++ >> 6);
                continue;
            }
            size_t len = 4;
            while (pos + len < mend && base[ref + len] == base[pos + len]) len++;
            while (pos > anchor && ref > 0 && base[pos - 1] == base[ref - 1]) { pos--; ref--; len++; }
            const size_t lit = pos - anchor, ml = len - 4u;
            if (3u + lit + extlen(lit) + extlen(ml) > cap - o) return 0;
            const size_t tok = o++;
            dst[tok] = (uint8_t)((lit >= 15u ? 15u : lit) << 4 | (ml >= 15u ? 15u : ml));
            if (lit >= 15u) o = put_len(dst, o, lit - 15u);
            for (size_t i = 0; i < lit; i++) dst[o++] = base[anchor + i];
            const size_t off = pos - ref;
            dst[o++] = (uint8_t)off;                       /* little-endian, as the format says */
            dst[o++] = (uint8_t)(off >> 8);
            if (ml >= 15u) o = put_len(dst, o, ml - 15u);
            pos += len;
            anchor = pos;
            misses = 0;
        }
    }
    const size_t lit = end - anchor;
    if (1u + lit + extlen(lit) > cap - o) return 0;
    dst[o++] = (uint8_t)((lit >= 15u ? 15u : lit) << 4);
    if (lit >= 15u) o = put_len(dst, o, lit - 15u);
    for (size_t i = 0; i < lit; i++) dst[o++] = base[anchor + i];
    return o;
}

long pnet_lz4_decode(const uint8_t *src, size_t n, uint8_t *dst, uint8_t *dst_end, const uint8_t *window) {
    if (n == 0 || dst_end < dst || window > dst) return -1;
    const uint8_t *ip = src;
    const uint8_t *const iend = src + n;
    uint8_t *op = dst;
    for (;;) {
        const unsigned token = *ip++;
        size_t lit = token >> 4;
        if (lit == 15u) {
            unsigned b;
            do {
                if (ip == iend) return -1;
                b = *ip++;
                lit += b;
            } while (b == 255u);
        }
        if (lit > (size_t)(iend - ip) || lit > (size_t)(dst_end - op)) return -1;
        memcpy(op, ip, lit);
        op += lit;
        ip += lit;
        if (ip == iend) return (long)(op - dst);           /* the last sequence: literals only */
        if (iend - ip < 2) return -1;
        const size_t off = (size_t)ip[0] | (size_t)ip[1] << 8;
        ip += 2;
        if (off == 0 || off > (size_t)(op - window)) return -1;
        size_t ml = (token & 15u) + 4u;
        if ((token & 15u) == 15u) {
            unsigned b;
            do {
                if (ip == iend) return -1;
                b = *ip++;
                ml += b;
            } while (b == 255u);
        }
        if (ml > (size_t)(dst_end - op)) return -1;
        const uint8_t *m = op - off;
        while (ml--) *op++ = *m++;                         /* may overlap its own output: byte by byte */
        if (ip == iend) return -1;                         /* a block never ends on a match */
    }
}

pnet_err_t pnet_lz4_iter_next(pnet_frame_iter_t *it, pnet_lz4_win_t *w, uint8_t *out, size_t cap, uint16_t *len,
                              bool *was_lz4) {
    *was_lz4 = false;
    if (it->i >= it->count || 8u > it->len - it->pos) return PNET_E_FRAMES;
    uint8_t ch[4];
    pnet_mfm_decode(it->p + it->pos, 4, ch);
    const uint16_t field = (uint16_t)(ch[0] << 8 | ch[1]), os = (uint16_t)(ch[2] << 8 | ch[3]);
    const bool fits = w->pos <= PNET_LZ4_WINDOW && os <= PNET_LZ4_WINDOW - w->pos;
    if (!(field & PNET_SIZE_LZ4)) {                     /* RLE or MFM: the plain iterator, into the window */
        if (!fits || os > cap) {
            w->pos = PNET_LZ4_BROKEN;                   /* outside the window: nothing later may link to it */
            return pnet_frame_iter_next(it, out, cap, len);
        }
        uint8_t *at = w->win + w->pos;
        const pnet_err_t e = pnet_frame_iter_next(it, at, PNET_LZ4_WINDOW - w->pos, len);
        if (e != PNET_OK) return e;
        memcpy(out, at, *len);
        w->pos += *len;
        return PNET_OK;
    }
    *was_lz4 = true;                                    /* from here an error is LZ4 damage (pnet_lz4.h) */
    const bool wrapped = (field & 0x8000u) != 0;
    if (it->dir == PNET_TO_AMIGA && !wrapped) return PNET_E_LZ4;   /* never raw toward the Amiga (HANDOFF 3bu) */
    const size_t at = it->pos + 8u, blk = field & 0x3FFFu, wire = wrapped ? 2u * blk : blk;
    if (wire > it->len - at) return PNET_E_FRAMES;
    if (os == 0 || os > PNET_ETH_MTU) return PNET_E_FRAME_SIZE;
    if (os > cap) return PNET_E_FULL;
    if (blk == 0 || blk > PNET_LZ4_BLOCK_MAX || !fits) return PNET_E_LZ4;
    const uint8_t *src = it->p + at;
    if (wrapped) {
        pnet_mfm_decode(src, blk, w->scratch);
        src = w->scratch;
    }
    uint8_t *dst = w->win + w->pos;
    if (pnet_lz4_decode(src, blk, dst, dst + os, w->win) != (long)os) return PNET_E_LZ4;
    memcpy(out, dst, os);
    w->pos += os;
    *len = os;
    const size_t next = at + wire + (wire & 1u);
    it->pos = next > it->len ? it->len : next;
    it->i++;
    return PNET_OK;
}
