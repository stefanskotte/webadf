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
 * never cared; 1-cell intervals do. The batch opens with 00 01 00 01 -- two pulses exactly 16
 * cells apart -- which gives the missing low time: pw = 16 x 2000 ns - measured. Every later
 * interval is rounded to cells AFTER adding it back. Both ends are crystal clocks, so the nominal
 * 2000 ns cell is used as is. Word 0 is arm-to-first-edge, not an interval (lead_ns).
 *
 * THE HUNT (bench fix 1, 2026-10-10). On the A500 the write does NOT start at the sync: a run of
 * 2-cell pulses comes first (measured ~3480-3626 ns with pw ~520), and the capture arms at WGATE,
 * i.e. somewhere in that run. NetLoop's buffer (pnet_build_to_board) starts at 00 01, so the run is
 * added below it (trackdisk.device or Paula; its length is not measured -- hunt_n logs it). So
 * before the sync each interval is classed:
 *   2 cells (PNET_RX_LEAD_*)          lead-in: keep hunting
 *   17 cells (PNET_RX_GAP17_*)        an AA lead's last pulse to the sync's first: keep hunting
 *   16 cells (PNET_RX_SYNC_*)         the sync: sets pw and bit 0. A SECOND 16 straight after it
 *                                     replaces it (a 55 lead's last pulse is 16 cells from the
 *                                     sync's first); data cannot open with one, as the DataHeader
 *                                     opens 0x54, a 2-cell interval.
 *   anything else                     refused for good (hunt_failed): a capture armed in the data
 *                                     meets a 1/3/4-cell interval or a long gap, never decodes.
 * At most PNET_RX_HUNT_MAX intervals are hunted. sync_ns is the interval that ended the hunt,
 * taken or refused. A capture armed in the data that happens to hunt into a 16-cell gap decodes
 * misaligned; the DataHeader's magic and checksum refuse it (pnet_parse_hdr_from_amiga).
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
/* The other classes the hunt knows, over the same pw range: disjoint from the sync window and
 * from 1 cell (<= 1850) and 3 cells (>= 4300). */
#define PNET_RX_LEAD_MIN_NS  (2u * PNET_CELL_NS - PNET_RX_PW_MAX_NS)                /* 2300 */
#define PNET_RX_LEAD_MAX_NS  (2u * PNET_CELL_NS - PNET_RX_PW_MIN_NS)                /* 3850 */
#define PNET_RX_GAP17_MIN_NS ((PNET_SYNC_CELLS + 1u) * PNET_CELL_NS - PNET_RX_PW_MAX_NS) /* 32300 */
#define PNET_RX_GAP17_MAX_NS ((PNET_SYNC_CELLS + 1u) * PNET_CELL_NS - PNET_RX_PW_MIN_NS) /* 33850 */
/* 8192 intervals = 2,048 bytes of AA, ~33 ms: well past any lead a write could carry (the source of
 * the bench's lead is unmeasured, so this is generous), yet a stuck 2-cell pattern ends. */
#define PNET_RX_HUNT_MAX     8192u
#define PNET_RX_MAX_CELLS    64u      /* past any gap a legal batch holds: counted, then clamped */

typedef struct {
    uint8_t *buf;
    size_t   cap_bits;
    size_t   bit;           /* the next bit to write */
    size_t   cleared;       /* buf[0..cleared) is zeroed: cleared lazily, as bits land */
    uint32_t words;         /* PIO words fed, the lead included */
    uint32_t lead_ns;       /* word 0, arm to first edge: not an interval */
    uint32_t sync_ns;       /* the interval that ended the hunt: the sync, or the refused one */
    int32_t  pw_ns;         /* 16 cells minus sync_ns (set only when the sync is taken) */
    uint32_t hunt_n;        /* intervals hunted through before the sync (or the refusal) */
    bool     sync_ok;       /* a 16-cell sync was found; nothing is decoded otherwise */
    bool     hunt_failed;   /* refused before any sync: armed in the data, or the hunt ran out */
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
