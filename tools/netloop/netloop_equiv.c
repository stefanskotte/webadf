/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
/* The asm codec against the C reference (netloop_equiv.h). Implemented from the protocol's
 * description; none of RobSmithDev's code is in this program. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "pnet_mfm.h"
#include "pnet_frame.h"
#include "pnet_asm.h"
#include "netloop_equiv.h"

#define G 16u                     /* guard bytes either side of every output */

static uint32_t rs;
static uint32_t rnd(void) { rs ^= rs << 13; rs ^= rs >> 17; rs ^= rs << 5; return rs; }
static uint32_t rn(uint32_t m) { return m ? rnd() % m : 0; }

static uint8_t *bin, *bc, *ba, *bx;
static size_t cap_in, cap_out, maxn;
static unsigned long scale_, fails, cur_fails, cur_cases;
static unsigned step;              /* 1 in the full run; coarser exhaustive sweeps on an A500 */
static const char *cur;

static unsigned long count(unsigned long base) {
    const unsigned long c = base * scale_ / 64u;
    return c ? c : 1u;
}

static void begin(const char *name) { cur = name; cur_fails = 0; cur_cases = 0; }
static void end(void) {
    printf("  %-12s %7lu cases  %s\n", cur, cur_cases, cur_fails ? "FAIL" : "ok");
}
static void fail(const char *what, unsigned long a, unsigned long b, unsigned long c, long rc, long ra) {
    fails++;
    if (++cur_fails <= 3)
        printf("  FAIL %s %s: %lu %lu %lu (C %ld, asm %ld)\n", cur, what, a, b, c, rc, ra);
}

/* Same random bytes in both output buffers, so a stray write shows as a difference. */
static void prefill(size_t n) {
    if (n > cap_out) n = cap_out;
    for (size_t i = 0; i < n; i++) bc[i] = (uint8_t)rnd();
    memcpy(ba, bc, n);
}

static const uint16_t run_lens[] = {
    1, 1, 1, 1, 2, 2, 2, 3, 3, 4, 5, 6, 126, 127, 128, 129, 130, 253, 254, 255, 256, 257, 381, 0
};
static const uint8_t sync_bytes[] = { 0x44, 0x89, 0x12, 0x24, 0x48, 0x91, 0x22, 0xAA, 0x00, 0x88 };

/* kind 0 random, 1 runs over a 1..3 letter alphabet, 2 sync-like bytes, 3 one byte, 4 mixed. */
static void gen(uint8_t *p, size_t n, unsigned kind) {
    const uint8_t alpha[3] = { (uint8_t)rnd(), (uint8_t)rnd(), (uint8_t)rnd() };
    const unsigned na = 1u + rn(3);
    size_t i = 0;
    switch (kind) {
    case 0: for (; i < n; i++) p[i] = (uint8_t)rnd(); break;
    case 2: for (; i < n; i++) p[i] = sync_bytes[rn(sizeof sync_bytes)]; break;
    case 3: memset(p, (int)(rnd() & 0xFF), n); break;
    default:
        while (i < n) {
            size_t len = run_lens[rn(sizeof run_lens / sizeof run_lens[0])];
            if (len == 0) len = 1u + rn(300);
            if (len > n - i) len = n - i;
            const uint8_t v = (kind == 4 && rn(3) == 0) ? (uint8_t)rnd() : alpha[rn(na)];
            if (kind == 4 && rn(4) == 0) for (size_t k = 0; k < len; k++) p[i + k] = (uint8_t)rnd();
            else memset(p + i, v, len);
            i += len;
        }
    }
}

/* A length: mostly small, sometimes an edge, never over `lim`. */
static size_t pick_len(size_t lim) {
    static const uint16_t edge[] = { 0, 1, 2, 3, 4, 5, 7, 8, 15, 16, 17, 31, 32, 33, 126, 127, 128,
                                     129, 254, 255, 256, 257, 1500, 1518 };
    size_t n = rn(4) == 0 ? edge[rn(sizeof edge / sizeof edge[0])] : rn(400);
    return n > lim ? lim : n;
}

/* --- MFM encode --- */
static void mfm_enc_case(size_t n, unsigned kind, unsigned so, unsigned dof, uint16_t last, const uint8_t *fixed) {
    uint8_t *src = bin + G + so;
    if (fixed) memcpy(src, fixed, n); else gen(src, n, kind);
    const size_t region = 2 * n + 2 * G + 2;
    prefill(region);
    uint16_t lc = last, la = last;
    const size_t rc = pnet_mfm_encode_c(src, n, bc + G + dof, &lc);
    const size_t ra = pnet_mfm_encode_asm(src, n, ba + G + dof, &la);
    cur_cases++;
    if (rc != ra || lc != la || memcmp(bc, ba, region))
        fail("n/so/dof", n, so, dof, (long)lc, (long)la);
}

static void t_mfm_encode(void) {
    begin("mfm_encode");
    static const uint16_t lasts[] = { 0x0000, 0x0001, 0xFFFE, 0xFFFF, 0x5555, 0xAAAA };
    for (unsigned b = 0; b < 256; b += step)
        for (unsigned l = 0; l < sizeof lasts / sizeof lasts[0]; l++) {
            const uint8_t one = (uint8_t)b;
            mfm_enc_case(1, 0, b & 1u, l & 1u, lasts[l], &one);
        }
    for (unsigned long c = 0; c < count(4000); c++)
        mfm_enc_case(pick_len(maxn), rn(5), rn(2), rn(2), (uint16_t)rnd(), NULL);
    if (maxn >= 70000u)
        for (unsigned o = 0; o < 2; o++) mfm_enc_case(maxn, 0, o, o, (uint16_t)rnd(), NULL);
    end();
}

/* --- MFM decode --- */
static void mfm_dec_case(size_t n, unsigned so, unsigned dof, bool fill) {
    uint8_t *src = bin + G + so;
    if (fill) gen(src, 2 * n, rn(5));
    const size_t region = n + 2 * G + 2;
    prefill(region);
    pnet_mfm_decode_c(src, n, bc + G + dof);
    pnet_mfm_decode_asm(src, n, ba + G + dof);
    cur_cases++;
    if (memcmp(bc, ba, region)) fail("n/so/dof", n, so, dof, 0, 0);
}

static void t_mfm_decode(void) {
    begin("mfm_decode");
    if (maxn >= 65536u) {                        /* every 16-bit word once */
        for (unsigned w = 0; w < 65536u; w++) {
            bin[G + 2 * w] = (uint8_t)(w >> 8);
            bin[G + 2 * w + 1] = (uint8_t)w;
        }
        mfm_dec_case(65536u, 0, 0, false);
        memmove(bin + G + 1, bin + G, 131072u);
        mfm_dec_case(65536u, 1, 1, false);
    } else {
        for (unsigned w = 0; w < 65536u; w += 64u) {   /* every high byte, every low byte */
            for (unsigned k = 0; k < 64u && 2 * k + 1 < cap_in - 2 * G; k++) {
                bin[G + 2 * k] = (uint8_t)((w + k * 1031u) >> 8);
                bin[G + 2 * k + 1] = (uint8_t)(w + k);
            }
            mfm_dec_case(64u, 0, w & 1u, false);
        }
    }
    for (unsigned long c = 0; c < count(4000); c++) mfm_dec_case(pick_len(maxn), rn(2), rn(2), true);
    end();
}

/* --- checksum --- */
static void t_checksum(void) {
    begin("checksum");
    for (unsigned long c = 0; c < count(6000) + 200u; c++) {
        const size_t n = c < 200u ? (size_t)(c >> 1) : pick_len(maxn);
        const unsigned so = c < 200u ? (unsigned)(c & 1u) : rn(2);
        uint8_t *p = bin + G + so;
        gen(p, n, rn(5));
        const uint16_t rc = pnet_checksum_c(p, n), ra = pnet_checksum_asm(p, n);
        cur_cases++;
        if (rc != ra) fail("n/so", n, so, 0, rc, ra);
    }
    if (maxn >= 70000u)
        for (unsigned o = 0; o < 2; o++) {
            uint8_t *p = bin + G + o;
            gen(p, maxn - o, 0);
            const uint16_t rc = pnet_checksum_c(p, maxn - o), ra = pnet_checksum_asm(p, maxn - o);
            cur_cases++;
            if (rc != ra) fail("large", maxn - o, o, 0, rc, ra);
        }
    end();
}

/* --- RLE encode --- */
static void rle_enc_case(size_t n, unsigned kind, unsigned so, unsigned dof) {
    uint8_t *src = bin + G + so;
    gen(src, n, kind);
    src[n] = n ? src[n - 1] : 0;                  /* tempt a read past n into a longer run */
    src[n + 1] = src[n];
    const size_t region = pnet_rle_bound(n) + 2 * G + 2;
    prefill(region);
    const size_t rc = pnet_rle_encode_c(src, n, bc + G + dof);
    const size_t ra = pnet_rle_encode_asm(src, n, ba + G + dof);
    cur_cases++;
    if (rc != ra || memcmp(bc, ba, region)) fail("n/kind/so", n, kind, so, (long)rc, (long)ra);
}

static void t_rle_encode(void) {
    begin("rle_encode");
    for (size_t n = 0; n <= 300u && n <= maxn; n += step)
        for (unsigned kind = 0; kind < 5; kind++) rle_enc_case(n, kind, (unsigned)(n & 1u), kind & 1u);
    for (unsigned long c = 0; c < count(6000); c++) rle_enc_case(pick_len(maxn), rn(5), rn(2), rn(2));
    if (maxn >= 70000u)
        for (unsigned kind = 0; kind < 5; kind++) rle_enc_case(maxn, kind, kind & 1u, 0);
    end();
}

/* --- RLE decode --- */
static void rle_dec_case(const uint8_t *s, size_t n, size_t cap, unsigned so, unsigned dof) {
    uint8_t *src = bin + G + so;
    memmove(src, s, n);
    src[n] = 0x05;                                /* past n: a control byte that would decode */
    src[n + 1] = 0x81;
    size_t most = 127u * n;
    if (most > cap) most = cap;
    const size_t region = most + 2 * G + 2;
    if (region > cap_out) { fail("region", n, cap, 0, 0, 0); return; }
    prefill(region);
    const long rc = pnet_rle_decode_c(src, n, bc + G + dof, cap);
    const long ra = pnet_rle_decode_asm(src, n, ba + G + dof, cap);
    cur_cases++;
    if (rc != ra || memcmp(bc, ba, region)) fail("n/cap/so", n, cap, so, rc, ra);
}

static void t_rle_decode(void) {
    begin("rle_decode");
    const size_t lim = maxn < 4000u ? maxn : 4000u;
    for (unsigned long c = 0; c < count(3000); c++) {
        const size_t n = pick_len(lim);
        gen(bin + G, n, rn(5));
        const size_t e = pnet_rle_encode_c(bin + G, n, bx);
        const unsigned so = rn(2), dof = rn(2);
        switch (rn(6)) {
        case 0: rle_dec_case(bx, e, n, so, dof); break;                          /* exact cap */
        case 1: rle_dec_case(bx, e, n ? n - 1u : 0, so, dof); break;            /* one short */
        case 2: rle_dec_case(bx, e, rn((uint32_t)n + 2u), so, dof); break;       /* short cap */
        case 3: rle_dec_case(bx, rn((uint32_t)e + 1u), n + 8u, so, dof); break;  /* truncated */
        case 4: if (e) bx[rn((uint32_t)e)] = (uint8_t)rnd();                     /* corrupted */
                rle_dec_case(bx, e, n + rn(300), so, dof); break;
        default: { const size_t g = rn(cap_out / 128u < 200u ? (uint32_t)(cap_out / 128u) : 200u);                                     /* garbage */
                for (size_t i = 0; i < g; i++) bx[i] = (uint8_t)rnd();
                rle_dec_case(bx, g, rn(4) ? rn(2000) : (size_t)-1, so, dof); }
        }
    }
    for (size_t t = 0; t <= 300u; t += step) {          /* every truncation of one mixed stream */
        static size_t e;
        if (t == 0) { gen(bin + G, 600 < maxn ? 600 : maxn, 4); e = pnet_rle_encode_c(bin + G, 600 < maxn ? 600 : maxn, bx); }
        if (t > e) break;
        rle_dec_case(bx, t, 700, (unsigned)(t & 1u), 0);
    }
    if (maxn >= 70000u)
        for (unsigned kind = 0; kind < 5; kind += 2) {
            gen(bin + G, maxn, kind);
            const size_t e = pnet_rle_encode_c(bin + G, maxn, bx);
            rle_dec_case(bx, e, maxn, kind & 1u, 0);
        }
    end();
}

/* --- find_sync --- */
static void put_sync(uint8_t *b, size_t len, size_t p) {
    for (unsigned k = 0; k < 32u; k++) {
        const size_t bit = p + k;
        if ((bit >> 3) >= len) return;
        const uint8_t m = (uint8_t)(0x80u >> (bit & 7u));
        if ((PNET_SYNC_WORDS >> (31u - k)) & 1u) b[bit >> 3] |= m; else b[bit >> 3] &= (uint8_t)~m;
    }
}

static void sync_case(size_t len, size_t scan, unsigned so) {
    const uint8_t *b = bin + G + so;
    const long rc = pnet_find_sync_c(b, len, scan), ra = pnet_find_sync_asm(b, len, scan);
    cur_cases++;
    if (rc != ra) fail("len/scan/so", len, scan, so, rc, ra);
}

static void t_find_sync(void) {
    begin("find_sync");
    for (size_t p = 0; p < 80u; p += step)              /* every bit offset near the start and the limit */
        for (unsigned so = 0; so < 2; so++) {
            uint8_t *b = bin + G + so;
            memset(b, 0xAA, 24);
            put_sync(b, 24, p);
            for (size_t len = 0; len <= 20u; len += step)
                for (size_t scan = 0; scan <= 18u; scan += 3u) sync_case(len, scan, so);
        }
    for (unsigned long c = 0; c < count(5000); c++) {
        const size_t len = pick_len(maxn < 1200u ? maxn : 1200u);
        const unsigned so = rn(2);
        uint8_t *b = bin + G + so;
        gen(b, len + 8u, rn(4) == 0 ? 0 : 2);
        if (rn(3) == 0) memset(b, 0xAA, len);
        for (unsigned k = rn(4); k--; ) put_sync(b, len + 8u, rn((uint32_t)len * 8u + 40u));
        if (rn(2)) { const size_t p = rn((uint32_t)len * 8u + 1u);   /* periodic 4489 4489 4489 */
                     put_sync(b, len + 8u, p); put_sync(b, len + 8u, p + 16u); }
        size_t scan;
        switch (rn(5)) {
        case 0: scan = 512; break;
        case 1: scan = len > 4u ? len - 4u : 0; break;
        case 2: scan = (size_t)0 - rn(8); break;  /* scan + 4 wraps, as in the C */
        default: scan = rn((uint32_t)len + 16u);
        }
        sync_case(len, scan, so);
    }
    end();
}

/* --- shift_left --- */
static void shift_case(size_t len, size_t bits, unsigned off) {
    const size_t region = len + 2 * G + 2;
    if (region > cap_out) return;
    prefill(region);
    gen(bc + G + off, len, rn(5));
    memcpy(ba, bc, region);
    const size_t rc = pnet_shift_left_c(bc + G + off, len, bits);
    const size_t ra = pnet_shift_left_asm(ba + G + off, len, bits);
    cur_cases++;
    if (rc != ra || memcmp(bc, ba, region)) fail("len/bits/off", len, bits, off, (long)rc, (long)ra);
}

static void t_shift_left(void) {
    begin("shift_left");
    for (size_t len = 0; len <= 24u; len += step)       /* every shift that fits, both parities */
        for (size_t bits = 0; bits <= len * 8u + 17u; bits++)
            for (unsigned off = 0; off < 2; off++) shift_case(len, bits, off);
    for (unsigned long c = 0; c < count(4000); c++) {
        const size_t len = pick_len(maxn);
        const size_t bits = rn(4) == 0 ? rn(16) : rn((uint32_t)len * 8u + 24u);
        shift_case(len, bits, rn(2));
    }
    if (maxn >= 70000u)
        for (unsigned s = 0; s < 16u; s++) shift_case(maxn - 64u, s * 9u + 3u, s & 1u);
    end();
}

/* --- payload compare --- */
static void t_memeq(void) {
    begin("memeq");
    for (unsigned long c = 0; c < count(4000); c++) {
        const size_t n = pick_len(maxn);
        const unsigned oa = rn(4), ob = rn(4);
        uint8_t *a = bc + G + oa, *b = ba + G + ob;
        gen(a, n, rn(5));
        memcpy(b, a, n);
        if (n && rn(2)) {
            const size_t at = rn(3) == 0 ? n - 1u : rn((uint32_t)n);
            b[at] ^= (uint8_t)(1u << rn(8));
        }
        const int rc = memcmp(a, b, n) == 0, ra = nl_memeq_asm(a, b, n);
        cur_cases++;
        if (rc != ra) fail("n/oa/ob", n, oa, ob, rc, ra);
    }
    end();
}

/* --- whole frames: the selected codec (asm by default) against the all-C pipeline --- */
static void t_pipeline(void) {
    begin("pipeline");
    for (unsigned long c = 0; c < count(300); c++) {
        pnet_frame_ref_t f[PNET_MAX_FRAMES];
        uint16_t lens[PNET_MAX_FRAMES];
        const unsigned nf = rn(4) == 0 ? 0 : 1u + rn(PNET_MAX_FRAMES);
        size_t total = 0;
        for (unsigned i = 0; i < nf; i++) {
            size_t l = 1u + rn(PNET_ETH_MTU);
            if (total + l > maxn / 2u) l = 1;
            gen(bin + G + total, l, rn(5));
            f[i].data = bin + G + total; f[i].len = (uint16_t)l; lens[i] = (uint16_t)l;
            total += l;
        }
        const size_t cap = (cap_out - 4u * G) / 2u;
        const uint8_t ac = (uint8_t)rnd(), pc = (uint8_t)rnd(), fl = (uint8_t)rnd();
        prefill(cap_out);
        size_t rc = pnet_build_to_board_allc(bc + G, cap, ac, pc, f, nf);
        size_t ra = pnet_build_to_board(ba + G, cap, ac, pc, f, nf);
        cur_cases++;
        if (rc != ra || memcmp(bc, ba, rc + 2 * G)) { fail("to_board nf/total", nf, total, 0, (long)rc, (long)ra); continue; }
        rc = pnet_build_to_amiga_allc(bc + G, cap, ac, pc, fl, f, nf);
        ra = pnet_build_to_amiga(ba + G, cap, ac, pc, fl, f, nf);
        if (rc != ra || memcmp(bc, ba, rc + 2 * G)) { fail("to_amiga nf/total", nf, total, 0, (long)rc, (long)ra); continue; }
        if (!rc) continue;
        /* Parse the aligned track both ways (data_size after lead-in + sync). */
        const uint8_t *t = bc + G + PNET_LEAD_BYTES + 4u;
        pnet_hdr_t hc, ha;
        const pnet_err_t ec = pnet_parse_hdr_to_amiga_allc(t, rc - PNET_LEAD_BYTES - 4u, &hc, true);
        const pnet_err_t ea = pnet_parse_hdr_to_amiga(t, rc - PNET_LEAD_BYTES - 4u, &ha, true);
        if (ec != ea || ec != PNET_OK || memcmp(&hc, &ha, sizeof hc)) { fail("hdr", nf, total, 0, ec, ea); continue; }
        uint16_t lc[PNET_MAX_FRAMES], la[PNET_MAX_FRAMES];
        unsigned nc = 0, na = 0;
        uint8_t *oc = bx, *oa = bx + total + 16u;
        const pnet_err_t pc2 = pnet_parse_frames_allc(t + PNET_HDR_MFM_BYTES, hc.data_size, PNET_TO_AMIGA,
                                                      oc, total + 8u, lc, PNET_MAX_FRAMES, &nc);
        const pnet_err_t pa2 = pnet_parse_frames(t + PNET_HDR_MFM_BYTES, ha.data_size, PNET_TO_AMIGA,
                                                 oa, total + 8u, la, PNET_MAX_FRAMES, &na);
        if (pc2 != pa2 || nc != na || nc != nf || memcmp(lc, la, nc * sizeof lc[0]) ||
            memcmp(oc, oa, total) || memcmp(oc, bin + G, total))
            fail("frames", nf, total, 0, pc2, pa2);
        (void)lens;
    }
    end();
}

unsigned long nl_equiv_run(unsigned long max_n, unsigned long scale, unsigned long seed) {
    maxn = max_n;
    scale_ = scale;
    step = scale >= 64u ? 1u : 13u;
    rs = seed ? (uint32_t)seed : 0x9E3779B9u;
    fails = 0;
    cap_in = 2 * max_n + 8 * G + 64;
    cap_out = 2 * max_n + max_n / 64u + 8 * G + 256;
    bin = malloc(cap_in); bc = malloc(cap_out); ba = malloc(cap_out); bx = malloc(cap_out);
    if (!bin || !bc || !ba || !bx) {
        printf("  equivalence: out of memory\n");
        fails = 1;
    } else {
        t_mfm_encode();
        t_mfm_decode();
        t_checksum();
        t_rle_encode();
        t_rle_decode();
        t_find_sync();
        t_shift_left();
        t_memeq();
        t_pipeline();
    }
    free(bin); free(bc); free(ba); free(bx);
    return fails;
}

/* --- reads past the input (vamos only: the input ends at the top of RAM) --- */
unsigned long nl_overread_run(uint8_t *top, size_t room, unsigned long seed) {
    unsigned long k = 0;
    rs = seed ? (uint32_t)seed : 0x2545F491u;
    maxn = 4000u;
    cap_out = 2 * maxn + 8 * G + 256;
    if (room < 2 * cap_out + 4u * maxn) return 0;
    uint8_t *o = top - room, *e = o + cap_out;     /* scratch at the bottom of the block */
    for (unsigned long c = 0; c < 3000u; c++) {
        const size_t n = pick_len(1600u);
        uint8_t *p = top - n, *p2 = top - 2 * n;
        uint16_t last = (uint16_t)rnd();
        gen(top - 2 * n, 2 * n, rn(5));
        pnet_mfm_encode_c(p, n, o, &last);  pnet_mfm_encode_asm(p, n, o, &last);
        pnet_mfm_decode_c(p2, n, o);        pnet_mfm_decode_asm(p2, n, o);
        (void)pnet_checksum_c(p, n);        (void)pnet_checksum_asm(p, n);
        if (n) { (void)pnet_checksum_c(p + 1, n - 1); (void)pnet_checksum_asm(p + 1, n - 1); }
        gen(p, n, rn(5));
        pnet_rle_encode_c(p, n, o);         pnet_rle_encode_asm(p, n, o);
        const size_t el = pnet_rle_encode_c(p, n, e);
        const size_t t = rn(4) ? el : rn((uint32_t)el + 1u);       /* whole, or truncated */
        memcpy(top - t, e, t);
        (void)pnet_rle_decode_c(top - t, t, o, n + 8u);   (void)pnet_rle_decode_asm(top - t, t, o, n + 8u);
        gen(p, n, rn(4) ? 2 : 0);
        if (n >= 4 && rn(2)) put_sync(p, n, rn((uint32_t)n * 8u));
        const size_t scan = rn(3) ? n + rn(8) : rn((uint32_t)n + 1u);
        (void)pnet_find_sync_c(p, n, scan); (void)pnet_find_sync_asm(p, n, scan);
        const size_t bits = rn(3) ? rn(16) : rn((uint32_t)n * 8u + 9u);
        pnet_shift_left_c(p, n, bits);      pnet_shift_left_asm(p, n, bits);
        if (n) { pnet_shift_left_asm(p + 1, n - 1, bits); }
        memcpy(o, p, n);
        (void)nl_memeq_asm(o, p, n);        (void)nl_memeq_asm(p, o, n);
        if (n) { (void)nl_memeq_asm(o + 1, p + 1, n - 1); }
        k++;
    }
    return k;
}

/* --- alignment (asm only; build.sh reads vamos' memory trace) --- */
unsigned long nl_oddcheck_run(void) {
    static const uint8_t lens[] = { 0, 1, 2, 3, 4, 5, 8, 9, 17, 33, 40, 65 };
    static uint8_t a[600] __attribute__((aligned(4))), b[600] __attribute__((aligned(4)));
    static uint8_t enc[700] __attribute__((aligned(4)));
    unsigned long k = 0;
    rs = 0x0DDBA11u;
    for (unsigned li = 0; li < sizeof lens; li++) {
        const size_t n = lens[li];
        for (unsigned x = 0; x < 4; x++)
            for (unsigned y = 0; y < 4; y++) {
                uint8_t *p = a + 8 + x, *q = b + 8 + y;
                uint16_t last = 0;
                gen(p, 2 * n + 2, x & 1u ? 0 : 4);
                pnet_mfm_encode_asm(p, n, q, &last);
                pnet_mfm_decode_asm(p, n, q);
                (void)pnet_checksum_asm(p, n);
                pnet_rle_encode_asm(p, n, q);
                (void)nl_memeq_asm(p, q, n);
                memcpy(q, p, n);
                (void)nl_memeq_asm(p, q, n);
                if (n >= 4) put_sync(p, n, (size_t)(x * 3u + y));
                (void)pnet_find_sync_asm(p, n, n);
                for (size_t bits = 0; bits < 18u; bits++) { memcpy(q, p, n); pnet_shift_left_asm(q, n, bits); }
                k++;
            }
    }
    for (unsigned c = 0; c < 64u; c++) {           /* literal blocks of 8+ at every parity pair */
        const size_t n = 9u + rn(250);
        gen(a, n, c & 1u ? 0 : 4);
        const size_t e = pnet_rle_encode_c(a, n, enc + 8);
        memmove(enc + 8 + (c & 1u), enc + 8, e);
        (void)pnet_rle_decode_asm(enc + 8 + (c & 1u), e, b + 8 + ((c >> 1) & 3u), n);
        k++;
    }
    return k;
}
