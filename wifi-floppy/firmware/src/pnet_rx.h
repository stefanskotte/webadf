/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
#ifndef PNET_RX_H
#define PNET_RX_H
/*
 * Flux intervals -> PaulaNET's raw bitstream: what the Amiga wrote to DF1 cylinder 77, side 0.
 *
 * Implemented from the protocol's description; no code of his.
 *
 * flux_bits.c (DF0's writes) knows only MFM: 2, 3 or 4 cells per interval. A PaulaNET write is
 * RLE bytes sent as raw cells, so an interval is any whole number of 2 us cells -- 1 for two
 * adjacent 1 bits, 20+ across a zero byte. This is the second classifier the research doc calls
 * for (§3.4), pure and host-tested like flux_bits.c.
 *
 * WHAT flux_in MEASURES. Not edge to edge: it counts while WDATA is high and reports at the next
 * falling edge, so every interval comes back short by the pulse's low time. MFM's wide classes
 * never cared; 1-cell intervals do. The write opens with 00 01 00 01 -- two pulses exactly 16
 * cells apart -- so the second word (the first is arm-to-first-edge, not an interval) gives the
 * missing low time: pw = 16 x 2000 ns - measured. Every later interval is rounded to cells AFTER
 * adding it back. Both ends are crystal clocks, so the nominal 2000 ns cell is used as is.
 *
 * Output: bit 0 is the first cell after the second sync pulse, so byte 0 is the DataHeader's
 * first byte. An interval of k cells appends k - 1 zeros and then a 1.
 */
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#define PNET_CELL_NS         2000u
#define PNET_SYNC_CELLS      16u
#define PNET_RX_PW_MIN_NS    150u     /* the pulse low times a real write can have */
#define PNET_RX_PW_MAX_NS    1700u
/* The sync interval as flux_in reports it: 32 us less the pulse low time. Accepting only a
 * plausible pw keeps the window under one cell wide: for any pw in range a 15-cell gap measures
 * <= 30000 ns and a 17-cell gap >= 32300 ns, so a capture armed late (first sync pulse missed,
 * word 1 a data interval) is refused instead of decoded with a wrong pw. */
#define PNET_RX_SYNC_MIN_NS  (PNET_SYNC_CELLS * PNET_CELL_NS - PNET_RX_PW_MAX_NS)   /* 30300 */
#define PNET_RX_SYNC_MAX_NS  (PNET_SYNC_CELLS * PNET_CELL_NS - PNET_RX_PW_MIN_NS)   /* 31850 */
#define PNET_RX_MAX_CELLS    64u      /* past any gap a legal batch holds: counted, then clamped */

typedef struct {
    uint8_t *buf;
    size_t   cap_bits;
    size_t   bit;           /* the next bit to write */
    size_t   cleared;       /* buf[0..cleared) is zeroed: cleared lazily, as bits land */
    uint32_t words;         /* PIO words fed, the lead included */
    uint32_t lead_ns;       /* word 0, arm to first edge: not an interval */
    uint32_t sync_ns;       /* word 1, as measured */
    int32_t  pw_ns;         /* 16 cells minus sync_ns */
    bool     sync_ok;       /* word 1 was a 16-cell interval; nothing is decoded otherwise */
    bool     overflowed;
    uint32_t out_of_range;  /* intervals over PNET_RX_MAX_CELLS */
} pnet_rx_t;

/* O(1): `buf` is NOT touched here. pnet_rx_feed zeroes each byte just before its first bit lands,
 * so the first pnet_rx_bytes() bytes are always the capture's alone; nothing past them is defined.
 * (It runs in the WGATE ISR before the PIO is enabled: a 32 KB memset there cost the first edges.) */
void   pnet_rx_init(pnet_rx_t *r, uint8_t *buf, size_t cap_bytes);
/* One PIO word, converted to ns (flux_counter_to_ns). */
void   pnet_rx_feed(pnet_rx_t *r, uint32_t ns);
/* Bytes so far, a partial last byte included. */
size_t pnet_rx_bytes(const pnet_rx_t *r);
#endif
