/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
#ifndef NETLOOP_BENCH_H
#define NETLOOP_BENCH_H
/*
 * The codec's hot stages, one call at a time, C reference or asm, over a prepared input. NetLoop
 * BENCH times them with the E-clock on the A500; test_netloop_asm's CYCLES mode runs one stage
 * under vamos, whose cycle count (68000 timings, no wait states) cycles.sh reads.
 */
#include <stdint.h>
#include <stddef.h>
#include "pnet_frame.h"

#define NL_BENCH_STAGES  10u
#define NL_BENCH_INPUTS  3u     /* random, a mixed packet, all zero */
#define NL_BENCH_SCAN    512u   /* NetLoop's SYNC_SCAN */
#define NL_BENCH_PRE     300u   /* bytes of the read before the echo's lead-in */
#define NL_BENCH_TRACK   16896u /* wbuf / track / aligned: NetLoop's CHIP_BYTES */

typedef struct {
    /* The caller's buffers. n is at most 12,000. */
    uint8_t *payload;           /* n */
    uint8_t *mfm_in;            /* 2n: payload as MFM, for MFM decode */
    uint8_t *rle_in;            /* n + n/127 + 8: payload as RLE, for RLE decode */
    uint8_t *scratch;           /* 2n + 64: the encoders' output */
    uint8_t *out;               /* n + 64: the decoders' output; equals payload after prep */
    uint8_t *wbuf;              /* NL_BENCH_TRACK: build's output, and align's in-place shift */
    uint8_t *track;             /* NL_BENCH_TRACK: the echo as read, NL_BENCH_PRE + 5 bits in */
    uint8_t *aligned;           /* NL_BENCH_TRACK: the echo aligned to just past the sync */
    /* Filled by nl_bench_prep. */
    uint32_t n;
    size_t   rle_len, track_len, aligned_len;
    long     sync_off;
    pnet_frame_ref_t refs[PNET_MAX_FRAMES];
    unsigned nf;
} nl_bench_t;

extern const char *const nl_bench_stage_name[NL_BENCH_STAGES];
extern const char *const nl_bench_input_name[NL_BENCH_INPUTS];

/* The payload for input `kind`, n bytes. */
void nl_bench_fill(unsigned kind, uint8_t *p, uint32_t n);
/* Builds every stage's input (with the C reference). 0 when something did not fit or parse. */
int  nl_bench_prep(nl_bench_t *b, unsigned kind, uint32_t n);
/* One call of `stage`, impl 0 = C, 1 = asm. Returns a value the caller can ignore. */
long nl_bench_stage(nl_bench_t *b, unsigned stage, unsigned impl);
#endif
