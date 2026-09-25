#ifndef NFC_HANDOFF_H
#define NFC_HANDOFF_H
// The two mailboxes between the cores for tap-to-mount (spec 2026-09-25 §4.2).
//
//   * reader events, core0 -> core1: core0 owns the I2C bus and the reader,
//     core1 owns the network that turns a TAG_READ into POST /tap;
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

// A write request as core1 hands it to core0: arm `disk_id` under the server's
// `seq`, showing `line` while armed; disk_id "" = disarm.
#define NFC_WREQ_LINE_BYTES (DISP_DETAIL_MAX + 1)
typedef struct {
    uint32_t seq;
    char     disk_id[37];
    char     line[NFC_WREQ_LINE_BYTES];
} nfc_wreq_t;

typedef struct {
    volatile uint32_t seq;
    nfc_wreq_t req;
} nfc_wreq_box_t;

void nfc_wreq_box_put(nfc_wreq_box_t *b, const nfc_wreq_t *r);           // core1
bool nfc_wreq_box_take(nfc_wreq_box_t *b, uint32_t *last, nfc_wreq_t *out); // core0

#endif
