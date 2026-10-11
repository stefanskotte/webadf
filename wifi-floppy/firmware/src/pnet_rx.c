/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
/* Implemented from the protocol's description; no code of his (see pnet_rx.h). */
#include "pnet_rx.h"
#include <string.h>

void pnet_rx_init(pnet_rx_t *r, uint8_t *buf, size_t cap_bytes) {
    memset(r, 0, sizeof *r);
    r->buf = buf;
    r->cap_bits = cap_bytes * 8u;
}

static bool in(uint32_t ns, uint32_t lo, uint32_t hi) { return ns >= lo && ns <= hi; }

static void cal_reset(pnet_rx_t *r) {
    r->cal_k = r->cal_sn = r->cal_snn = r->cal_st = r->cal_snt = r->cal_c16 = 0;
    r->cal_p16 = 0;
}

static void cal_add(pnet_rx_t *r, uint32_t n, uint32_t t) {
    if (r->cal_k >= PNET_RX_CAL_MAX || n > PNET_SYNC_CELLS) return;
    r->cal_k++;
    r->cal_sn += n;
    r->cal_snn += n * n;
    r->cal_st += t;
    r->cal_snt += n * t;
    r->cal_c16 = 0;                                   /* stale: refit on the next long gap */
}

/* The least-squares cell and low time, in 1/16 ns. False: too few or too alike samples, or a cell
 * no Amiga writes -- the nominal rounding is used. */
static bool cal_fit(pnet_rx_t *r) {
    if (r->cal_c16) return true;
    const int64_t k = r->cal_k, sn = r->cal_sn;
    const int64_t den = k * (int64_t)r->cal_snn - sn * sn;
    if (k < 2 || den <= 0) return false;
    const int64_t c16 = 16 * (k * (int64_t)r->cal_snt - sn * (int64_t)r->cal_st) / den;
    if (c16 < 16 * 1900 || c16 > 16 * 2100) return false;
    r->cal_c16 = (uint32_t)c16;
    r->cal_p16 = (int32_t)((c16 * sn - 16 * (int64_t)r->cal_st) / k);
    return true;
}

void pnet_rx_feed(pnet_rx_t *r, uint32_t ns) {
    const uint32_t w = r->words++;
    if (w == 0) { r->lead_ns = ns; return; }          // arm -> first edge: not an interval
    if (r->hunt_failed) return;
    const bool sync = in(ns, PNET_RX_SYNC_MIN_NS, PNET_RX_SYNC_MAX_NS);
    if (w == 1 && !r->prearmed && r->lead_ns >= PNET_RX_IMPLIED_LEAD_NS &&
        in(ns, PNET_RX_TWO_MIN_NS, PNET_RX_TWO_MAX_NS)) {
        /* The implied sync (pnet_rx.h): the first edge was the sync's closing pulse, and this
         * interval is the first data interval -- decoded below, as 2 cells. */
        r->sync_ok = r->implied = true;
        r->sync_ns = ns;
        r->pw_ns = (int32_t)(2u * PNET_CELL_NS) - (int32_t)ns;
    } else if (!r->sync_ok || (r->bit == 0u && sync)) {
        /* The hunt (pnet_rx.h). bit == 0 after the sync means nothing is decoded yet, so a second
         * 16-cell interval there replaces the first (data opens with a 2-cell interval). */
        r->sync_ns = ns;
        if (sync) {
            if (r->sync_ok) r->hunt_n++;                   // the first "sync" was the lead's last gap
            r->sync_ok = true;
            r->pw_ns = (int32_t)(PNET_SYNC_CELLS * PNET_CELL_NS) - (int32_t)ns;
            cal_reset(r);                                  // a replaced sync's sample goes with it
            cal_add(r, PNET_SYNC_CELLS, ns);
            return;
        }
        if (++r->hunt_n > PNET_RX_HUNT_MAX || ns > PNET_RX_GAP17_MAX_NS)
            r->hunt_failed = true;                         // refused for good; sync_ok stays false
        return;
    }
    if (r->overflowed) return;
    /* 32-bit per interval (no hardware 64-bit divide on the M33; only cal_fit divides 64-bit, and
     * only on a long gap): anything past the max-cells range is out_of_range anyway, so clamp first. */
    if (ns > (PNET_RX_MAX_CELLS + 2u) * PNET_CELL_NS) ns = (PNET_RX_MAX_CELLS + 2u) * PNET_CELL_NS;
    /* ns <= 132000 and pw_ns is -130..1980 (the sync window), so t is positive and fits. */
    const int32_t t = (int32_t)ns + r->pw_ns + (int32_t)(PNET_CELL_NS / 2u);
    uint32_t cells = t > 0 ? (uint32_t)t / PNET_CELL_NS : 0u;
    if (cells < 1u) cells = 1u;
    if (cells <= PNET_SYNC_CELLS) cal_add(r, cells, ns);
    else if (cells >= PNET_RX_CAL_CELLS && cal_fit(r))
        cells = (uint32_t)(((int32_t)ns * 16 + r->cal_p16 + (int32_t)(r->cal_c16 / 2u)) / (int32_t)r->cal_c16);
    if (cells > PNET_RX_MAX_CELLS) { r->out_of_range++; cells = PNET_RX_MAX_CELLS; }
    const size_t at = r->bit + (size_t)cells - 1u;   // the 1 after cells - 1 zeros
    if (at >= r->cap_bits) { r->overflowed = true; return; }
    while (r->cleared <= (at >> 3)) r->buf[r->cleared++] = 0;   // the lazy clear (pnet_rx.h)
    r->buf[at >> 3] |= (uint8_t)(0x80u >> (at & 7u));
    r->bit = at + 1u;
}

size_t pnet_rx_bytes(const pnet_rx_t *r) { return (r->bit + 7u) >> 3; }
