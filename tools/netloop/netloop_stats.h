/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
#ifndef NETLOOP_STATS_H
#define NETLOOP_STATS_H
/*
 * NetLoop's pure helpers: the payload, the round's verdict and the arithmetic of its report.
 * Host-tested by test_netloop_stats.c (build.sh runs it before every Amiga build).
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
/* PaulaNET's driver (Phase 2): it looks for the sync in about the first 128 bytes of a read, and its
 * payload read has 128 bytes of slack, so a sync STARTING by byte 124 is the one that always works. */
#define NL_DRIVER_SCAN 124u
/* The length of his driver's read for a payload of data_size bytes: the payload rounded up to even,
 * its 24-byte MFM header and 128 bytes of slack, at least 1,024 and at most 16,640. */
unsigned long nl_driver_read_len(unsigned long data_size);
/* The sync's byte offset histograms (the offset is the byte the sync ENDS at, as the 8-byte one has
 * always counted it; the sync starts 4 bytes earlier). 8-byte bins: 0..127, the last (16) is 128 and
 * up. 32-byte bins: 0..511, the last (16) is 512 and up. Both have NL_OFF_BINS bins. */
#define NL_OFF_BINS 17u
unsigned nl_off_bin8(unsigned long ob);
unsigned nl_off_bin32(unsigned long ob);
/* One histogram row: `label` (4 characters, e.g. "pay "), then the bins, each width 4 and the last
 * with a space before it: 4 + 16 * 4 + 5 = 73 columns, for the Shell window's ~78. Writes at most
 * cap bytes, ends with a newline, and returns the length. */
unsigned nl_hist_row(char *out, unsigned cap, const char *label, const unsigned long *bins);
/* The matching header: "off " then the bin starts, `step` apart (8 or 32); the last as "<16*step>+". */
unsigned nl_hist_head(char *out, unsigned cap, unsigned step);
#endif
