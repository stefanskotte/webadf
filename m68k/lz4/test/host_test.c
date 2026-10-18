/*
 * host_test: the C reference model (lz4_68k.c) against the reference liblz4 on the host, and
 * the decoder test vectors for the 68000 test (vtest.c).
 * Copyright (c) 2026 Stefan Skotte and contributors. MIT licence (../LICENSE).
 *
 *   host_test CORPUS [VECDIR]
 * CORPUS: tools/lz4-measure's corpus.bin ("LZ4C", types, then u8 type, u8 dir, u8 flush,
 * u16 len, bytes per frame). With VECDIR, writes dec-{fast,hc9,linkf,link9}.vec there:
 * the corpus' frames in groups (per traffic type, <= 20 frames and <= 16128 bytes, like a
 * PaulaNET batch), each frame's LZ4 block from liblz4 (fast or HC 9; per frame, or linked to
 * the group's earlier frames). Format: "L4V1", u32 groups; per group u8 linked, u8 codec,
 * u16 frames, u32 raw bytes, u32 block bytes, frames x (u32 raw, u32 block), the raw bytes,
 * the blocks. All numbers big-endian.
 * Exit status 0 and "RESULT: PASS" when every check passes.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "lz4.h"
#include "lz4hc.h"
#include "../lz4_68k.h"
#include "t_common.h"

static int fails;
#define CHECK(c, ...) do { if (!(c)) { if (fails++ < 20) { printf("FAIL %s:%d: ", __FILE__, __LINE__); \
    printf(__VA_ARGS__); printf("\n"); } } } while (0)

#define MAXF 4000
static struct { unsigned ty; unsigned len; const uint8_t *d; } F[MAXF];
static unsigned nf, ntypes;
static char tname[32][64];
static uint16_t tab[16384];
static uint8_t blk[70000], dec[140000];

static void tab_init(int mode) {
    for (unsigned i = 0; i < 16384; i++) tab[i] = mode ? (uint16_t)rnd() : 0;
}

/* Encode with the model and check: liblz4 and ref_decode both give the input back, the cap
 * is exact (size fits, size - 1 does not, and nothing lands at or past dst + cap). */
static unsigned long enc_check(const uint8_t *src, unsigned long n, const uint8_t *win,
                               unsigned long entries, int capcheck) {
    static uint16_t t2[16384];
    memcpy(t2, tab, sizeof tab);
    memset(blk, 0xA5, sizeof blk);
    unsigned long k = lz4_encode_linked_ref(src, n, blk, sizeof blk - 64, tab, entries, win);
    CHECK(k > 0, "encode n=%lu returned 0 with a large cap", n);
    if (!k) return 0;
    for (unsigned i = 0; i < 64; i++) CHECK(blk[k + i] == 0xA5, "wrote past the block");
    size_t pre = (size_t)(src - win);
    memcpy(dec, win, pre);
    int r = win == src ? LZ4_decompress_safe((const char *)blk, (char *)dec, (int)k, (int)n)
                       : LZ4_decompress_safe_usingDict((const char *)blk, (char *)dec + pre, (int)k,
                                                       (int)n, (const char *)dec, (int)pre);
    CHECK(r == (int)n && !memcmp(dec + pre, src, n), "liblz4 decode n=%lu pre=%zu: %d", n, pre, r);
    memset(dec + pre, 0, n + 16);
    long q = ref_decode(blk, k, dec + pre, dec + pre + n, dec, NULL);
    CHECK(q == (long)n && !memcmp(dec + pre, src, n), "ref_decode n=%lu: %ld", n, q);
    if (capcheck) {
        static uint16_t t3[16384];
        static uint8_t b2[70000];
        memcpy(t3, t2, sizeof t2);
        memset(b2, 0x5A, k + 64);
        unsigned long k2 = lz4_encode_linked_ref(src, n, b2, k, t3, entries, win);
        CHECK(k2 == k && !memcmp(b2, blk, k), "cap = size: n=%lu", n);
        memcpy(t3, t2, sizeof t2);
        memset(b2, 0x5A, k + 64);
        k2 = lz4_encode_linked_ref(src, n, b2, k - 1, t3, entries, win);
        CHECK(k2 == 0, "cap = size - 1 accepted: n=%lu", n);
        for (unsigned i = k - 1; i < k + 64; i++) CHECK(b2[i] == 0x5A, "cap = size - 1: wrote at %u", i);
        unsigned long c = rnd() % (k + 1);
        memcpy(t3, t2, sizeof t2);
        memset(b2, 0x5A, k + 64);
        k2 = lz4_encode_linked_ref(src, n, b2, c, t3, entries, win);
        CHECK(k2 == (c >= k ? k : 0), "cap %lu: %lu", c, k2);
        for (unsigned i = (unsigned)c; i < k + 64; i++) CHECK(b2[i] == 0x5A, "cap %lu: wrote at %u", c, i);
    }
    return k;
}

static void load(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) { printf("cannot open %s\n", path); exit(2); }
    static uint8_t buf[4000000];
    size_t n = fread(buf, 1, sizeof buf, f);
    fclose(f);
    if (n < 5 || memcmp(buf, "LZ4C", 4)) { printf("not a corpus\n"); exit(2); }
    size_t p = 4;
    ntypes = buf[p++];
    for (unsigned i = 0; i < ntypes; i++) { unsigned l = buf[p++]; memcpy(tname[i], buf + p, l); p += l; }
    while (p + 5 <= n && nf < MAXF) {
        F[nf].ty = buf[p]; F[nf].len = (unsigned)buf[p + 3] << 8 | buf[p + 4];
        F[nf].d = buf + p + 5;
        p += 5 + F[nf].len;
        nf++;
    }
}

/* Group the corpus' frames like batches: per type, <= 20 frames, <= 16128 bytes. g[i] = the
 * group number of frame i; returns the number of groups. */
static unsigned grp[MAXF];
static unsigned group(void) {
    unsigned ng = 0, cur[32], cnt[32], used[32];
    for (unsigned t = 0; t < 32; t++) { cnt[t] = 0; used[t] = 0; cur[t] = 0; }
    for (unsigned i = 0; i < nf; i++) {
        unsigned t = F[i].ty;
        if (!cnt[t] || cnt[t] == 20 || used[t] + F[i].len > 16128) { cur[t] = ng++; cnt[t] = 0; used[t] = 0; }
        grp[i] = cur[t]; cnt[t]++; used[t] += F[i].len;
    }
    return ng;
}

static void writevec(const char *dir, const char *name, int linked, int hc, unsigned ng) {
    char p[512];
    snprintf(p, sizeof p, "%s/%s", dir, name);
    FILE *f = fopen(p, "wb");
    uint8_t h[16];
    memcpy(h, "L4V1", 4); put32(h + 4, ng);
    fwrite(h, 1, 8, f);
    static uint8_t raw[20000], blocks[30000];
    static unsigned rl[20], bl[20];
    static LZ4_stream_t ls;
    static LZ4_streamHC_t hs;
    for (unsigned g = 0; g < ng; g++) {
        unsigned nfr = 0, tr = 0, tb = 0;
        LZ4_initStream(&ls, sizeof ls);
        LZ4_initStreamHC(&hs, sizeof hs);
        LZ4_resetStreamHC_fast(&hs, 9);
        for (unsigned i = 0; i < nf; i++) {
            if (grp[i] != g) continue;
            memcpy(raw + tr, F[i].d, F[i].len);
            int k;
            if (!linked) k = hc ? LZ4_compress_HC((const char *)raw + tr, (char *)blocks + tb, (int)F[i].len, 30000 - (int)tb, 9)
                                : LZ4_compress_default((const char *)raw + tr, (char *)blocks + tb, (int)F[i].len, 30000 - (int)tb);
            else k = hc ? LZ4_compress_HC_continue(&hs, (const char *)raw + tr, (char *)blocks + tb, (int)F[i].len, 30000 - (int)tb)
                        : LZ4_compress_fast_continue(&ls, (const char *)raw + tr, (char *)blocks + tb, (int)F[i].len, 30000 - (int)tb, 1);
            CHECK(k > 0, "liblz4 compress");
            rl[nfr] = F[i].len; bl[nfr] = (unsigned)k;
            tr += F[i].len; tb += (unsigned)k; nfr++;
        }
        /* the liblz4 blocks decode with ref_decode too (the oracle agrees with liblz4) */
        for (unsigned j = 0, ro = 0, bo = 0; j < nfr; j++) {
            long q = ref_decode(blocks + bo, bl[j], dec + ro, dec + ro + rl[j], linked ? dec : dec + ro, NULL);
            CHECK(q == (long)rl[j] && !memcmp(dec + ro, raw + ro, rl[j]), "ref_decode of liblz4 %s", name);
            ro += rl[j]; bo += bl[j];
        }
        h[0] = (uint8_t)linked; h[1] = (uint8_t)hc; h[2] = (uint8_t)(nfr >> 8); h[3] = (uint8_t)nfr;
        put32(h + 4, tr); put32(h + 8, tb);
        fwrite(h, 1, 12, f);
        for (unsigned j = 0; j < nfr; j++) { put32(h, rl[j]); put32(h + 4, bl[j]); fwrite(h, 1, 8, f); }
        fwrite(raw, 1, tr, f);
        fwrite(blocks, 1, tb, f);
    }
    fclose(f);
}

int main(int argc, char **argv) {
    if (argc < 2) { printf("host_test CORPUS [VECDIR]\n"); return 2; }
    load(argv[1]);
    unsigned ng = group();
    unsigned long checks = 0;

    /* A. the corpus, per frame, the table carried along each type's stream */
    static const unsigned long sizes[] = { 1024, 4096, 256, 16384 };
    for (unsigned si = 0; si < 4; si++)
        for (int init = 0; init < 2; init++) {
            unsigned long rawb = 0, packb = 0;
            for (unsigned t = 0; t < ntypes; t++) {
                tab_init(init);
                for (unsigned i = 0; i < nf; i++) if (F[i].ty == t) {
                    unsigned long k = enc_check(F[i].d, F[i].len, F[i].d, sizes[si], si < 2 && i % 4 == 0);
                    rawb += F[i].len; packb += k; checks++;
                }
            }
            if (!init) printf("corpus per frame, %5lu entries: %lu -> %lu bytes (%.1f%%)\n", sizes[si], rawb, packb,
                              100.0 * packb / rawb);
        }

    /* B. the corpus, linked: each frame against its group's earlier frames */
    for (unsigned si = 0; si < 2; si++) {
        static uint8_t gb[20000];
        unsigned long rawb = 0, packb = 0;
        for (unsigned t = 0; t < ntypes; t++) {
            tab_init(0);
            for (unsigned g = 0; g < ng; g++) {
                size_t used = 0;
                for (unsigned i = 0; i < nf; i++) if (grp[i] == g && F[i].ty == t) {
                    memcpy(gb + used, F[i].d, F[i].len);
                    unsigned long k = enc_check(gb + used, F[i].len, gb, sizes[si], i % 4 == 0);
                    used += F[i].len; rawb += F[i].len; packb += k; checks++;
                }
            }
        }
        printf("corpus linked,    %5lu entries: %lu -> %lu bytes (%.1f%%)\n", sizes[si], rawb, packb, 100.0 * packb / rawb);
    }

    /* C. every length 1..1518, every kind of data, at both src parities (the model does not
     * care; the asm test does the same) */
    static uint8_t src[70000];
    tab_init(1);
    for (unsigned k = 0; k < NGEN; k++)
        for (unsigned n = 1; n <= 1518; n++) {
            unsigned a = n & 1;
            gen(src + a, n, k);
            enc_check(src + a, n, src + a, n % 3 ? 1024 : 4096, 1);
            checks++;
        }

    /* D. edge cases: tiny inputs, n = 65535, a window reaching 65536 */
    for (unsigned k = 0; k < NGEN; k++)
        for (unsigned n = 0; n <= 40; n++) { gen(src, n, k); enc_check(src, n, src, 1024, n > 0); checks++; }
    for (unsigned k = 0; k < NGEN; k++) { gen(src, 65535, k); enc_check(src, 65535, src, 4096, 1); checks++; }
    for (unsigned k = 0; k < NGEN; k++) {
        gen(src, 65536, k);
        enc_check(src + 64000, 1536, src, 1024, 1);
        enc_check(src + 1, 65535, src, 4096, 0);
        checks += 2;
    }

    /* E. random linked frames: a random prefix, then a frame */
    for (unsigned it = 0; it < 3000; it++) {
        unsigned pre = rnd() % 15000, n = 1 + rnd() % 1518, k = rnd() % NGEN;
        gen(src, pre + n, k);
        if (it & 1) memcpy(src + pre, src + rnd() % (pre + 1), n / 2);   /* the frame repeats the prefix */
        enc_check(src + pre, n, src, it % 3 ? 1024 : 4096, it % 8 == 0);
        checks++;
    }

    if (argc > 2) {
        writevec(argv[2], "dec-fast.vec", 0, 0, ng);
        writevec(argv[2], "dec-hc9.vec", 0, 1, ng);
        writevec(argv[2], "dec-linkf.vec", 1, 0, ng);
        writevec(argv[2], "dec-link9.vec", 1, 1, ng);
        printf("vectors: %u frames in %u groups, 4 files in %s\n", nf, ng, argv[2]);
    }
    printf("host_test: %u frames, %lu encodes checked, %d failures\nRESULT: %s\n", nf, checks, fails,
           fails ? "FAIL" : "PASS");
    return fails ? 1 : 0;
}
