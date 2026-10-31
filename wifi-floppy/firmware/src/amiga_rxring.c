// The line ring and its TCP ack accounting (fw 1.23.0). See amiga_rxring.h.
#include "amiga_rxring.h"
#include <stddef.h>

void rr_init(rr_ring_t *r, uint8_t *buf, int size) { r->buf = buf; r->size = buf ? size : 0; r->head = r->tail = 0; }

int rr_used(const rr_ring_t *r) { return r->size ? (r->head - r->tail + r->size) % r->size : 0; }

int rr_feed(rr_ring_t *r, as_raw_t **raw, const uint8_t *b, int n, uint32_t *ack_now) {
    int i = 0;
    as_raw_t *w = *raw;
    if (w) {   // spec 2026-10-18 §5: into the upload ring first
        const int k = as_raw_feed(w, b, n);
        if (k < 0) return -1;                         // past the credit: amiga_send drops the connection
        i = k;
        *ack_now += (uint32_t)k;
        if (w->got == w->total) *raw = NULL;          // the raw section is over: lines again
    }
    for (; i < n; i++) {
        // Past the window: a peer that ignores it (the ring holds a whole window, so never otherwise).
        if (!r->buf || rr_used(r) == r->size - 1) return -1;
        r->buf[r->head] = b[i];
        r->head = (r->head + 1) % r->size;
    }
    return 0;
}

int rr_take_line(rr_ring_t *r, char *out, int cap, int *ack) {
    const int used = rr_used(r);
    int lf = -1;
    *ack = 0;
    for (int i = 0; i < used; i++) if (r->buf[(r->tail + i) % r->size] == '\n') { lf = i; break; }
    if (lf < 0) return 0;
    int n = 0;
    for (int i = 0; i < lf; i++) {
        const char ch = (char)r->buf[(r->tail + i) % r->size];
        if (ch != '\r' && n < cap - 1) out[n++] = ch;
    }
    out[n] = 0;
    r->tail = (r->tail + lf + 1) % r->size;
    *ack = lf + 1;
    return 1;
}

int rr_drain(rr_ring_t *r) {
    const int u = rr_used(r);
    r->head = r->tail = 0;
    return u;
}
