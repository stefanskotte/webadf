#include "flux_bits.h"
#include "mfm.h"
#include <string.h>

void flux_bits_init(flux_bits_t *f, uint8_t *buf, size_t cap) {
    f->buf = buf;
    f->cap_bits = cap * 8;
    f->bit = 0;
    f->overflowed = false;
    f->intervals = 0;
    f->out_of_range = 0;
    memset(buf, 0, cap);
}

void flux_bits_feed(flux_bits_t *f, uint32_t ns) {
    f->intervals++;

    // Anything past ~9 us is not a gap this encoding produces. It is counted
    // and then treated as the longest legal gap rather than dropped: a single
    // stretched interval at the very start of a capture (the line settling
    // after WGATE) should cost alignment, not the whole track.
    if (ns >= 9000) f->out_of_range++;

    const int cells = mfm_interval_to_bits(ns);

    // A transition, then the empty cells that follow it. MSB first, which is
    // the order the bits go down the wire and the order mfm_decode_track
    // reads them back.
    if (f->bit >= f->cap_bits) { f->overflowed = true; return; }
    f->buf[f->bit >> 3] |= (uint8_t)(0x80u >> (f->bit & 7));
    f->bit++;

    size_t zeros = (size_t)(cells - 1);
    if (f->bit + zeros > f->cap_bits) {
        f->overflowed = true;
        zeros = f->cap_bits - f->bit;
    }
    f->bit += zeros;      // the buffer was cleared, so zeros need no writing
}

size_t flux_bits_bytes(const flux_bits_t *f) {
    return (f->bit + 7) >> 3;
}

uint32_t flux_counter_to_ns(uint32_t counter, uint32_t pio_clk_hz) {
    // The program counts down, so the pushed word is -(iterations).
    const uint32_t iterations = (uint32_t)(-(int32_t)counter);
    // Two PIO cycles per iteration. 64-bit intermediate: iterations * 2e9
    // overflows 32 bits well before the counter does.
    return (uint32_t)(((uint64_t)iterations * 2u * 1000000000ull) / pio_clk_hz);
}
