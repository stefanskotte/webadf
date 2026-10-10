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
 * THE HUNT (bench fixes 1 and 2, 2026-10-10). On the A500 the write does NOT start at the sync,
 * and the capture arms at WGATE, before it. NetLoop's buffer (pnet_build_to_board) starts at 00 01,
 * and KS 3.1 trackdisk's ETD_RAWWRITE adds no gap (ROM disassembly), so what comes first is Paula's:
 * a few pulses replayed from trackdisk's last write -- measured as ~5 pulses 2 cells apart ending
 * in a 4-cell gap (an AAA8-style word), ~42-46 us after the arm. So before the sync:
 *   shorter than the sync window      (1..15 cells) keep hunting
 *   the sync window                   (16 cells) the sync: sets pw and bit 0. A SECOND 16 straight
 *                                     after it replaces it (a 55 lead's last pulse is 16 cells
 *                                     from the sync's first); data cannot open with one, as the
 *                                     DataHeader opens 0x54, a 2-cell interval.
 *   up to the 17-cell window's max    keep hunting (an AA lead's last pulse to the sync's first)
 *   longer                            (18+ cells: a 0000 word, a dropout) refused for good
 *                                     (hunt_failed): sync_ok stays false, nothing decodes.
 * THE IMPLIED SYNC (bench fix 3). The to-board write has NO lead-in at all: KS 3.1 trackdisk adds no
 * gap and Paula starts NetLoop's buffer at 00 01 00 01, so sync pulse 1 is ~30 us after WGATE and
 * pulse 2 ~62 us. Most captures arm AFTER pulse 1, between the two. The evidence is the hunt, not a
 * latency figure (none is measured yet; the `lead` log line measures it): fix 1 refused with
 * `hunt 4 sync 7853` -- three 2-cell intervals and then a 4-cell one, which is the magic 0x54 0x50
 * read from the sync's closing pulse -- and fix 2 hunted every capture to its end, never meeting a
 * 16-cell interval. So the first edge is the sync's closing pulse, and the next intervals are the
 * magic's 2,2,2,4,2... So if
 * nothing is synced yet, the FIRST interval (word 1) is a 2-cell one (PNET_RX_TWO_*), and word 0
 * (arm -> first edge) is at least PNET_RX_IMPLIED_LEAD_NS, the first edge is taken as the sync's
 * closing pulse: sync_ok, implied, pw = 2 cells - word 1, bit 0 the cell after that edge (as for a
 * measured sync), and word 1 is decoded as the first data interval. An arm closer than that to
 * pulse 2 is not implied: it hunts like any other capture (and decodes nothing useful). A capture
 * armed in the data can be implied too, when it lands in a long enough gap before a 2-cell
 * interval: it decodes misaligned and the DataHeader's magic and checksum refuse it.
 *
 * At most PNET_RX_HUNT_MAX intervals are hunted. sync_ns is the interval that ended the hunt,
 * taken or refused. A capture armed in the data hunts too, and may take a 16-cell data gap as the
 * sync: it then decodes misaligned, and the DataHeader's magic and checksum refuse it
 * (pnet_parse_hdr_from_amiga) -- that check, not this one, is the false-sync guard.
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
/* Each edge moves up to +-140 ns, so an interval moves up to +-280 (bench fix 2, review M2/M3). */
#define PNET_RX_JITTER_NS    280u
/* The sync interval as flux_in reports it: 32 us less the pulse low time, +-jitter, for any
 * plausible pw. At the pw extremes it overlaps a 15-cell (<= 30130) or 17-cell (>= 32020) gap; that
 * is harmless, since a lead-in gap taken for the sync is replaced by the real sync straight after
 * it (pnet_rx.h, the hunt), and the real sync is never outside the window. */
#define PNET_RX_SYNC_MIN_NS  (PNET_SYNC_CELLS * PNET_CELL_NS - PNET_RX_PW_MAX_NS - PNET_RX_JITTER_NS) /* 30020 */
#define PNET_RX_SYNC_MAX_NS  (PNET_SYNC_CELLS * PNET_CELL_NS - PNET_RX_PW_MIN_NS + PNET_RX_JITTER_NS) /* 32130 */
/* Before the sync, anything up to the 17-cell interval's max (+jitter) is hunted; past it, refused. */
#define PNET_RX_GAP17_MAX_NS ((PNET_SYNC_CELLS + 1u) * PNET_CELL_NS - PNET_RX_PW_MIN_NS + PNET_RX_JITTER_NS) /* 34130 */
/* A 2-cell interval, any pw, +-jitter: the implied sync's first data interval (the magic's 0x54). */
#define PNET_RX_TWO_MIN_NS   (2u * PNET_CELL_NS - PNET_RX_PW_MAX_NS - PNET_RX_JITTER_NS)   /* 2020 */
#define PNET_RX_TWO_MAX_NS   (2u * PNET_CELL_NS - PNET_RX_PW_MIN_NS + PNET_RX_JITTER_NS)   /* 4130 */
/* Word 0 at or above this, with a 2-cell word 1, is an implied sync (above). Between the sync's
 * pulses word 0 is at most 16 cells less pw (~31.5 us): the to-board data's longest gap (59 cells in
 * an empty batch's header, ~35 in a framed header, ~30 in RLE) is longer, so no threshold can both
 * catch those arms and shut out every data arm -- the header check is the guard. 4 cells is the
 * longest gap of the MFM-coded parts and 1 in 16 of random raw bytes: below it an arm is about as
 * likely to be in the data as before pulse 2, and only an arm in the last 8 us before pulse 2 --
 * 54+ us of ISR latency -- is lost to it. Needs word 0 to be arm -> first edge: flux_capture.c resets
 * flux_in's X on a raw arm (it used to carry the last capture's count). */
#define PNET_RX_IMPLIED_LEAD_NS (4u * PNET_CELL_NS)                                       /* 8000 */
/* 8192 intervals = 2,048 bytes of AA, ~33 ms: far past the ~5-pulse lead the bench measured, yet a
 * stuck pattern ends. */
#define PNET_RX_HUNT_MAX     8192u
#define PNET_RX_MAX_CELLS    64u      /* past any gap a legal batch holds: counted, then clamped */

typedef struct {
    uint8_t *buf;
    size_t   cap_bits;
    size_t   bit;           /* the next bit to write */
    size_t   cleared;       /* buf[0..cleared) is zeroed: cleared lazily, as bits land */
    uint32_t words;         /* PIO words fed, the lead included */
    uint32_t lead_ns;       /* word 0, arm to first edge: not an interval */
    uint32_t sync_ns;       /* the interval that ended the hunt: the sync, the refused one, or for
                             * an implied sync word 1 (the first data interval) */
    int32_t  pw_ns;         /* set when the sync is taken: 16 cells minus sync_ns, or for an implied
                             * sync 2 cells minus it (word 1); -130..1980 either way */
    uint32_t hunt_n;        /* intervals hunted through before the sync (or the refusal) */
    bool     sync_ok;       /* synced -- by a measured 16-cell sync or by implication (`implied`);
                             * nothing is decoded otherwise */
    bool     implied;       /* the sync was implied: armed between the sync's two pulses */
    bool     hunt_failed;   /* refused before any sync: an 18+ cell gap, or the hunt ran out */
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
