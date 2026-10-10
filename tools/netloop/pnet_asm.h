/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
#ifndef PNET_ASM_H
#define PNET_ASM_H
/*
 * NetLoop's hand-written 68000 codec (pnet_asm.S) and the C reference it must match.
 *
 * Implemented from the protocol's description; none of RobSmithDev's code is in this program.
 *
 * build.sh compiles the shared C codec three ways into one executable:
 *   pnet_mfm.c   with its five hot functions renamed X_c        (the C reference)
 *   pnet_frame.c with find_sync/shift_left renamed X_c          (frame code, codec = selected)
 *   pnet_frame.c again, every public name renamed X_allc         (an all-C pipeline, for BENCH)
 * pnet_asm.S defines X_asm, and the plain names pnet_X: the asm itself when NETLOOP_ASM is 1
 * (the default), else a jmp to X_c. pnet_mfm.c and pnet_frame.c are not edited; the board
 * builds them exactly as before.
 */
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include "pnet_frame.h"

/* The C reference (pnet_mfm.c, pnet_frame.c, renamed at compile time). */
size_t   pnet_mfm_encode_c(const uint8_t *src, size_t n, uint8_t *dst, uint16_t *last);
void     pnet_mfm_decode_c(const uint8_t *src, size_t n, uint8_t *dst);
uint16_t pnet_checksum_c(const uint8_t *p, size_t len);
size_t   pnet_rle_encode_c(const uint8_t *src, size_t n, uint8_t *dst);
long     pnet_rle_decode_c(const uint8_t *src, size_t n, uint8_t *dst, size_t cap);
long     pnet_find_sync_c(const uint8_t *b, size_t len, size_t scan);
size_t   pnet_shift_left_c(uint8_t *b, size_t len, size_t bits);

/* The 68000 versions: same contracts as the C (pnet_mfm.h, pnet_frame.h). */
size_t   pnet_mfm_encode_asm(const uint8_t *src, size_t n, uint8_t *dst, uint16_t *last);
void     pnet_mfm_decode_asm(const uint8_t *src, size_t n, uint8_t *dst);
uint16_t pnet_checksum_asm(const uint8_t *p, size_t len);
size_t   pnet_rle_encode_asm(const uint8_t *src, size_t n, uint8_t *dst);
long     pnet_rle_decode_asm(const uint8_t *src, size_t n, uint8_t *dst, size_t cap);
long     pnet_find_sync_asm(const uint8_t *b, size_t len, size_t scan);
size_t   pnet_shift_left_asm(uint8_t *b, size_t len, size_t bits);
/* 1 when a[0..n) == b[0..n), else 0 (NetLoop's payload compare; no C twin but memcmp). */
int      nl_memeq_asm(const void *a, const void *b, size_t n);

/* The all-C pipeline (second compile of pnet_frame.c, over the _c codec). */
size_t pnet_build_to_board_allc(uint8_t *out, size_t cap, uint8_t amiga_ctr, uint8_t pico_ctr,
                                const pnet_frame_ref_t *f, unsigned n);
size_t pnet_build_to_amiga_allc(uint8_t *out, size_t cap, uint8_t amiga_ctr, uint8_t pico_ctr,
                                uint8_t flags, const pnet_frame_ref_t *f, unsigned n);
pnet_err_t pnet_parse_hdr_to_amiga_allc(const uint8_t *b, size_t len, pnet_hdr_t *h, bool with_payload);
pnet_err_t pnet_parse_frames_allc(const uint8_t *p, size_t len, pnet_dir_t dir, uint8_t *out,
                                  size_t cap, uint16_t *lens, unsigned max, unsigned *n);

/* Tables the asm reads (pnet_asm_tables.c). */
extern const uint16_t pnet_mfm_tab[512];   /* [2 * byte + previous word's bit 0] -> MFM word */
extern const uint8_t  pnet_sync_tab[256];  /* bit s: the byte is 44894489's bits s..s+7 */
#endif
