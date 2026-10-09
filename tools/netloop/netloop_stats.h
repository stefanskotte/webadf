#ifndef NETLOOP_STATS_H
#define NETLOOP_STATS_H
/*
 * NetLoop's pure helpers: the payload, the round's verdict and the arithmetic of its report.
 * Host-tested by test_netloop_stats.c (build.sh runs it before every Amiga build).
 * PaulaNET protocol (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET, used with
 * permission.
 */
#include <stdint.h>
#include <stdbool.h>

#define NL_FRAME_MAX 1500u   /* NetLoop's frames: an Ethernet payload's worth */

/* n bytes as frames of at most NL_FRAME_MAX, the last one shorter. n <= 20 * NL_FRAME_MAX. */
void nl_split(uint32_t n, uint16_t *lens, unsigned *nframes);
/* xorshift32 bytes from `seed` (0 is replaced: xorshift never leaves 0). */
void nl_fill(uint32_t seed, uint8_t *out, uint32_t n);
/* The echo answers round `ctr`: it acknowledges ctr, and it is a batch we have not had. */
bool nl_echo_answers(uint8_t hdr_amiga, uint8_t hdr_pico, uint8_t ctr, uint8_t last_pico);
/* The counter to continue from: the board's last-taken one when its header was read (so the next
 * batch is new to it, after a restart or Ctrl-A-A), else PaulaNET's initial 0xFF. */
uint8_t nl_start_ctr(bool have_board_hdr, uint8_t board_last_amiga);
/* Nearest-rank percentile; SORTS v. 0 for n == 0. */
uint32_t nl_percentile(uint32_t *v, unsigned n, unsigned pct);
/* round(10 * num / den): one decimal place without floating point. 0 when den == 0. */
uint32_t nl_tenths(uint64_t num, uint64_t den);
#endif
