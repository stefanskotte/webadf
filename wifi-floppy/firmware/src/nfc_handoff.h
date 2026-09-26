#ifndef NFC_HANDOFF_H
#define NFC_HANDOFF_H
// The mailboxes between the cores for tap-to-mount (spec 2026-09-25 §4.2).
//
//   * reader events, core0 -> core1: core0 owns the I2C bus and the reader,
//     core1 owns the network that turns a TAG_READ into POST /tap. Two
//     boxes (nfc_ev_boxes_t): WRITE_DONE in one of its own, everything else
//     in the other -- so a write's result core1 has not taken yet (it may be
//     inside a 2 MB fetch or a dc_tap) is never replaced by a later tap;
//   * the write request, core1 -> core0: the poll delivers it, the reader
//     acts on it.
//
// Each is ONE slot with ONE writer and ONE reader, and a seqlock: `seq` is odd
// while the writer is copying, so a reader that catches a half-written slot
// (or has the slot rewritten under it) knows, and simply tries again on its
// next pass -- the same torn-read-safe pattern as main.c's
// ui_publish/ui_snapshot. A put over an UNCONSUMED slot replaces it: a tap
// that core1 never saw loses to the next one, which is the newer intent.
//
// The reader keeps its own `last` cursor (the seq it last took), so "pending"
// is a single word compare -- cheap enough for the transport's wait loop,
// which is where core1 asks it while a poll is held.
//
// RULE: pure C -- C standard headers plus nfc_reader.h and display.h (both
// pure) only. The barrier is the compiler's __atomic_thread_fence, which is a
// `dmb` on the RP2350 and a real fence on the host, so the torn-read test runs
// against the same code.
#include <stdint.h>
#include <stdbool.h>
#include "nfc_reader.h"
#include "display.h"

typedef struct {
    volatile uint32_t seq;
    nfc_event_t ev;
} nfc_ev_box_t;

// Writer side (core0).
void nfc_ev_box_put(nfc_ev_box_t *b, const nfc_event_t *ev);
// Reader side (core1). True = `out` holds a whole event newer than *last, and
// *last has moved to it. False = nothing new, or torn: ask again later.
bool nfc_ev_box_take(nfc_ev_box_t *b, uint32_t *last, nfc_event_t *out);
// Something newer than `last` was published (or is being). One load.
bool nfc_ev_box_pending(const nfc_ev_box_t *b, uint32_t last);

// Both event boxes, and core1's cursor into each.
typedef struct {
    nfc_ev_box_t taps;   // TAG_READ, NOT_OURS, UNREADABLE
    nfc_ev_box_t done;   // WRITE_DONE only
} nfc_ev_boxes_t;
typedef struct {
    uint32_t taps;
    uint32_t done;
} nfc_ev_cursor_t;

// core0: WRITE_DONE to `done`, anything else to `taps`.
void nfc_ev_route(nfc_ev_boxes_t *b, const nfc_event_t *ev);
// core1: something newer in EITHER box. One load each.
bool nfc_ev_boxes_pending(const nfc_ev_boxes_t *b, const nfc_ev_cursor_t *c);

// The write report core1 owes the server (POST /tap-write), held until it is
// HEARD -- any 2xx; the server acknowledges a stale seq and ignores it -- and
// retried between polls until then. Core1-only, so no seqlock. A newer write
// request (or its withdrawal, which also moves the seq) makes an unreported
// older result moot: nfc_report_supersede drops it.
#define NFC_REPORT_RETRY_FIRST_MS  2000u
#define NFC_REPORT_RETRY_CAP_MS   60000u

typedef struct {
    bool        owed;
    nfc_event_t ev;      // the WRITE_DONE; `why` points at the reader's literals
    // Its own retry schedule: core1's pass can turn every ~50 ms (the
    // uploader's quiet windows send nothing), so "every pass" is not a rate.
    bool        backing_off;   // a send failed; not offered before sent_at + wait
    uint32_t    sent_at;
    uint32_t    wait;          // 0, then 2 s doubling to 60 s
} nfc_report_t;

void nfc_report_init(nfc_report_t *r);
// A WRITE_DONE to report. Replaces an older one still owed, and starts the
// schedule afresh: offered at once.
void nfc_report_hold(nfc_report_t *r, const nfc_event_t *done);
// True = `out` is the report to (re)send now: owed, and not waiting out a
// failed send's retry interval. Wrap-safe (elapsed time, not a deadline);
// once due it stays due until the next send.
bool nfc_report_next(nfc_report_t *r, uint32_t now, nfc_event_t *out);
// The outcome of sending the report for `seq` at `now`: heard settles it, if
// it is still the one owed; not heard schedules the retry (2 s, doubling,
// capped at 60 s).
void nfc_report_sent(nfc_report_t *r, uint32_t seq, bool heard, uint32_t now);
// A write request `request_seq` arrived: an owed report for an older seq is dropped.
void nfc_report_supersede(nfc_report_t *r, uint32_t request_seq);
// core1's turn for the report this pass: never on a pass that handled a tap
// (a send on a dead network can block through DNS/connect/read timeouts),
// otherwise nfc_report_next.
bool nfc_report_turn(nfc_report_t *r, uint32_t now, bool tapped, nfc_event_t *out);

// A write request as core1 hands it to core0: arm `disk_id` under the server's
// `seq`, showing `title` on the title line while armed; disk_id "" = disarm.
#define NFC_WREQ_TITLE_BYTES (DISP_TITLE_MAX + 1)
typedef struct {
    uint32_t seq;
    char     disk_id[37];
    char     title[NFC_WREQ_TITLE_BYTES];
} nfc_wreq_t;

typedef struct {
    volatile uint32_t seq;
    nfc_wreq_t req;
} nfc_wreq_box_t;

void nfc_wreq_box_put(nfc_wreq_box_t *b, const nfc_wreq_t *r);           // core1
bool nfc_wreq_box_take(nfc_wreq_box_t *b, uint32_t *last, nfc_wreq_t *out); // core0

#endif
