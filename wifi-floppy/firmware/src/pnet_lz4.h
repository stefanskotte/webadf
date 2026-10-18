#ifndef PNET_LZ4_H
#define PNET_LZ4_H
/*
 * PaulaNET LZ4 (spec docs/superpowers/specs/2026-10-18-paulanet-lz4-design.md): the LZ4 block codec the board uses in
 * both directions. Ours (MIT), written from the LZ4 block format description. The encoder is the algorithm of
 * m68k/lz4/lz4_68k.c (lz4_encode_linked_ref): the same bytes and table updates from the same arguments
 * (test/test_pnet_lz4.c), so the driver's 68000 encoder and the board's encode alike. Standard LZ4 block (liblz4
 * LZ4_compress_default compatible, little-endian offsets), no frame header, no checksum: the batch checksum covers it.
 *
 * LINKED: a frame's matches may reach back into the earlier frames of the same batch, which sit directly before it in
 * one buffer, `window` being that buffer's start. Never across batches.
 *
 * Pure C, byte access only: tools/paulanet-driver/test.sh also builds it for the 68000.
 */
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include "pnet_frame.h"

#define PNET_LZ4_WINDOW        16128u  /* one batch's frames decoded back to back, either direction (spec §4-§5) */
#define PNET_LZ4_TABLE_ENTRIES 4096u   /* the board's hash table: 8 KB, in PSRAM (spec §5) */
#define PNET_LZ4_BLOCK_MAX     1540u   /* the longest block taken for one frame: >= 1518 + 1518/255 + 16 */

/* The block for src[0..n), its matches reaching back to `window` (window <= src; window == src for a frame alone).
 * The table holds `entries` 16-bit entries (a power of two, 256..16384); it needs no clearing and any contents are
 * valid -- clear it for bytes that do not depend on what came before. Returns the block's size (1..cap), or 0 if the
 * block would be longer than cap, or n > 65535, or window > src, or (src - window) + n > 65536. Nothing is written at
 * or past dst + cap. */
size_t pnet_lz4_encode_linked(const uint8_t *src, size_t n, uint8_t *dst, size_t cap, uint16_t *table,
                              unsigned entries, const uint8_t *window);
/* Decodes the block src[0..n) to dst. Returns the decoded length, or -1: malformed, a match from before `window` or at
 * offset 0, or output past dst_end. Never writes outside [dst, dst_end), never reads outside [src, src + n), never
 * reads a match from outside [window, the output so far). src must not overlap [window, dst_end). The 1-byte block
 * 0x00 decodes to 0 bytes; an empty block is malformed. */
long pnet_lz4_decode(const uint8_t *src, size_t n, uint8_t *dst, uint8_t *dst_end, const uint8_t *window);
/* The window of one batch, either direction: every frame is decoded into win + pos, back to back, whatever its
 * encoding, so the LZ4 frames may link to the earlier ones. pos past PNET_LZ4_WINDOW (PNET_LZ4_BROKEN) once a frame did
 * not fit: no later LZ4 frame of the batch can be decoded. scratch: PNET_LZ4_BLOCK_MAX bytes, an MFM-wrapped block. */
typedef struct { uint8_t *win; size_t pos; uint8_t *scratch; } pnet_lz4_win_t;
#define PNET_LZ4_BROKEN SIZE_MAX
/* As pnet_frame_iter_next, linked through w: the frame is decoded into the window and copied to out[0..cap). An LZ4
 * frame (size bit 14) decodes against the window -- raw or MFM-wrapped toward the board, MFM-wrapped only toward the
 * Amiga; *was_lz4 says its size word marked it LZ4, on an error too (the caller counts that as LZ4 damage).
 * PNET_E_LZ4: an LZ4 frame that does not decode to its original size, is over PNET_LZ4_BLOCK_MAX, or does not fit the
 * window. Any error leaves it->i where it was. */
pnet_err_t pnet_lz4_iter_next(pnet_frame_iter_t *it, pnet_lz4_win_t *w, uint8_t *out, size_t cap, uint16_t *len,
                              bool *was_lz4);
#endif
