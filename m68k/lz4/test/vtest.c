/*
 * vtest: the 68000 test of lz4_68k.asm, run under vamos (an emulated 68000) by ../test.sh.
 * Copyright (c) 2026 Stefan Skotte and contributors. MIT licence (../LICENSE).
 *
 *   vtest DEC  FILE        decode every block of a host_test vector file (liblz4's blocks) at
 *                          every src/dst parity; exact output, guard bytes around the output,
 *                          a dst_end one byte short must give -1 and write nothing past it
 *   vtest LOWWIN FILE      the same with the window start below $10000 (the checked loop)
 *   vtest FUZZ SEED N      N random frames (1..1518 bytes) through liblz4 and our decoder at
 *                          every parity, then truncated, corrupted and random blocks: the
 *                          result and output must equal ref_decode's, guards intact
 *   vtest ENC  FILE ENTRIES  encode every frame of a vector file (linked groups linked) with
 *                          the asm and the C model at every parity: the same bytes, decodable
 *                          by liblz4; cap checks on every 4th frame
 *   vtest ENCR LO HI       random frames of every length LO..HI, the same checks
 *   vtest TAIL             src at the very end of a buffer; prints the guard ranges for
 *                          test.sh's memory-trace check (no read past src + len)
 *   vtest ODD              a small mixed run for test.sh's odd-address trace check
 * Prints RESULT: PASS or RESULT: FAIL.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "lz4.h"
#include "../lz4_68k.h"
#include "t_common.h"

static int fails;
static unsigned long nchk;
#define CHECK(c, ...) do { nchk++; if (!(c)) { if (fails++ < 20) { printf("FAIL %d: ", __LINE__); \
    printf(__VA_ARGS__); printf("\n"); } } } while (0)

#define G 64                                 /* guard bytes */
static uint8_t vec[3400000] __attribute__((aligned(4)));
static uint8_t sbuf[70000] __attribute__((aligned(4)));
static uint8_t obuf[2 * G + 70000] __attribute__((aligned(4)));
static uint8_t blk[70000] __attribute__((aligned(4))), blk2[70000] __attribute__((aligned(4)));
static uint8_t rdec[70000] __attribute__((aligned(4)));
static uint16_t tab_a[16384], tab_c[16384];

static size_t loadvec(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) { printf("cannot open %s\n", path); exit(20); }
    size_t n = fread(vec, 1, sizeof vec, f);
    fclose(f);
    if (n < 8 || memcmp(vec, "L4V1", 4)) { printf("not a vector file\n"); exit(20); }
    return n;
}

static void guard(uint8_t *p, size_t n) { memset(p, 0xE7, n); }
static int guard_ok(const uint8_t *p, size_t n) {
    for (size_t i = 0; i < n; i++) if (p[i] != 0xE7) return 0;
    return 1;
}

/* Our decoder on block b (k bytes, at src parity sa) into obuf at dst parity da + pre, with the
 * window at obuf + G + da (linked) or at the dst; dst_end = dst + cap. Guards around
 * [dst, dst_end) and the result checked against ref_decode on the same inputs. Returns the
 * decoder's result. The window's earlier bytes (pre of them) must already be in place. */
static const uint8_t *lowwin;
static long dec_check(const uint8_t *b, size_t k, unsigned sa, unsigned da, size_t pre, size_t cap,
                      int linked, const uint8_t *expect, long want) {
    uint8_t *s = sbuf + sa;
    memmove(s, b, k);
    uint8_t *win = obuf + G + da, *dst = win + pre, *end = dst + cap;
    guard(obuf, (size_t)(dst - obuf));
    if (pre) memcpy(win, rdec, pre);           /* the earlier frames */
    guard(dst, cap + G);
    const uint8_t *w = lowwin ? lowwin : linked ? win : dst;
    long r = lz4_decode(s, k, dst, end, w);
    CHECK(guard_ok(obuf, (size_t)(win - obuf)) && guard_ok(end, G), "guard broken (k=%lu sa=%u da=%u r=%ld)",
          (unsigned long)k, sa, da, r);
    if (expect) {
        CHECK(r == want && !memcmp(dst, expect, (size_t)want), "decode k=%lu sa=%u da=%u: %ld, want %ld",
              (unsigned long)k, sa, da, r, want);
    } else {
        static uint8_t o2[70000];
        memcpy(o2, dst, cap);
        guard(dst, cap);
        long q = ref_decode(s, k, dst, end, w, NULL);
        CHECK(r == q && (r < 0 || !memcmp(o2, dst, (size_t)r)), "malformed k=%lu sa=%u da=%u: %ld, ref %ld",
              (unsigned long)k, sa, da, r, q);
    }
    return r;
}

/* DEC / LOWWIN: every frame of every group, every parity. */
static void t_dec(const char *path) {
    size_t n = loadvec(path), p = 8;
    unsigned ng = get32(vec + 4), frames = 0;
    unsigned long bytes = 0;
    for (unsigned g = 0; g < ng && p < n; g++) {
        int linked = vec[p];
        unsigned nfr = (unsigned)vec[p + 2] << 8 | vec[p + 3], tr = get32(vec + p + 4), tb = get32(vec + p + 8);
        const uint8_t *lens = vec + p + 12, *raw = lens + 8 * nfr, *bl = raw + tr;
        p += 12 + 8 * nfr + tr + tb;
        for (unsigned a = 0; a < 4; a++) {
            unsigned ro = 0, bo = 0;
            for (unsigned j = 0; j < nfr; j++) {
                unsigned rl = get32(lens + 8 * j), kl = get32(lens + 8 * j + 4);
                size_t pre = linked ? ro : 0;
                memcpy(rdec, raw, ro);
                dec_check(bl + bo, kl, a & 1, a >> 1, pre, rl, linked, raw + ro, (long)rl);
                if (rl) dec_check(bl + bo, kl, a & 1, a >> 1, pre, rl - 1, linked, NULL, 0);   /* one short */
                ro += rl; bo += kl;
                if (!a) { frames++; bytes += rl; }
            }
        }
    }
    printf("vtest %s: %u frames, %lu bytes, 4 parities\n", path, frames, bytes);
}

/* FUZZ */
static void mutate_check(size_t k, unsigned sa, unsigned da, size_t pre, size_t cap) {
    dec_check(blk2, k, sa, da, pre, cap, 1, NULL, 0);
}
static void t_fuzz(unsigned seed, unsigned iters) {
    rng_s = seed ? seed : 1;
    static uint8_t raw[20000];
    for (unsigned it = 0; it < iters; it++) {
        unsigned pre = rnd() % 4 == 0 ? rnd() % 3000 : 0, n = 1 + rnd() % 1518, kind = rnd() % NGEN;
        gen(raw, pre + n, kind);
        if (pre && (it & 1)) memcpy(raw + pre, raw + rnd() % pre, n / 2);
        int k;
        {
            static LZ4_stream_t ls;
            LZ4_initStream(&ls, sizeof ls);
            if (pre) LZ4_loadDict(&ls, (const char *)raw, (int)pre);
            k = LZ4_compress_fast_continue(&ls, (const char *)raw + pre, (char *)blk, (int)n, sizeof blk, 1);
        }
        CHECK(k > 0, "liblz4 compress");
        memcpy(rdec, raw, pre);
        unsigned a = it & 3, sa = a & 1, da = a >> 1;
        for (unsigned b = 0; b < 4; b++)
            dec_check(blk, (size_t)k, b & 1, b >> 1, pre, n + (rnd() & 7), pre != 0, raw + pre, (long)n);
        /* truncated: every length for a few frames, else 8 random ones */
        unsigned all = it % 16 == 0;
        for (unsigned t = 0; t < (all ? (unsigned)k : 8u); t++) {
            unsigned tl = all ? t : rnd() % (unsigned)k;
            memcpy(blk2, blk, tl);
            mutate_check(tl, sa, da, pre, n);
        }
        /* corrupted: 1..4 random bytes changed */
        for (unsigned t = 0; t < 12; t++) {
            memcpy(blk2, blk, (size_t)k);
            unsigned m = 1 + rnd() % 4;
            while (m--) blk2[rnd() % (unsigned)k] = (uint8_t)(rnd() % 3 ? rnd() : rnd() % 2 ? 0 : 0xFF);
            mutate_check((size_t)k, sa, da, pre, rnd() % 2 ? n : rnd() % (n + 40));
        }
        /* random bytes */
        size_t rl = 1 + rnd() % 200;
        for (size_t i = 0; i < rl; i++) blk2[i] = (uint8_t)rnd();
        mutate_check(rl, sa, da, pre, rnd() % 2000);
    }
    printf("vtest FUZZ: %u frames, each at 4 parities, truncated, corrupted, random\n", iters);
}

/* Encoder: asm against the C model, both from the same table contents. */
static void enc_one(const uint8_t *raw, size_t pre, size_t n, unsigned sa, unsigned da, unsigned long entries,
                    int capcheck) {
    uint8_t *win = sbuf + sa, *src = win + pre;
    memmove(win, raw, pre + n);
    static uint16_t t0[16384];
    if (capcheck) memcpy(t0, tab_a, sizeof t0);
    uint8_t *d = obuf + G + da;
    guard(obuf, sizeof obuf);
    unsigned long kc = lz4_encode_linked_ref(src, n, blk, sizeof blk, tab_c, entries, win);
    unsigned long ka = pre ? lz4_encode_linked(src, n, d, 69000, tab_a, entries, win)
                           : lz4_encode(src, n, d, 69000, tab_a, entries);
    CHECK(ka == kc && !memcmp(d, blk, kc), "encode n=%lu pre=%lu sa=%u da=%u: asm %lu, model %lu",
          (unsigned long)n, (unsigned long)pre, sa, da, ka, kc);
    CHECK(guard_ok(obuf, G + da) && guard_ok(d + ka, G), "encode wrote outside");
    CHECK(!memcmp(tab_a, tab_c, entries * 2), "tables differ");
    memcpy(rdec, win, pre);
    int r = pre ? LZ4_decompress_safe_usingDict((const char *)d, (char *)rdec + pre, (int)ka, (int)n,
                                                (const char *)rdec, (int)pre)
                : LZ4_decompress_safe((const char *)d, (char *)rdec, (int)ka, (int)n);
    CHECK(r == (int)n && !memcmp(rdec + pre, src, n), "liblz4 decode of asm output: %d (n=%lu)", r,
          (unsigned long)n);
    if (capcheck && ka > 1) {
        unsigned long caps[3] = { ka, ka - 1, rnd() % ka };
        for (unsigned c = 0; c < 3; c++) {
            static uint16_t t1[16384];
            memcpy(t1, t0, sizeof t1);
            guard(obuf, sizeof obuf);
            unsigned long k2 = pre ? lz4_encode_linked(src, n, d, caps[c], t1, entries, win)
                                   : lz4_encode(src, n, d, caps[c], t1, entries);
            CHECK(k2 == (c ? 0 : ka) && (c || !memcmp(d, blk, ka)), "cap %lu: %lu (size %lu)", caps[c], k2, ka);
            CHECK(guard_ok(obuf, G + da) && guard_ok(d + caps[c], G), "cap %lu: wrote past the cap", caps[c]);
        }
    }
}

static void t_enc(const char *path, unsigned long entries) {
    size_t n = loadvec(path), p = 8;
    unsigned ng = get32(vec + 4), frames = 0;
    unsigned long bytes = 0;
    for (unsigned i = 0; i < 16384; i++) tab_a[i] = tab_c[i] = (uint16_t)(i * 40503u);
    for (unsigned g = 0; g < ng && p < n; g++) {
        int linked = vec[p];
        unsigned nfr = (unsigned)vec[p + 2] << 8 | vec[p + 3], tr = get32(vec + p + 4), tb = get32(vec + p + 8);
        const uint8_t *lens = vec + p + 12, *raw = lens + 8 * nfr;
        p += 12 + 8 * nfr + tr + tb;
        unsigned ro = 0;
        for (unsigned j = 0; j < nfr; j++) {
            unsigned rl = get32(lens + 8 * j), a = (g + j) & 3;
            if (linked) enc_one(raw, ro, rl, a & 1, a >> 1, entries, j % 4 == 0);
            else enc_one(raw + ro, 0, rl, a & 1, a >> 1, entries, j % 4 == 0);
            ro += rl; frames++; bytes += rl;
        }
    }
    printf("vtest ENC %s %lu: %u frames, %lu bytes\n", path, entries, frames, bytes);
}

static void t_encr(unsigned lo, unsigned hi) {
    static uint8_t raw[20000];
    rng_s = lo * 7919u + hi;
    for (unsigned i = 0; i < 16384; i++) tab_a[i] = tab_c[i] = (uint16_t)rnd();
    for (unsigned n = lo; n <= hi; n++)
        for (unsigned a = 0; a < 4; a++) {
            unsigned kind = (n + a) % NGEN, pre = (n % 5 == 0) ? rnd() % 4000 : 0;
            gen(raw, pre + n, kind);
            if (pre && (n & 1)) memcpy(raw + pre, raw + rnd() % pre, n / 2);
            enc_one(raw, pre, n, a & 1, a >> 1, (n & 1) ? 1024 : 4096, 1);
        }
    printf("vtest ENCR %u..%u: every length at 4 parities\n", lo, hi);
}

/* TAIL: the input ends exactly where a buffer ends; the bytes after it are a guard region
 * that must never be read (test.sh checks the memory trace for reads in it). */
static void t_tail(void) {
    static uint8_t raw[4000];
    uint8_t *top = sbuf + sizeof sbuf - 256;          /* the guard region: [top, top + 256) */
    printf("GUARD %lx %lx\n", (unsigned long)top, (unsigned long)(top + 256));
    rng_s = 99;
    for (unsigned it = 0; it < 24; it++) {
        unsigned n = 1 + rnd() % 1518;
        gen(raw, n, it % NGEN);
        int k = LZ4_compress_default((const char *)raw, (char *)blk, (int)n, sizeof blk);
        for (unsigned v = 0; v < 3; v++) {
            unsigned kl = v == 0 ? (unsigned)k : v == 1 ? (unsigned)k - 1 - rnd() % (unsigned)k : (unsigned)k;
            uint8_t *s = top - kl;
            memcpy(s, blk, kl);
            if (v == 2 && kl > 2) s[rnd() % kl] ^= (uint8_t)(1 + rnd() % 255);
            uint8_t *dst = obuf + G + (it & 1);
            long r = lz4_decode(s, kl, dst, dst + n + 16, dst);
            if (v == 0) CHECK(r == (long)n && !memcmp(dst, raw, n), "tail decode");
        }
        /* the encoder's input at the very end too */
        uint8_t *s = top - n;
        memcpy(s, raw, n);
        unsigned long ka = lz4_encode(s, n, obuf + G, 69000, tab_a, 1024);
        CHECK(ka > 0, "tail encode");
        if (n > 300) { s = top - n; ka = lz4_encode_linked(s + 200, n - 200, obuf + G, 69000, tab_a, 1024, s); }
    }
}

/* ODD: a little of everything at every parity, small enough for a full memory trace. */
static void t_odd(void) {
    static uint8_t raw[3000];
    rng_s = 7;
    for (unsigned it = 0; it < 12; it++) {
        unsigned n = it < 4 ? 600 + rnd() % 900 : 20 + rnd() % 300;
        gen(raw, n, it % NGEN == 0 ? 2 : it % NGEN);
        int k = LZ4_compress_default((const char *)raw, (char *)blk, (int)n, sizeof blk);
        for (unsigned a = 0; a < 4; a++) {
            dec_check(blk, (size_t)k, a & 1, a >> 1, 0, n, 0, raw, (long)n);
            dec_check(blk, (size_t)k, a & 1, a >> 1, 0, n - 1, 0, NULL, 0);
            unsigned pre = it & 1 ? 100 : 0;
            enc_one(raw, pre, n - pre, a & 1, a >> 1, 1024, a == 0);
        }
    }
    lowwin = (const uint8_t *)0x400;
    for (unsigned it = 0; it < 4; it++) {
        unsigned n = 200 + rnd() % 800;
        gen(raw, n, 2);
        int k = LZ4_compress_default((const char *)raw, (char *)blk, (int)n, sizeof blk);
        for (unsigned a = 0; a < 4; a++) dec_check(blk, (size_t)k, a & 1, a >> 1, 0, n, 0, raw, (long)n);
    }
    lowwin = NULL;
}

int main(int argc, char **argv) {
    if (argc < 2) { printf("vtest DEC|LOWWIN|FUZZ|ENC|ENCR|TAIL|ODD ...\n"); return 20; }
    const char *m = argv[1];
    if (!strcmp(m, "DEC") && argc > 2) t_dec(argv[2]);
    else if (!strcmp(m, "LOWWIN") && argc > 2) { lowwin = (const uint8_t *)0x400; t_dec(argv[2]); }
    else if (!strcmp(m, "FUZZ") && argc > 3) t_fuzz((unsigned)atol(argv[2]), (unsigned)atol(argv[3]));
    else if (!strcmp(m, "ENC") && argc > 3) t_enc(argv[2], (unsigned long)atol(argv[3]));
    else if (!strcmp(m, "ENCR") && argc > 3) t_encr((unsigned)atol(argv[2]), (unsigned)atol(argv[3]));
    else if (!strcmp(m, "TAIL")) t_tail();
    else if (!strcmp(m, "ODD")) t_odd();
    else { printf("vtest: bad arguments\n"); return 20; }
    printf("vtest %s: %lu checks, %d failures\nRESULT: %s\n", m, nchk, fails, fails ? "FAIL" : "PASS");
    return fails ? 10 : 0;
}
