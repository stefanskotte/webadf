#ifndef ACTIVITY_LED_H
#define ACTIVITY_LED_H
// A drive activity LED on PIN_ACT_LED (floppy_io.h), for watching the floppy
// side without a console attached.
//
// WHY THIS EXISTS SEPARATELY FROM THE LOG. wf_log reaches a terminal over USB
// CDC and holds its records until one attaches, so on a board sitting under a
// desk beside an Amiga there is nothing to see at all. A per-revolution trace
// was tried and had to be removed -- see dma_irq()'s comment on INDEX -- for
// exactly the reason a LED is the right instrument instead: a continuous
// signal belongs on a wire, not in a ring buffer.
//
// NOTHING HERE BLOCKS. led_blip() is a GPIO write plus a one-shot alarm, which
// is the same pattern dma_irq() already uses for the INDEX pulse, so it is
// legal from an interrupt and cannot stall core0's 1 ms service loop. That
// constraint is the whole reason the OLED is a separate question: a full-frame
// I2C write is ~20 ms and has no business anywhere near that loop.
#include <stdbool.h>

/** Claim the pin and drive it dark. Safe to call with nothing wired up. */
void led_init(void);

/**
 * Blink N times, ~LED_BLIP_MS on and off, scheduled rather than blocking.
 *
 * The point is not decoration: with no Amiga connected there is no floppy
 * traffic, so a dark LED means "idle", "wrong pin", "backwards LED" and "not
 * wired" all at once. A boot blink separates the first from the rest before
 * the cable is ever plugged in.
 */
void led_selftest(int blinks);

/**
 * One visible flash. Safe from an interrupt.
 *
 * Stretched to LED_BLIP_MS because the events worth showing are microseconds
 * long -- a raw toggle on a track read would never be seen. Overlapping blips
 * simply hold it lit, which is what makes a seek (one STEP every ~3 ms) read
 * as a solid glow rather than a stutter, the way a real drive does.
 */
void led_blip(void);

#endif
