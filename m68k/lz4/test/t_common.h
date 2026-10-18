/*
 * t_common.h: helpers shared by the host test (host_test.c) and the 68000 test (vtest.c).
 * Copyright (c) 2026 Stefan Skotte and contributors. MIT licence (../LICENSE).
 *
 * ref_decode is our own plain C LZ4 block decoder with exactly the acceptance rules that
 * lz4_68k.h documents for lz4_decode; the tests use it as the oracle for malformed input.
 */
#ifndef T_COMMON_H
#define T_COMMON_H
#include <stdint.h>
#include <stddef.h>
#include <string.h>

static uint32_t rng_s = 1;
static uint32_t rnd(void) {                 /* xorshift32 */
    uint32_t x = rng_s;
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    return rng_s = x;
}

/* Test data of kind k into p[0..n): 0 random, 1 small alphabet, 2 text-like with repeats,
 * 3 runs, 4 zeros, 5 period-(1..20) pattern. */
static void gen(uint8_t *p, size_t n, unsigned k) {
    size_t i = 0;
    unsigned per = 1 + rnd() % 20;
    while (i < n) {
        switch (k) {
        case 0: p[i++] = (uint8_t)rnd(); break;
        case 1: p[i++] = (uint8_t)('a' + rnd() % 4); break;
        case 2:
            if (i > 8 && rnd() % 3 == 0) {          /* copy an earlier run */
                size_t off = 1 + rnd() % (i < 300 ? i : 300), len = 4 + rnd() % 24;
                while (len-- && i < n) { p[i] = p[i - off]; i++; }
            } else p[i++] = (uint8_t)(' ' + rnd() % 64);
            break;
        case 3: { uint8_t b = (uint8_t)rnd(); size_t len = 1 + rnd() % 40;
                  while (len-- && i < n) p[i++] = b; } break;
        case 4: p[i++] = 0; break;
        default: p[i] = (uint8_t)(i % per * 37 + 11); i++; break;
        }
    }
}
#define NGEN 6

/* The oracle. Returns the decoded length or -1; *off0 is set when a sequence had offset 0. */
static long ref_decode(const uint8_t *src, size_t len, uint8_t *dst, uint8_t *dst_end,
                       const uint8_t *window, int *off0) {
    const uint8_t *ip = src, *iend = src + len;
    uint8_t *op = dst;
    if (off0) *off0 = 0;
    for (;;) {
        if (ip >= iend) return -1;
        unsigned tok = *ip++;
        size_t l = tok >> 4;
        if (l == 15) {
            unsigned b;
            do { if (ip >= iend) return -1; b = *ip++; l += b; } while (b == 255);
        }
        if ((size_t)(iend - ip) < l || (size_t)(dst_end - op) < l) return -1;
        memcpy(op, ip, l); op += l; ip += l;
        if (ip == iend) return (long)(op - dst);
        if (iend - ip < 2) return -1;
        size_t off = ip[0] | (size_t)ip[1] << 8;
        ip += 2;
        if (off == 0) { if (off0) *off0 = 1; return -1; }
        if ((size_t)(op - window) < off) return -1;
        size_t m = (tok & 15) + 4;
        if (m == 19) {
            unsigned b;
            do { if (ip >= iend) return -1; b = *ip++; m += b; } while (b == 255);
        }
        if ((size_t)(dst_end - op) < m) return -1;
        const uint8_t *s = op - off;
        while (m--) *op++ = *s++;
    }
}

static inline unsigned get32(const uint8_t *p) {
    return (unsigned)p[0] << 24 | (unsigned)p[1] << 16 | (unsigned)p[2] << 8 | p[3];
}
static inline void put32(uint8_t *p, unsigned v) {
    p[0] = (uint8_t)(v >> 24); p[1] = (uint8_t)(v >> 16); p[2] = (uint8_t)(v >> 8); p[3] = (uint8_t)v;
}
#endif
