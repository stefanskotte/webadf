/*
 * lz4bench: an Amiga executable that m68k/build.sh runs under vamos (an emulated 68000 or 68020)
 * to count the cycles of LZ4 and PaulaNET RLE, decode and encode, on corpus frames.
 *
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09). The RLE here is ours: the C reference
 * (wifi-floppy/firmware/src/pnet_mfm.c, renamed X_c) and the 68000 asm (tools/netloop/pnet_asm.S).
 *
 *   lz4bench FILE KIND CODEC REPS     run CODEC over every record of FILE, REPS times
 *   lz4bench FILE KIND CODEC VERIFY   run it once and check every output; RESULT: PASS/FAIL
 * KIND: F = a <type>.frames file (u16 raw, rle, lz4, hc9 lengths; then the four strings, even),
 *       B = a <type>.batches file (u16 raw, u16 packed; the raw bytes, the HC 9 block, even).
 * CODEC:
 *   none      the loop alone (build.sh subtracts it)
 *   lzfast    Arnaud Carre's lz4_fastest.asm on the hc9 block (F) or the batch block (B)
 *   lznorm    his lz4_normal.asm, same inputs
 *   lzfastl   lz4_fastest.asm on the LZ4 (acceleration 1) block, F only
 *   lzc       the reference LZ4_decompress_safe (lz4.c v1.10.0, gcc -m68000 -O2), hc9/batch block
 *   rledasm   our pnet_rle_decode, 68000 asm, F only
 *   rledc     our pnet_rle_decode, C, F only
 *   lzenc     the reference LZ4_compress_fast_extState (acceleration 1) on the raw bytes
 *   rleeasm   our pnet_rle_encode, asm, F only
 *   rleec     our pnet_rle_encode, C, F only
 *   lz4pasm   our prototype compressor, 68000 asm (m68k/lz4p.asm), cap = the raw size; VERIFY
 *             also checks it byte for byte against the C model and decodes it with LZ4
 *   lz4pc     the C model (lz4p.c), gcc -m68000 -O2
 *   ourdec    our decoder (m68k/lz4/lz4_68k.asm lz4_decode) on the hc9 block (F) or the batch
 *             block (B), dst_end = dst + the raw size, window = dst
 *   ourdecl   the same on the LZ4 (acceleration 1) block, F only
 *   ourenc    our encoder (m68k/lz4 lz4_encode), 1,024-entry table, cap = the raw size; VERIFY
 *             also checks it byte for byte against its C model and decodes it with LZ4
 *   ourenc4k  the same with a 4,096-entry table
 *   ourdecu   our decoder built with LZ4_68K_UNCHECKED_READS=1 (no window / offset-0 checks)
 * Prints the raw bytes one pass covers, so build.sh can turn vamos' cycle total into cycles/byte.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include "lz4.h"
#include "pnet_asm.h"
#include "lz4p.h"
#include "lz4_68k.h"
long lz4u_decode(const void *src, unsigned long srclen, void *dst, void *dst_end, const void *window);

void lz4_fastest(const void *src, void *dst, unsigned long packed);
void lz4_normal(const void *src, void *dst, unsigned long packed);
size_t lz4p_encode_asm(const uint8_t *src, size_t n, uint8_t *dst, size_t cap, uint16_t *tab);

#define MAXR 64
typedef struct { const uint8_t *raw, *rle, *lz, *hc; unsigned nraw, nrle, nlz, nhc; } rec_t;
static rec_t R[MAXR];
static unsigned nr;
static uint8_t outbuf[20000], encbuf[20000];
static LZ4_stream_t lzstate;                       /* static: the Amiga's default stack is 4 KB */

static unsigned get16(const uint8_t *p) { return (unsigned)(p[0] << 8 | p[1]); }
static unsigned ev(unsigned x) { return (x + 1u) & ~1u; }

static int load(const char *path, int kind) {
    FILE *f = fopen(path, "rb");
    if (!f) return 0;
    static uint8_t buf[300000] __attribute__((aligned(4)));
    size_t n = fread(buf, 1, sizeof buf, f);
    fclose(f);
    size_t p = 0;
    while (nr < MAXR && p + 4 <= n) {
        rec_t *r = &R[nr];
        if (kind == 'F') {
            if (p + 8 > n) break;
            r->nraw = get16(buf + p); r->nrle = get16(buf + p + 2);
            r->nlz = get16(buf + p + 4); r->nhc = get16(buf + p + 6);
            p += 8;
            r->raw = buf + p; p += ev(r->nraw);
            r->rle = buf + p; p += ev(r->nrle);
            r->lz = buf + p; p += ev(r->nlz);
            r->hc = buf + p; p += ev(r->nhc);
        } else {
            r->nraw = get16(buf + p); r->nhc = get16(buf + p + 2);
            p += 4;
            r->raw = buf + p; p += ev(r->nraw);
            r->hc = buf + p; p += ev(r->nhc);
            r->rle = r->lz = NULL; r->nrle = r->nlz = 0;
        }
        if (p > n) break;
        nr++;
    }
    return nr > 0;
}

static const char *const codecs[] = { "none", "lzfast", "lznorm", "lzfastl", "lzc", "rledasm",
                                      "rledc", "lzenc", "rleeasm", "rleec", "lz4pasm", "lz4pc",
                                      "ourdec", "ourdecl", "ourenc", "ourenc4k", "ourdecu" };
static uint16_t tab_o[16384], tab_oc[16384];
static uint16_t tab_a[LZ4P_HASH], tab_c[LZ4P_HASH];
static uint8_t encbuf2[20000];
#define NCODEC (sizeof codecs / sizeof codecs[0])

/* One pass of codec c (an index into codecs) over all records; 0 if a check failed (check). */
static int pass(unsigned c, int check) {
    for (unsigned i = 0; i < nr; i++) {
        const rec_t *r = &R[i];
        long got = (long)r->nraw;
        const uint8_t *cmp = outbuf;
        size_t k;
        switch (c) {
        case 0: cmp = NULL; break;
        case 1: lz4_fastest(r->hc, outbuf, r->nhc); break;
        case 2: lz4_normal(r->hc, outbuf, r->nhc); break;
        case 3: if (!r->lz) return 0; lz4_fastest(r->lz, outbuf, r->nlz); break;
        case 4: got = LZ4_decompress_safe((const char *)r->hc, (char *)outbuf, (int)r->nhc, sizeof outbuf); break;
        case 5: if (!r->rle) return 0; got = pnet_rle_decode_asm(r->rle, r->nrle, outbuf, sizeof outbuf); break;
        case 6: if (!r->rle) return 0; got = pnet_rle_decode_c(r->rle, r->nrle, outbuf, sizeof outbuf); break;
        case 7:
            got = LZ4_compress_fast_extState(&lzstate, (const char *)r->raw, (char *)encbuf, (int)r->nraw,
                                             sizeof encbuf, 1);
            if (check && (got <= 0 ||
                LZ4_decompress_safe((const char *)encbuf, (char *)outbuf, (int)got, sizeof outbuf) != (int)r->nraw))
                return 0;
            got = (long)r->nraw;
            if (!check) cmp = NULL;
            break;
        case 8: case 9:
            if (!r->rle) return 0;
            k = c == 8 ? pnet_rle_encode_asm(r->raw, r->nraw, encbuf) : pnet_rle_encode_c(r->raw, r->nraw, encbuf);
            if (check && (k != r->nrle || memcmp(encbuf, r->rle, k))) return 0;
            cmp = NULL;
            break;
        case 10: case 11:
            k = c == 10 ? lz4p_encode_asm(r->raw, r->nraw, encbuf, r->nraw, tab_a)
                        : lz4p_encode(r->raw, r->nraw, encbuf, r->nraw, tab_c);
            if (check && c == 10) {
                size_t m = lz4p_encode(r->raw, r->nraw, encbuf2, r->nraw, tab_c);
                if (k != m || memcmp(encbuf, encbuf2, k)) return 0;
                if (k && LZ4_decompress_safe((const char *)encbuf, (char *)outbuf, (int)k, sizeof outbuf)
                         != (int)r->nraw) return 0;
            }
            cmp = NULL;
            break;
        case 12: got = lz4_decode(r->hc, r->nhc, outbuf, outbuf + r->nraw, outbuf); break;
        case 13: if (!r->lz) return 0; got = lz4_decode(r->lz, r->nlz, outbuf, outbuf + r->nraw, outbuf); break;
        case 14: case 15: {
            unsigned long e = c == 14 ? 1024 : 4096;
            k = lz4_encode(r->raw, r->nraw, encbuf, r->nraw, tab_o, e);
            if (check) {
                size_t m = lz4_encode_ref(r->raw, r->nraw, encbuf2, r->nraw, tab_oc, e);
                if (k != m || memcmp(encbuf, encbuf2, k)) return 0;
                if (k && LZ4_decompress_safe((const char *)encbuf, (char *)outbuf, (int)k, sizeof outbuf)
                         != (int)r->nraw) return 0;
            }
            cmp = NULL;
            break;
        }
        case 16: got = lz4u_decode(r->hc, r->nhc, outbuf, outbuf + r->nraw, outbuf); break;
        default: return 0;
        }
        if (check && cmp && (got != (long)r->nraw || memcmp(cmp, r->raw, r->nraw))) return 0;
    }
    return 1;
}

int main(int argc, char **argv) {
    if (argc < 5) { printf("lz4bench FILE F|B CODEC REPS|VERIFY\n"); return 20; }
    if (!load(argv[1], argv[2][0])) { printf("lz4bench: cannot load %s\n", argv[1]); return 20; }
    unsigned c = 0;
    while (c < NCODEC && strcmp(codecs[c], argv[3])) c++;
    if (c == NCODEC) { printf("lz4bench: unknown codec %s\n", argv[3]); return 20; }
    unsigned long raw = 0;
    for (unsigned i = 0; i < nr; i++) raw += R[i].nraw;
    if (!strcmp(argv[4], "VERIFY")) {
        int ok = pass(c, 1);
        printf("lz4bench: %s %s %u records %lu bytes RESULT: %s\n", argv[1], argv[3], nr, raw, ok ? "PASS" : "FAIL");
        return ok ? 0 : 10;
    }
    long reps = atol(argv[4]);
    for (long k = 0; k < reps; k++) if (!pass(c, 0)) { printf("lz4bench: codec failed\n"); return 10; }
    printf("lz4bench: records %u raw %lu reps %ld\n", nr, raw, reps);
    return 0;
}
