#ifndef FLUX_CAPTURE_H
#define FLUX_CAPTURE_H
// The device half of write capture: the PIO state machine and the DMA that
// carry WDATA off the bus. Everything that is a DECISION rather than a
// register write lives in flux_bits.c/mfm.c, which are pure and host-tested;
// this file is only how the flux gets there.
//
// Device-only by construction (pio, dma), so test/run.sh excludes it -- see
// the exclusion list there, which says why for each name.
#include <stdint.h>
#include <stdbool.h>
#include "hardware/pio.h"

/** Claim a DMA channel and point it at `sm`'s RX FIFO. Call once, after
 *  flux_in_program_init and before anything arms a capture. */
void flux_capture_init(PIO pio, uint sm);

/**
 * Begin or end a capture, called from the WGATE edge ISR.
 *
 * Arming clears the accumulator and starts the state machine; disarming stops
 * it and leaves whatever was captured for flux_capture_poll() to finish. Both
 * are cheap enough for an ISR: no decoding happens here.
 */
void flux_capture_arm(void);
void flux_capture_disarm(void);

/**
 * Abandon a capture that has run too long to be a write.
 *
 * One track write is a single revolution -- ~200 ms. A WGATE that stays
 * asserted far past that is not a write: it is a floating input, which is
 * exactly what the bus looks like when the Amiga is switched off and stops
 * driving it. Seen on real hardware 2026-09-13, where a power event asserted
 * WGATE eight times in one microsecond alongside every other line and never
 * deasserted, leaving the capture armed indefinitely and filling its ring with
 * noise. Called from the service loop; returns true if it aborted one.
 */
bool flux_capture_timeout(uint32_t now_ms);

/** How long a capture may run before flux_capture_timeout() abandons it.
 *  Generously more than the ~200 ms one revolution takes. */
#define FLUX_CAPTURE_MAX_MS 400u

/**
 * Drain whatever the DMA has landed since the last call and turn it into
 * bits. Call from core0's service loop.
 *
 * BOUNDED, for the reason everything else in that loop is: the ring holds
 * ~16 ms of flux, and converting the whole of it at once would cost more of
 * the loop than a track change does. Returns the number of intervals consumed.
 */
uint32_t flux_capture_poll(void);

typedef struct {
    bool     complete;        /* a capture ended and has not been read yet */
    uint32_t intervals;
    uint32_t out_of_range;
    bool     overflowed;
    const uint8_t *mfm;
    uint32_t mfm_bytes;
    // Diagnostics, added 2026-09-15 after the first real writes: one decoded
    // 10 of 11 sectors and the next two decoded none.
    uint32_t max_backlog;     /* most unread ring words seen at once */
    uint32_t max_poll_gap_ms; /* longest gap between polls while armed */
    uint32_t cells[3];        /* intervals classified as 2, 3, 4 cells */
    uint32_t ns_min, ns_max;
} flux_capture_result_t;

/** True, once, after a capture ends: the bitstream is ready to decode.
 *  Clears the flag, so a caller that takes it owns it. */
bool flux_capture_take(flux_capture_result_t *out);

#endif
