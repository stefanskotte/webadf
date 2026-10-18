#ifndef PNET_PACK_H
#define PNET_PACK_H
/*
 * PaulaNET LZ4, board -> Amiga (spec docs/superpowers/specs/2026-10-18-paulanet-lz4-design.md §2, §5): which waiting
 * frames make one batch toward the Amiga, how each goes, and the track. Ours.
 *
 * Without LZ4 (Rob's driver, or ours before its first batch) every frame goes MFM, 0x8000 | 2 len, and the batch is
 * 1.15.0's to the byte (test_pnet_pack.c). With it, a frame goes 0xC000 | lz4_len -- its block MFM-encoded -- when the
 * block is shorter than the frame, its matches linked to the batch's earlier frames laid back to back in m->win.
 *
 * A batch out re-packed under the same counter (the driver started or stopped asking for LZ4) keeps the same frames,
 * or fewer (pnet_link_shrink), but not necessarily the same bytes: "rebuilt unchanged" means unchanged frames then.
 *
 * Its own file, not pnet_frame.c: tools/netloop compiles pnet_frame.c twice into one 68k program (renamed copies),
 * and new names there would collide.
 */
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include "pnet_frame.h"
#include "pnet_lz4.h"

typedef struct {
    const uint8_t *data;     /* the frame */
    uint16_t       len;
    const uint8_t *lz4;      /* its LZ4 block, or NULL: the frame goes MFM */
    uint16_t       lz4_len;
} pnet_out_t;

typedef struct {
    uint8_t  *win;           /* PNET_LZ4_WINDOW bytes: the batch's frames back to back (the blocks' window) */
    uint8_t  *blk;           /* PNET_LZ4_WINDOW bytes: the blocks back to back */
    uint16_t *table;         /* entries x 16 bits, cleared at every LZ4 pack with frames: a rebuild is byte-identical */
    unsigned  entries;
} pnet_pack_mem_t;

typedef struct {
    pnet_out_t f[PNET_MAX_FRAMES];
    unsigned   n;            /* frames in the batch */
    unsigned   lz4;          /* ...of them sent LZ4 */
    uint32_t   wire;         /* the payload's bytes on the wire: pnet_out_payload_bytes(f, n) */
    uint32_t   saved;        /* bytes LZ4 saved on the wire against MFM: the sum of 2 x (len - lz4_len) */
} pnet_pack_t;

/* Packs the first of `avail` frames (in[]) into one batch: at most PNET_MAX_FRAMES, their bytes within
 * PNET_LZ4_WINDOW, the payload within PNET_TO_AMIGA_MAX_PAYLOAD and the track within `cap` (counted as
 * pnet_to_amiga_bound counts it) -- by the frames' real encoded sizes. With lz4, each frame is copied into m->win and
 * goes LZ4 when its block is shorter than the frame (cap len - 1); without, m is not touched and f[].data points into
 * in[]. Returns pk->n. */
unsigned pnet_pack(pnet_pack_t *pk, const pnet_pack_mem_t *m, bool lz4, const pnet_frame_ref_t *in, unsigned avail,
                   size_t cap);
/* The payload's bytes for these frames (0 for none). */
size_t pnet_out_payload_bytes(const pnet_out_t *f, unsigned n);
/* As pnet_build_to_amiga, from packed frames: the bytes written, or 0 when cap might not hold them, n is over
 * PNET_MAX_FRAMES, or a frame is empty, over PNET_ETH_MTU, or its block over 0x3FFF bytes. */
size_t pnet_build_to_amiga_out(uint8_t *out, size_t cap, uint8_t amiga_ctr, uint8_t pico_ctr, uint8_t flags,
                               const pnet_out_t *f, unsigned n);
#endif
