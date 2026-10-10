/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
#ifndef NETLOOP_EQUIV_H
#define NETLOOP_EQUIV_H
#include <stdint.h>
#include <stddef.h>
/*
 * The asm codec (pnet_asm.S) against the C reference, on whatever 68000 runs it: vamos in
 * build.sh (test_netloop_asm, the full run), the A500 in NetLoop SELFTEST (a short run).
 * Every routine must give the same return value and write the same bytes, and nothing past them
 * (each output sits between guard bytes that are compared too). Prints a line per routine.
 * `max_n` caps the lengths (the large-length cases need it >= 70000 and 640 KB of memory);
 * `scale` is the random case counts in 64ths of the full run (64; NetLoop SELFTEST uses 1, with
 * coarser exhaustive sweeps). Returns the number of failing cases.
 */
unsigned long nl_equiv_run(unsigned long max_n, unsigned long scale, unsigned long seed);
/* Every routine (asm and C) with its input ending exactly at `top`, the end of the emulated RAM,
 * so that reading one byte past the input faults (vamos stops with InvalidMemoryAccessError, and
 * no RESULT line is printed). `room` bytes below `top` are free to use. Returns the cases run. */
unsigned long nl_overread_run(uint8_t *top, size_t room, unsigned long seed);
/* Every asm routine once per alignment of its pointers (0..3), lengths around the unrolled
 * blocks, every shift 0..17. Small enough for vamos' memory trace (-t), in which build.sh looks
 * for a word or long access at an odd address: the 68000 faults on one, vamos does not. */
unsigned long nl_oddcheck_run(void);
#endif
