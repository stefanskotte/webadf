/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
/* Implemented from the protocol's description; no code of his (see pnet_mfm.h). */
#include "pnet_mfm.h"
#include <string.h>

size_t pnet_mfm_encode(const uint8_t *src, size_t n, uint8_t *dst, uint16_t *last) {
    uint16_t prev = *last;
    for (size_t i = 0; i < n; i++) {
        const uint8_t b = src[i];
        uint16_t w = (uint16_t)(((b & 0xAAu) << 7) | (b & 0x55u));
        // Every clock position whose two neighbouring data bits are both 0 gets a 1. The
        // neighbours of clock bit k are data bits k+1 and k-1; bit 15's lower neighbour is the
        // previous word's bit 0.
        const uint16_t nb = (uint16_t)((w << 1) | (w >> 1) | (prev << 15));
        w = (uint16_t)(w | (~nb & 0xAAAAu));
        dst[2 * i]     = (uint8_t)(w >> 8);
        dst[2 * i + 1] = (uint8_t)w;
        prev = w;
    }
    *last = prev;
    return 2 * n;
}

void pnet_mfm_decode(const uint8_t *src, size_t n, uint8_t *dst) {
    for (size_t i = 0; i < n; i++) {
        const uint16_t d = (uint16_t)(((src[2 * i] << 8) | src[2 * i + 1]) & 0x5555u);
        dst[i] = (uint8_t)((d >> 7) | d);
    }
}

uint16_t pnet_checksum(const uint8_t *p, size_t len) {
    uint16_t c = 0;
    for (size_t i = 0; i < len; i += 2)
        c ^= (uint16_t)((p[i] << 8) | (i + 1 < len ? p[i + 1] : 0));
    return c;
}

size_t pnet_rle_bound(size_t n) { return n + n / 127u + 2u; }

/* Equal bytes starting at i, at most 127. */
static size_t run_at(const uint8_t *s, size_t n, size_t i) {
    size_t r = 1;
    while (i + r < n && r < 127u && s[i + r] == s[i]) r++;
    return r;
}

size_t pnet_rle_encode(const uint8_t *src, size_t n, uint8_t *dst) {
    size_t i = 0, o = 0;
    while (i < n) {
        size_t r = run_at(src, n, i);
        if (r >= 3u) {
            dst[o++] = (uint8_t)r;
            dst[o++] = src[i];
            i += r;
            continue;
        }
        const size_t hdr = o++;
        size_t lit = 0;
        while (i < n && lit < 127u) {
            r = run_at(src, n, i);
            if (r >= 3u) break;                   // better as a repeat
            if (lit + r > 127u) r = 127u - lit;   // a pair split by the block limit
            memcpy(&dst[o], &src[i], r);
            o += r; i += r; lit += r;
        }
        dst[hdr] = (uint8_t)(0x80u | lit);
    }
    if (o & 1u) dst[o++] = 0;                     // even length: one no-op control byte
    return o;
}

long pnet_rle_decode(const uint8_t *src, size_t n, uint8_t *dst, size_t cap) {
    size_t i = 0, o = 0;
    while (i < n) {
        const uint8_t c = src[i++];
        const size_t k = c & 0x7Fu;
        if (k == 0) continue;                     // the even-length pad
        if (k > cap - o) return -1;
        if (c & 0x80u) {
            if (k > n - i) return -1;
            memcpy(&dst[o], &src[i], k);
            i += k;
        } else {
            if (i >= n) return -1;
            memset(&dst[o], src[i++], k);
        }
        o += k;
    }
    return (long)o;
}
