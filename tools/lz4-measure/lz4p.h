/* lz4p: a prototype 68000-shaped LZ4 block compressor (lz4p.c is the model, m68k/lz4p.S the asm). */
#ifndef LZ4P_H
#define LZ4P_H
#include <stdint.h>
#include <stddef.h>
#ifndef LZ4P_HASH
#define LZ4P_HASH 1024u          /* table entries (a power of two); 2 bytes each */
#endif
/* src at an even address, n <= 65535; tab: LZ4P_HASH uint16_t, any contents. Returns the LZ4
 * block's size, or 0 if it would not fit in cap. */
size_t lz4p_encode(const uint8_t *src, size_t n, uint8_t *dst, size_t cap, uint16_t *tab);
#endif
