#include "nfc_handoff.h"
#include <string.h>

// A full barrier, for the compiler and the core alike: `dmb` on the RP2350,
// the host's fence under test. The same job __dmb() does in ui_publish.
#define FENCE() __atomic_thread_fence(__ATOMIC_SEQ_CST)

// The seqlock, once, for both boxes. Single writer per box, so the writer
// reads its own seq without a race.
static void box_put(volatile uint32_t *seq, void *slot, const void *src, size_t n) {
    uint32_t s = *seq;
    *seq = s + 1u;                  // odd: writing
    FENCE();
    memcpy(slot, src, n);
    FENCE();
    *seq = s + 2u;                  // even: settled
}

static bool box_take(const volatile uint32_t *seq, const void *slot, void *out, size_t n,
                     uint32_t *last) {
    uint32_t a = *seq;
    FENCE();
    if ((a & 1u) || a == *last) return false;
    memcpy(out, slot, n);
    FENCE();
    if (*seq != a) return false;    // rewritten under us: the next pass takes the newer one
    *last = a;
    return true;
}

void nfc_ev_box_put(nfc_ev_box_t *b, const nfc_event_t *ev) {
    box_put(&b->seq, &b->ev, ev, sizeof *ev);
}

bool nfc_ev_box_take(nfc_ev_box_t *b, uint32_t *last, nfc_event_t *out) {
    return box_take(&b->seq, &b->ev, out, sizeof *out, last);
}

bool nfc_ev_box_pending(const nfc_ev_box_t *b, uint32_t last) {
    return b->seq != last;
}

void nfc_ev_route(nfc_ev_boxes_t *b, const nfc_event_t *ev) {
    nfc_ev_box_put(ev->kind == NFC_EV_WRITE_DONE ? &b->done : &b->taps, ev);
}

bool nfc_ev_boxes_pending(const nfc_ev_boxes_t *b, const nfc_ev_cursor_t *c) {
    return nfc_ev_box_pending(&b->done, c->done) || nfc_ev_box_pending(&b->taps, c->taps);
}

void nfc_report_init(nfc_report_t *r) {
    memset(r, 0, sizeof *r);
}

void nfc_report_hold(nfc_report_t *r, const nfc_event_t *done) {
    r->ev = *done;
    r->owed = true;
}

bool nfc_report_next(const nfc_report_t *r, nfc_event_t *out) {
    if (!r->owed) return false;
    *out = r->ev;
    return true;
}

void nfc_report_sent(nfc_report_t *r, uint32_t seq, bool heard) {
    if (heard && r->owed && r->ev.seq == seq) r->owed = false;
}

void nfc_report_supersede(nfc_report_t *r, uint32_t request_seq) {
    if (r->owed && request_seq > r->ev.seq) r->owed = false;
}

void nfc_wreq_box_put(nfc_wreq_box_t *b, const nfc_wreq_t *r) {
    box_put(&b->seq, &b->req, r, sizeof *r);
}

bool nfc_wreq_box_take(nfc_wreq_box_t *b, uint32_t *last, nfc_wreq_t *out) {
    return box_take(&b->seq, &b->req, out, sizeof *out, last);
}
