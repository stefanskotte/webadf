/*
 * lz4measure: PaulaNET batch sizes with today's RLE against LZ4 block compression, on the host.
 *
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09). The RLE is the board's own
 * (wifi-floppy/firmware/src/pnet_mfm.c, compiled unchanged); LZ4 is the reference liblz4 (BSD-2).
 *
 * Usage: lz4measure corpus.bin [dump-dir]
 *   Reads corpus.py's frames, packs them into batches with the real rules, and prints per traffic
 *   type the wire bytes (what crosses the floppy: PacketsHeader 4 + per frame 8 + data, even) for:
 *     raw      the frames' own bytes (no such format exists; the reference)
 *     rle      today: pnet_rle_encode per frame
 *     lz4      LZ4_compress_default per frame (acceleration 1)
 *     hc9/hc12 LZ4_compress_HC per frame
 *     best     per frame the smaller of rle and lz4 (the board's fallback rule)
 *     lz4p     per frame our 68000-shaped prototype compressor (lz4p.c; 1,024-entry table never
 *              cleared), or rle when that is smaller or lz4p gives up -- the Amiga-side encoder
 *     linkf    LZ4 (acceleration 1) per frame, each frame may refer back into the earlier frames
 *              of the same batch (LZ4 "linked blocks": the decoder keeps the batch's frames
 *              contiguous); per frame the smaller of that and rle
 *     link9    the same with LZ4 HC 9
 *     batch9   one LZ4 HC 9 block over the whole batch (a different format: 4 + 2 per frame + 8)
 *   With dump-dir, writes per type a file of frames for the 68000 bench (tools/lz4-measure/m68k):
 *   records of u16 raw, rle, lz4, hc9 lengths, then the four byte strings, each padded even
 *   (<type>.frames, first 64 frames); and <type>.batches, the first 8 batches as one LZ4 HC 9
 *   block each: u16 raw, u16 packed, the raw bytes, the block, each padded even.
 *
 * Batching. To the Amiga (board side, pnet_link_fit): at most 20 frames and a payload bound
 * (4 + sum(8 + pnet_rle_bound(len))) of at most 16,128. To the board (Rob's driver,
 * paulaNetAddPacket in RLE mode): budget 8,192 less the headers and a 14-byte worst case; a frame
 * is added while its length fits the space left, and the batch closes once less than 1,518
 * remains or 20 frames are in. Both also close a batch on the corpus' flush mark (a sparse flow
 * sends what is queued). The batches are fixed by today's RLE and reused for every codec, so each
 * line compares the same batches.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <time.h>
#include <lz4.h>
#include <lz4hc.h>
#include "pnet_mfm.h"
#include "lz4p.h"

#define MAXT 32
#define MAXF 20
#define MTU 1518
enum { C_RAW, C_RLE, C_LZ4, C_HC9, C_HC12, C_BEST, C_LZ4P, C_LINKF, C_LINK9, C_BATCH9, NC };
static const char *cname[NC] = { "raw", "rle", "lz4", "hc9", "hc12", "best", "lz4p", "linkf", "link9", "batch9" };

typedef struct { uint8_t *d; uint16_t len; } fr_t;
typedef struct { fr_t f[MAXF]; unsigned n; size_t used; } batch_t;
typedef struct {
    char name[64]; int dir;
    batch_t open;
    double *ratio[NC]; size_t nb, capb;
    uint64_t raw, wire[NC], frames;
    FILE *dump, *bdump; unsigned dumped, bdumped;
} type_t;

static type_t T[MAXT];
static unsigned nt;
static double enc_ns[NC];       /* host encode time, summed over all batches */
static uint64_t enc_raw;

static size_t even(size_t x) { return (x + 1u) & ~(size_t)1u; }

static double now_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1e9 + ts.tv_nsec;
}

static void die(const char *m) { fprintf(stderr, "lz4measure: %s\n", m); exit(1); }

static size_t rle(const uint8_t *s, size_t n, uint8_t *o) {
    size_t r = pnet_rle_encode(s, n, o);
    uint8_t chk[MTU];
    if (pnet_rle_decode(o, r, chk, sizeof chk) != (long)n || memcmp(chk, s, n)) die("rle round trip");
    return r;
}

static size_t lz4(const uint8_t *s, size_t n, uint8_t *o, size_t cap, int level) {
    int r = level ? LZ4_compress_HC((const char *)s, (char *)o, (int)n, (int)cap, level)
                  : LZ4_compress_default((const char *)s, (char *)o, (int)n, (int)cap);
    if (r <= 0) die("lz4 compress");
    static uint8_t chk[16384];
    if (LZ4_decompress_safe((const char *)o, (char *)chk, r, sizeof chk) != (int)n || memcmp(chk, s, n))
        die("lz4 round trip");
    return (size_t)r;
}

static void dump_frame(type_t *t, const fr_t *f) {
    if (!t->dump || t->dumped >= 64) return;
    static uint8_t b[4][4096];
    size_t l[4];
    memcpy(b[0], f->d, f->len); l[0] = f->len;
    l[1] = rle(f->d, f->len, b[1]);
    l[2] = lz4(f->d, f->len, b[2], 4096, 0);
    l[3] = lz4(f->d, f->len, b[3], 4096, 9);
    for (int i = 0; i < 4; i++) { fputc((int)(l[i] >> 8), t->dump); fputc((int)(l[i] & 255), t->dump); }
    for (int i = 0; i < 4; i++) {
        fwrite(b[i], 1, l[i], t->dump);
        if (l[i] & 1) fputc(0, t->dump);
    }
    t->dumped++;
}

static void close_batch(type_t *t) {
    batch_t *b = &t->open;
    if (b->n == 0) return;
    static uint8_t out[32768], cat[32768];
    size_t w[NC], off = 0;
    for (int c = 0; c < NC; c++) w[c] = 4;
    for (unsigned i = 0; i < b->n; i++) { memcpy(cat + off, b->f[i].d, b->f[i].len); off += b->f[i].len; }
    double t0;
    for (unsigned i = 0; i < b->n; i++) {
        const fr_t *f = &b->f[i];
        w[C_RAW] += 8 + even(f->len);
        /* sizes from the checked calls; times from a second, unchecked call */
        size_t r = rle(f->d, f->len, out);
        t0 = now_ns(); pnet_rle_encode(f->d, f->len, out); enc_ns[C_RLE] += now_ns() - t0;
        w[C_RLE] += 8 + r;
        size_t l = lz4(f->d, f->len, out, sizeof out, 0);
        t0 = now_ns(); LZ4_compress_default((const char *)f->d, (char *)out, f->len, sizeof out);
        enc_ns[C_LZ4] += now_ns() - t0;
        w[C_LZ4] += 8 + even(l);
        size_t h9 = lz4(f->d, f->len, out, sizeof out, 9);
        t0 = now_ns(); LZ4_compress_HC((const char *)f->d, (char *)out, f->len, sizeof out, 9);
        enc_ns[C_HC9] += now_ns() - t0;
        w[C_HC9] += 8 + even(h9);
        size_t h12 = lz4(f->d, f->len, out, sizeof out, 12);
        t0 = now_ns(); LZ4_compress_HC((const char *)f->d, (char *)out, f->len, sizeof out, 12);
        enc_ns[C_HC12] += now_ns() - t0;
        w[C_HC12] += 8 + even(h12);
        w[C_BEST] += 8 + even(l < r ? l : r);
        {   /* our 68000-shaped prototype; its table is never cleared, as on the Amiga */
            static uint16_t tab[LZ4P_HASH];
            static uint8_t al[MTU + 2];                 /* lz4p wants src at an even address */
            memcpy(al, f->d, f->len);
            t0 = now_ns();
            size_t p = lz4p_encode(al, f->len, out, r, tab);
            enc_ns[C_LZ4P] += now_ns() - t0;
            if (p) {
                static uint8_t chk[MTU];
                if (LZ4_decompress_safe((const char *)out, (char *)chk, (int)p, sizeof chk) != f->len ||
                    memcmp(chk, f->d, f->len)) die("lz4p round trip");
            }
            w[C_LZ4P] += 8 + even(p && p < r ? p : r);
        }
        dump_frame(t, f);
        enc_raw += f->len;
    }
    /* linked: each frame compressed with the batch's earlier frames as its dictionary */
    for (int hc = 0; hc < 2; hc++) {
        LZ4_streamHC_t *sh = LZ4_createStreamHC();
        LZ4_stream_t *sf = LZ4_createStream();
        LZ4_resetStreamHC_fast(sh, 9);
        static uint8_t dec[32768];
        size_t pos = 0;
        t0 = now_ns();
        for (unsigned i = 0; i < b->n; i++) {
            const char *in = (const char *)cat + pos;
            int r = hc ? LZ4_compress_HC_continue(sh, in, (char *)out, b->f[i].len, sizeof out)
                       : LZ4_compress_fast_continue(sf, in, (char *)out, b->f[i].len, sizeof out, 1);
            if (r <= 0) die("linked compress");
            double t1 = now_ns();
            if (LZ4_decompress_safe_usingDict((const char *)out, (char *)dec + pos, r, b->f[i].len,
                                              (const char *)dec, (int)pos) != b->f[i].len ||
                memcmp(dec + pos, cat + pos, b->f[i].len)) die("linked round trip");
            size_t rr = rle(b->f[i].d, b->f[i].len, out);
            w[hc ? C_LINK9 : C_LINKF] += 8 + even((size_t)r < rr ? (size_t)r : rr);
            pos += b->f[i].len;
            t0 += now_ns() - t1;                      /* the checks are not encode time */
        }
        enc_ns[hc ? C_LINK9 : C_LINKF] += now_ns() - t0;
        LZ4_freeStreamHC(sh);
        LZ4_freeStream(sf);
    }
    const size_t bl = lz4(cat, off, out, sizeof out, 9);
    w[C_BATCH9] = 4 + 2 * b->n + 8 + even(bl);
    if (t->bdump && t->bdumped < 8) {
        const uint8_t hd[4] = { (uint8_t)(off >> 8), (uint8_t)off, (uint8_t)(bl >> 8), (uint8_t)bl };
        fwrite(hd, 1, 4, t->bdump);
        fwrite(cat, 1, off, t->bdump);
        if (off & 1) fputc(0, t->bdump);
        fwrite(out, 1, bl, t->bdump);
        if (bl & 1) fputc(0, t->bdump);
        t->bdumped++;
    }
    if (t->nb == t->capb) {
        t->capb = t->capb ? 2 * t->capb : 256;
        for (int c = 0; c < NC; c++) t->ratio[c] = realloc(t->ratio[c], t->capb * sizeof(double));
    }
    for (int c = 0; c < NC; c++) { t->ratio[c][t->nb] = (double)w[c] / off; t->wire[c] += w[c]; }
    t->raw += off;
    t->frames += b->n;
    t->nb++;
    for (unsigned i = 0; i < b->n; i++) free(b->f[i].d);
    b->n = 0; b->used = 0;
}

/* Does one more frame of `len` fit, and is the batch full after it? */
static int fits(type_t *t, uint16_t len) {
    batch_t *b = &t->open;
    if (b->n >= MAXF) return 0;
    if (t->dir == 0) return b->used + 8 + pnet_rle_bound(len) + 4 <= 16128;
    long space = 8192 - 8 - (20 + (long)b->used) - 14;
    return len <= space;
}

static void add(type_t *t, uint8_t *d, uint16_t len, int flush) {
    if (!fits(t, len)) close_batch(t);
    batch_t *b = &t->open;
    b->f[b->n].d = d; b->f[b->n].len = len; b->n++;
    if (t->dir == 0) b->used += 8 + pnet_rle_bound(len);
    else {
        uint8_t tmp[2048];
        b->used += 8 + rle(d, len, tmp);
        long space = 8192 - 8 - (20 + (long)b->used) - 14;
        if (space < MTU) flush = 1;
    }
    if (flush || b->n >= MAXF) close_batch(t);
}

static int cmpd(const void *a, const void *b) {
    double x = *(const double *)a, y = *(const double *)b;
    return x < y ? -1 : x > y;
}

static double pct(double *v, size_t n, double p) {
    qsort(v, n, sizeof *v, cmpd);
    size_t i = (size_t)(p * (n - 1) + 0.5);
    return v[i];
}

int main(int argc, char **argv) {
    if (argc < 2) die("usage: lz4measure corpus.bin [dump-dir]");
    FILE *f = fopen(argv[1], "rb");
    if (!f) die("cannot open corpus");
    char mg[5] = {0};
    if (fread(mg, 1, 4, f) != 4 || strcmp(mg, "LZ4C")) die("not a corpus");
    unsigned ntypes = (unsigned)fgetc(f);
    if (ntypes > MAXT) die("too many types");
    for (unsigned i = 0; i < ntypes; i++) {
        int l = fgetc(f);
        if (l < 0 || fread(T[i].name, 1, (size_t)l, f) != (size_t)l) die("short names");
        T[i].dir = -1;
    }
    nt = ntypes;
    uint8_t h[5];
    while (fread(h, 1, 5, f) == 5) {
        unsigned ty = h[0], dir = h[1], fl = h[2], len = (h[3] << 8) | h[4];
        if (ty >= nt || len == 0 || len > MTU) die("bad frame");
        uint8_t *d = malloc(len);
        if (fread(d, 1, len, f) != len) die("short frame");
        type_t *t = &T[ty];
        if (t->dir < 0) {
            t->dir = (int)dir;
            if (argc > 2) {
                char p[512];
                snprintf(p, sizeof p, "%s/%s.frames", argv[2], t->name);
                t->dump = fopen(p, "wb");
                snprintf(p, sizeof p, "%s/%s.batches", argv[2], t->name);
                t->bdump = fopen(p, "wb");
            }
        }
        add(t, d, (uint16_t)len, fl);
    }
    fclose(f);
    for (unsigned i = 0; i < nt; i++) { close_batch(&T[i]); if (T[i].dump) fclose(T[i].dump); if (T[i].bdump) fclose(T[i].bdump); }

    printf("lz4measure (liblz4 %s): wire bytes as %% of the frames' bytes, all batches of a type summed\n",
           LZ4_versionString());
    printf("%-14s %-3s %5s %6s %7s |", "type", "dir", "batch", "fr/b", "raw KB");
    for (int c = 0; c < NC; c++) printf(" %6s", cname[c]);
    printf("\n");
    for (unsigned i = 0; i < nt; i++) {
        type_t *t = &T[i];
        printf("%-14s %-3s %5zu %6.1f %7.1f |", t->name, t->dir ? "up" : "dn", t->nb,
               (double)t->frames / t->nb, t->raw / 1024.0);
        for (int c = 0; c < NC; c++) printf(" %5.1f%%", 100.0 * t->wire[c] / t->raw);
        printf("\n");
    }
    printf("\nper batch, wire/frames %%: median [p10..p90]\n");
    printf("%-14s %-20s %-20s %-20s %-20s %-20s\n", "type", "rle", "lz4", "lz4p", "linkf", "link9");
    const int show[] = { C_RLE, C_LZ4, C_LZ4P, C_LINKF, C_LINK9 };
    for (unsigned i = 0; i < nt; i++) {
        type_t *t = &T[i];
        printf("%-14s", t->name);
        for (int k = 0; k < 5; k++) {
            int c = show[k];
            char s[32];
            snprintf(s, sizeof s, "%.1f [%.1f..%.1f]", 100 * pct(t->ratio[c], t->nb, 0.5),
                     100 * pct(t->ratio[c], t->nb, 0.1), 100 * pct(t->ratio[c], t->nb, 0.9));
            printf(" %-20s", s);
        }
        printf("\n");
    }
    printf("\nhost encode time (this Mac, one core, one call per frame, round-trip checks not counted):\n");
    for (int c = C_RLE; c <= C_LINK9; c++) if (c != C_BEST)
        printf("  %-5s %8.1f ns per KB of frames (%.1f MB/s)\n", cname[c], enc_ns[c] / (enc_raw / 1024.0),
               (enc_raw / 1e6) / (enc_ns[c] / 1e9));
    return 0;
}
