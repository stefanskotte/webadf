/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
/* Lookup tables for pnet_asm.S, computed by the C compiler from the protocol's description;
 * none of RobSmithDev's code is in this program. The equivalence test checks every entry
 * against pnet_mfm.c (all 256 bytes x both carries) and every sync bit offset. */
#include "pnet_asm.h"

/* Entry 2 * b + p: byte b as one MFM word (pnet_mfm.h), when the previous word's bit 0 is p. */
#define D(b)    ((((b) & 0xAAu) << 7) | ((b) & 0x55u))
#define NB(i)   (((D((i) >> 1) << 1) | (D((i) >> 1) >> 1) | (((i) & 1u) << 15)) & 0xFFFFu)
#define W(i)    (uint16_t)((D((i) >> 1) | (~NB(i) & 0xAAAAu)) & 0xFFFFu)
#define W2(i)   W(i), W((i) + 1)
#define W4(i)   W2(i), W2((i) + 2)
#define W8(i)   W4(i), W4((i) + 4)
#define W16(i)  W8(i), W8((i) + 8)
#define W32(i)  W16(i), W16((i) + 16)
#define W64(i)  W32(i), W32((i) + 32)
#define W128(i) W64(i), W64((i) + 64)
#define W256(i) W128(i), W128((i) + 128)
const uint16_t pnet_mfm_tab[512] __attribute__((aligned(4))) = { W256(0), W256(256) };

/* The sync 44 89 44 89 starting s bits before a byte boundary (s = 0..7) makes the first whole
 * byte inside it bits s..s+7 of 0x44894489. Bit s of entry v says v is that byte. */
const uint8_t pnet_sync_tab[256] = {
    [0x44] = 0x81,   /* s = 0 and s = 7 */
    [0x89] = 0x02, [0x12] = 0x04, [0x24] = 0x08,
    [0x48] = 0x10, [0x91] = 0x20, [0x22] = 0x40,
};
