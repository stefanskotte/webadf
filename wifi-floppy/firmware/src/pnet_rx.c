/* PaulaNET protocol (C) 2026 RobSmithDev, used with permission -- see pnet_rx.h. */
#include "pnet_rx.h"
#include <string.h>

void pnet_rx_init(pnet_rx_t *r, uint8_t *buf, size_t cap_bytes) {
    memset(r, 0, sizeof *r);
    r->buf = buf;
    r->cap_bits = cap_bytes * 8u;
    memset(buf, 0, cap_bytes);
}

void pnet_rx_feed(pnet_rx_t *r, uint32_t ns) {
    const uint32_t w = r->words++;
    if (w == 0) return;                               // arm -> first edge: not an interval
    if (w == 1) {
        r->sync_ns = ns;
        r->sync_ok = ns >= PNET_RX_SYNC_MIN_NS && ns <= PNET_RX_SYNC_MAX_NS;
        r->pw_ns = (int32_t)(PNET_SYNC_CELLS * PNET_CELL_NS) - (int32_t)ns;
        return;
    }
    if (!r->sync_ok || r->overflowed) return;
    const int64_t t = (int64_t)ns + r->pw_ns + (int64_t)(PNET_CELL_NS / 2u);
    uint64_t cells = t < (int64_t)PNET_CELL_NS ? 1u : (uint64_t)t / PNET_CELL_NS;
    if (cells > PNET_RX_MAX_CELLS) { r->out_of_range++; cells = PNET_RX_MAX_CELLS; }
    const size_t at = r->bit + (size_t)cells - 1u;   // the 1 after cells - 1 zeros
    if (at >= r->cap_bits) { r->overflowed = true; return; }
    r->buf[at >> 3] |= (uint8_t)(0x80u >> (at & 7u));
    r->bit = at + 1u;
}

size_t pnet_rx_bytes(const pnet_rx_t *r) { return (r->bit + 7u) >> 3; }
