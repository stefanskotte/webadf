/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
/* The codec's stages for NetLoop BENCH and the vamos cycle count (netloop_bench.h). Implemented
 * from the protocol's description; none of RobSmithDev's code is in this program. */
#include <string.h>
#include "pnet_mfm.h"
#include "pnet_frame.h"
#include "pnet_asm.h"
#include "netloop_stats.h"
#include "netloop_bench.h"

const char *const nl_bench_stage_name[NL_BENCH_STAGES] = {
    "rle enc", "mfm enc", "checksum", "build", "sync", "align", "mfm dec", "rle dec", "parse",
    "compare",
};
const char *const nl_bench_input_name[NL_BENCH_INPUTS] = { "random", "mixed", "zero" };

/* A typical frame: Ethernet/IP/TCP headers (zeros and a few fields), HTTP-ish text, a zero
 * stretch, then compressed-looking bytes. 1500 bytes, repeated. */
static const char text[] =
    "GET /files/workbench/disk.adf HTTP/1.1\r\nHost: webadf.local\r\nUser-Agent: AmigaOS/3.1 "
    "AmiTCP\r\nAccept: */*\r\nConnection: keep-alive\r\n\r\n    ";

void nl_bench_fill(unsigned kind, uint8_t *p, uint32_t n) {
    if (kind == 0) { nl_fill(12345u, p, n); return; }
    if (kind == 2) { memset(p, 0, n); return; }
    uint8_t rnd[640];
    nl_fill(777u, rnd, sizeof rnd);
    for (uint32_t i = 0; i < n; i++) {
        const uint32_t k = i % 1500u;
        uint8_t v;
        if (k < 54u)        v = (k % 7u == 0 || k % 11u == 3) ? (uint8_t)(k * 37u) : 0;
        else if (k < 700u)  v = (uint8_t)text[(k - 54u) % (sizeof text - 1u)];
        else if (k < 860u)  v = 0;
        else                v = rnd[k - 860u];
        p[i] = v;
    }
}

int nl_bench_prep(nl_bench_t *b, unsigned kind, uint32_t n) {
    uint16_t lens[PNET_MAX_FRAMES];
    b->n = n;
    nl_bench_fill(kind, b->payload, n);
    nl_split(n, lens, &b->nf);
    uint32_t off = 0;
    for (unsigned i = 0; i < b->nf; i++) {
        b->refs[i].data = b->payload + off; b->refs[i].len = lens[i]; off += lens[i];
    }
    uint16_t last = 0;
    pnet_mfm_encode_c(b->payload, n, b->mfm_in, &last);
    b->rle_len = pnet_rle_encode_c(b->payload, n, b->rle_in);
    memcpy(b->out, b->payload, n);
    /* The echo as a read sees it: some bytes of whatever, then the track, 5 bits late. */
    nl_fill(99u, b->track, NL_BENCH_PRE);
    const size_t t = pnet_build_to_amiga_allc(b->aligned, NL_BENCH_TRACK - NL_BENCH_PRE - 8u, 1, 2, 0,
                                              b->refs, b->nf);
    if (!t) return 0;
    uint8_t *d = b->track + NL_BENCH_PRE;
    d[0] = (uint8_t)(0xA8u | (b->aligned[0] >> 5));        /* 10101 then the track */
    for (size_t i = 1; i < t; i++) d[i] = (uint8_t)((b->aligned[i - 1] << 3) | (b->aligned[i] >> 5));
    d[t] = (uint8_t)(b->aligned[t - 1] << 3);
    b->track_len = NL_BENCH_PRE + t + 1u;
    b->sync_off = pnet_find_sync_c(b->track, b->track_len, NL_BENCH_SCAN);
    if (b->sync_off < 0) return 0;
    memcpy(b->aligned, b->track, b->track_len);
    b->aligned_len = pnet_shift_left_c(b->aligned, b->track_len, (size_t)b->sync_off);
    pnet_hdr_t h;
    return pnet_parse_hdr_to_amiga_allc(b->aligned, b->aligned_len, &h, true) == PNET_OK;
}

static long parse(nl_bench_t *b, unsigned impl) {
    pnet_hdr_t h;
    uint16_t el[PNET_MAX_FRAMES];
    unsigned en = 0;
    if (impl) {
        if (pnet_parse_hdr_to_amiga(b->aligned, b->aligned_len, &h, true) != PNET_OK) return -1;
        return pnet_parse_frames(b->aligned + PNET_HDR_MFM_BYTES, h.data_size, PNET_TO_AMIGA, b->out,
                                 b->n + 64u, el, PNET_MAX_FRAMES, &en);
    }
    if (pnet_parse_hdr_to_amiga_allc(b->aligned, b->aligned_len, &h, true) != PNET_OK) return -1;
    return pnet_parse_frames_allc(b->aligned + PNET_HDR_MFM_BYTES, h.data_size, PNET_TO_AMIGA, b->out,
                                  b->n + 64u, el, PNET_MAX_FRAMES, &en);
}

long nl_bench_stage(nl_bench_t *b, unsigned stage, unsigned impl) {
    uint16_t last = 0;
    switch (stage) {
    case 0: return (long)(impl ? pnet_rle_encode_asm : pnet_rle_encode_c)(b->payload, b->n, b->scratch);
    case 1: return (long)(impl ? pnet_mfm_encode_asm : pnet_mfm_encode_c)(b->payload, b->n, b->scratch, &last);
    case 2: return (impl ? pnet_checksum_asm : pnet_checksum_c)(b->payload, b->n);
    case 3: return (long)(impl ? pnet_build_to_board : pnet_build_to_board_allc)(b->wbuf, NL_BENCH_TRACK, 1, 2,
                                                                                  b->refs, b->nf);
    case 4: return (impl ? pnet_find_sync_asm : pnet_find_sync_c)(b->track, b->track_len, NL_BENCH_SCAN);
    /* align shifts wbuf, not the track: its cost does not depend on the bytes. */
    case 5: return (long)(impl ? pnet_shift_left_asm : pnet_shift_left_c)(b->wbuf, b->track_len,
                                                                          (size_t)b->sync_off);
    case 6: (impl ? pnet_mfm_decode_asm : pnet_mfm_decode_c)(b->mfm_in, b->n, b->out); return 0;
    case 7: return (impl ? pnet_rle_decode_asm : pnet_rle_decode_c)(b->rle_in, b->rle_len, b->out, b->n);
    case 8: return parse(b, impl);
    case 9: return impl ? nl_memeq_asm(b->payload, b->out, b->n) : memcmp(b->payload, b->out, b->n) == 0;
    default: return 0;
    }
}
