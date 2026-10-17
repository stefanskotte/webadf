#ifndef LED_ACTIVITY_H
#define LED_ACTIVITY_H
// ---------------------------------------------------------------------------
// When the activity LED (activity_led.h) is lit: the way a real Amiga drive's
// light is -- while the Amiga is USING a drive, steady for the whole access,
// dark otherwise.
//
// A drive is in use while it is selected (SEL0/SEL1 asserted) AND its motor is
// on (the per-drive latch dskchg_motor_on_d, which sel_mtr sets on that
// drive's select fall). Both are needed:
//   - selected, motor off: trackdisk's disk-change poll, every ~2 s on every
//     drive. Lighting for it would blink an idle board forever.
//   - motor on, not selected: the Amiga is talking to the other drive.
// Reads and writes count alike: both happen selected with the motor on.
//
// Network mode (PaulaNET on DF1): DF1's cylinders 76 and 77 are the network,
// not disk data, so a DF1 head there is never activity -- the driver selects
// DF1 with its motor on ~20 times a second for as long as the link is up, and
// that was the light that was "practically on all the time". DF0, and DF1's
// other cylinders (its disk), still show.
//
// LED_ACT_HOLD_MS smooths gaps: the light stays on that long after the last
// busy pass. Why 150 ms:
//   - long enough to bridge what is ONE access to a person: the deselect gaps
//     between DOS's consecutive requests (a few ms to tens of ms), and the
//     ~25 ms DF1 slices when PaulaNET runs while DF0 reads -- a multi-track
//     read reads as one light, not a flicker.
//   - and it gives a one-pass access a visible ~150 ms flash (20 ms is about
//     the floor for seeing one at all).
//   - short enough that the light still goes out with the access: well under
//     a revolution (200 ms), so it never looks like it is lagging the disk.
//
// Pure, host-tested (test/test_led_activity.c); core0's loop samples the pads
// once a pass and writes the result. Nothing here runs in an interrupt.
// ---------------------------------------------------------------------------
#include <stdbool.h>
#include <stdint.h>
#include "pnet_status.h"   // PNET_CYL (77), PNET_CYL_STATUS (76)

#define LED_ACT_HOLD_MS 150u

/** True when the head on `cyl` is on PaulaNET's cylinders and Network mode is on. */
bool led_pnet_track(bool pnet_on, int cyl);

/** Drive in use: selected (asserted, not the pin level), motor on, not on PaulaNET's cylinders. */
bool led_drive_busy(bool selected, bool motor_on, bool pnet_track);

typedef struct {
    bool     ever;          // a busy pass has been seen (ms 0 is a valid time)
    uint32_t last_busy_ms;
} led_activity_t;

void led_activity_init(led_activity_t *a);

/** One pass: `busy` is any drive in use now. Returns whether the LED is lit. */
bool led_activity_step(led_activity_t *a, uint32_t now_ms, bool busy);

#endif
