#ifndef FLUX_BITS_H
#define FLUX_BITS_H
// Flux intervals -> an MFM bitstream.
//
// The PIO (flux_in, src/floppy.pio) reports the gap between one WDATA edge and
// the next. That is what the wire carries: a transition is a 1 bit and the
// cells between transitions are 0s, so an interval of k bitcells is a 1
// followed by k-1 zeros. Reassembling those into bytes is what turns a write
// into something mfm_decode_track() can read.
//
// Pure C, no pico-sdk -- the rule device_client.h states. It is also the only
// part of the capture path that CAN be tested without an Amiga: the device
// half is a PIO state machine and a DMA channel, which only a floppy bus can
// exercise. So everything that is a decision rather than a register write
// lives here.
//
// WHY NOT BUFFER THE RAW INTERVALS. A written track is ~200 ms of flux with a
// transition every 4-8 us: 25,000-50,000 of them, and one 32-bit word each is
// 100-200 KB. Converting to bits as they arrive costs 12,668 bytes instead --
// the same size as the track it represents, because that is exactly what it
// is.
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

typedef struct {
    uint8_t *buf;
    size_t   cap_bits;
    size_t   bit;          /* next bit index to write */
    /** Set the moment a bit is dropped for want of room, and never cleared by
     *  the accumulator itself. A capture that silently stopped early would
     *  decode to a track missing its last sectors, which is indistinguishable
     *  from a damaged disk unless this says otherwise. */
    bool     overflowed;
    uint32_t intervals;
    /** Intervals longer than any legal MFM gap. A healthy stream has none;
     *  a few mean noise or a capture that began before WGATE settled, and a
     *  great many mean this is not an MFM stream at all. */
    uint32_t out_of_range;
} flux_bits_t;

/** `cap` is the buffer size in BYTES; it is cleared. */
void flux_bits_init(flux_bits_t *f, uint8_t *buf, size_t cap);

/** One flux interval, in nanoseconds. */
void flux_bits_feed(flux_bits_t *f, uint32_t ns);

/** Bytes written so far, rounded up to include a partial final byte. */
size_t flux_bits_bytes(const flux_bits_t *f);

/**
 * Convert a raw PIO down-counter reading into nanoseconds.
 *
 * flux_in spends 2 PIO cycles per loop iteration and counts DOWN from zero, so
 * the pushed value is the two's-complement of the iteration count. Kept here,
 * beside the only code that consumes it, because the relationship between a
 * counter tick and a nanosecond is exactly the kind of fact that goes stale
 * silently when the clock divider changes.
 */
uint32_t flux_counter_to_ns(uint32_t counter, uint32_t pio_clk_hz);

#endif
