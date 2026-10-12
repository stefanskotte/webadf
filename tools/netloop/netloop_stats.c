/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
/* NetLoop helpers -- see netloop_stats.h. */
#include "netloop_stats.h"
#include <stdio.h>
#include <stdlib.h>

void nl_split(uint32_t n, uint16_t *lens, unsigned *nframes) {
    unsigned k = 0;
    while (n > 0) {
        const uint32_t l = n > NL_FRAME_MAX ? NL_FRAME_MAX : n;
        lens[k++] = (uint16_t)l;
        n -= l;
    }
    *nframes = k;
}

void nl_fill(uint32_t seed, uint8_t *out, uint32_t n) {
    uint32_t x = seed ? seed : 0x9E3779B9u;
    for (uint32_t i = 0; i < n; i++) {
        x ^= x << 13; x ^= x >> 17; x ^= x << 5;
        out[i] = (uint8_t)x;
    }
}

bool nl_echo_answers(uint8_t hdr_amiga, uint8_t hdr_pico, uint8_t ctr, uint8_t last_pico) {
    return hdr_amiga == ctr && hdr_pico != last_pico;
}

uint8_t nl_start_ctr(bool have_board_hdr, uint8_t board_last_amiga) {
    return have_board_hdr ? board_last_amiga : 0xFFu;
}

static int cmp_u32(const void *a, const void *b) {
    const uint32_t x = *(const uint32_t *)a, y = *(const uint32_t *)b;
    return x < y ? -1 : x > y;
}

uint32_t nl_percentile(uint32_t *v, unsigned n, unsigned pct) {
    if (n == 0) return 0;
    qsort(v, n, sizeof *v, cmp_u32);
    unsigned rank = (unsigned)(((uint64_t)pct * n + 99u) / 100u);   /* ceil(pct% of n) */
    if (rank < 1) rank = 1;
    if (rank > n) rank = n;
    return v[rank - 1];
}

uint32_t nl_tenths(uint64_t num, uint64_t den) {
    if (den == 0) return 0;
    return (uint32_t)((num * 10u + den / 2u) / den);
}

unsigned long nl_driver_read_len(unsigned long data_size) {
    unsigned long n = ((data_size + 1u) & ~1ul) + 24u + 128u;
    if (n < 1024u) n = 1024u;
    if (n > 16640u) n = 16640u;
    return n;
}

unsigned nl_off_bin8(unsigned long ob) { return ob >= 128u ? NL_OFF_BINS - 1u : (unsigned)(ob >> 3); }
unsigned nl_off_bin32(unsigned long ob) { return ob >= 512u ? NL_OFF_BINS - 1u : (unsigned)(ob >> 5); }

unsigned nl_hist_row(char *out, unsigned cap, const char *label, const unsigned long *bins) {
    unsigned n = 0;
    if (cap < 2) return 0;
    for (; n < 4 && label[n] && n + 1 < cap; n++) out[n] = label[n];
    for (unsigned i = 0; i < NL_OFF_BINS; i++) {
        char t[16];
        const int w = snprintf(t, sizeof t, i + 1u < NL_OFF_BINS ? "%4lu" : " %4lu", bins[i]);
        if (w < 0 || n + (unsigned)w + 2u > cap) break;
        for (int j = 0; j < w; j++) out[n++] = t[j];
    }
    out[n++] = '\n';
    out[n] = 0;
    return n;
}

unsigned nl_hist_head(char *out, unsigned cap, unsigned step) {
    unsigned n = 0;
    if (cap < 2) return 0;
    const int w0 = snprintf(out, cap, "off ");
    n = w0 < 0 ? 0 : (unsigned)w0;
    for (unsigned i = 0; i + 1u < NL_OFF_BINS && n + 6u < cap; i++)
        n += (unsigned)snprintf(out + n, cap - n, "%4u", i * step);
    if (n + 8u < cap) n += (unsigned)snprintf(out + n, cap - n, " %3u+", 16u * step);
    out[n++] = '\n';
    out[n] = 0;
    return n;
}
