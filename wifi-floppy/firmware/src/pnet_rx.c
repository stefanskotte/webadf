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

void pnet_rx_feed(pnet_rx_t *r, uint32_t ns) {
    const uint32_t w = r->words++;
    if (w == 0) { r->lead_ns = ns; return; }          // arm -> first edge: not an interval
    if (r->hunt_failed) return;
    const bool sync = in(ns, PNET_RX_SYNC_MIN_NS, PNET_RX_SYNC_MAX_NS);
    /* The hunt (pnet_rx.h). bit == 0 after the sync means nothing is decoded yet, so a second
     * 16-cell interval there replaces the first (data opens with a 2-cell interval). */
    if (!r->sync_ok || (r->bit == 0u && sync)) {
        r->sync_ns = ns;
        if (sync) {
            if (r->sync_ok) r->hunt_n++;               // the first "sync" was the lead's last gap
            r->sync_ok = true;
            r->pw_ns = (int32_t)(PNET_SYNC_CELLS * PNET_CELL_NS) - (int32_t)ns;
            return;
        }
        if (++r->hunt_n > PNET_RX_HUNT_MAX || ns > PNET_RX_GAP17_MAX_NS)
            r->hunt_failed = true;                     // refused for good; sync_ok stays false
        return;
    }
    if (r->overflowed) return;
    /* 32-bit throughout (no software 64-bit divide on the M33): anything past the max-cells
     * range is out_of_range anyway, so clamp first. */
    if (ns > (PNET_RX_MAX_CELLS + 2u) * PNET_CELL_NS) ns = (PNET_RX_MAX_CELLS + 2u) * PNET_CELL_NS;
    /* ns <= 132000 and pw_ns is -130..1980 (the sync window), so t is positive and fits. */
    const int32_t t = (int32_t)ns + r->pw_ns + (int32_t)(PNET_CELL_NS / 2u);
    uint32_t cells = t > 0 ? (uint32_t)t / PNET_CELL_NS : 0u;
    if (cells < 1u) cells = 1u;
    if (cells > PNET_RX_MAX_CELLS) { r->out_of_range++; cells = PNET_RX_MAX_CELLS; }
    const size_t at = r->bit + (size_t)cells - 1u;   // the 1 after cells - 1 zeros
    if (at >= r->cap_bits) { r->overflowed = true; return; }
    while (r->cleared <= (at >> 3)) r->buf[r->cleared++] = 0;   // the lazy clear (pnet_rx.h)
    r->buf[at >> 3] |= (uint8_t)(0x80u >> (at & 7u));
    r->bit = at + 1u;
}

size_t pnet_rx_bytes(const pnet_rx_t *r) { return (r->bit + 7u) >> 3; }
