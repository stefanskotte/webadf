/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
#ifndef PNET_MFM_H
#define PNET_MFM_H
/*
 * PaulaNET's three byte-level codecs: per-byte MFM, the XOR checksum and the RLE.
 *
 * THIRD-PARTY-NOTICES.md has the notice. This file implements
 * the protocol from its description and contains none of his code. The GOLDEN vectors in
 * test/test_pnet_mfm.c are the output of his reference encoders.
 *
 * Pure C, no pico-sdk and no unaligned 16/32-bit access (a 68000 takes an address error on one):
 * the same file is compiled into the board (WF_PNET_LOOP builds), the host tests, and the Amiga
 * tool tools/netloop. Byte order is explicit: the wire carries 16-bit words, high byte first.
 */
#include <stdint.h>
#include <stddef.h>

/* One byte -> one 16-bit MFM word, written high byte first (2 bytes per input byte). The data
 * bits sit at the 0x5555 positions in PaulaNET's order b7 b5 b3 b1 b6 b4 b2 b0 (word bits 14 12
 * 10 8 6 4 2 0). A clock bit (0xAAAA positions) is 1 exactly when the data bits either side of it
 * are both 0; the clock before bit 14 looks at bit 0 of the previous word, *last (0 to start a
 * chunk). Returns the bytes written, 2 * n. */
size_t pnet_mfm_encode(const uint8_t *src, size_t n, uint8_t *dst, uint16_t *last);

/* The inverse: n output bytes from 2 * n input bytes. Clock bits are ignored. */
void pnet_mfm_decode(const uint8_t *src, size_t n, uint8_t *dst);

/* XOR of the big-endian 16-bit words of p[0..len). An odd last byte counts as a high half. */
uint16_t pnet_checksum(const uint8_t *p, size_t len);

/* PaulaNET RLE. Control byte, then data:
 *   bit 7 set:   the low 7 bits (1..127) count literal bytes that follow;
 *   bit 7 clear: the low 7 bits (3..127) count repeats of the one byte that follows.
 * Runs of 3 or more equal bytes become repeats; shorter runs join a literal block. The output is
 * padded to an even length with one 0x00 control byte, which the decoder skips. */
size_t pnet_rle_bound(size_t n);           /* worst-case encoded size of n bytes */
size_t pnet_rle_encode(const uint8_t *src, size_t n, uint8_t *dst);
/* Decoded length, or -1 if the input ends inside a block or the output would pass `cap`. */
long   pnet_rle_decode(const uint8_t *src, size_t n, uint8_t *dst, size_t cap);
#endif
