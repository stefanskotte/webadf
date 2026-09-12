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
} flux_capture_result_t;

/** True, once, after a capture ends: the bitstream is ready to decode.
 *  Clears the flag, so a caller that takes it owns it. */
bool flux_capture_take(flux_capture_result_t *out);

#endif
