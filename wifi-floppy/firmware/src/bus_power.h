#ifndef BUS_POWER_H
#define BUS_POWER_H
// ---------------------------------------------------------------------------
// "Is the Amiga's side of the floppy bus powered?" -- decided from the seven
// buffered inputs (SEL0, SEL1, MTR, WGATE, STEP, DIR, SIDE).
//
// On rev B the bus pull-ups hang from the Amiga's +5 V. Switched off, every
// line decays to 0, which the board reads as every input asserted at once --
// motor on, both drives selected, a write in progress. A running Amiga never
// does that (it never selects DF0 and DF1 together, let alone with all the
// rest low), so all seven low for BUS_UNPOWERED_MS means nobody is there.
//
// Why it matters (bench 2026-10-09, fw 1.9.1+g722ff3d): sel_mtr latches MTR
// only on a SEL0 fall. The power-down's last SEL0 fall latched "motor ON", and
// with SEL0 then held low no later fall could clear it: the OTA idle gate
// (motor off) never passed and a staged update waited until the Amiga was
// powered again.
//
// Debounced: one pad high at any sample restarts the timer, and any pad high
// is "powered" again at once (the normal SEL-edge latch takes over from
// there). Sampled from core0's loop every BUS_POWER_SAMPLE_MS; detection is
// BUS_UNPOWERED_MS .. + one sample after the last pad went low.
//
// Pure, host-tested (test_bus_power.c); wraparound-safe (unsigned now - since).
// ---------------------------------------------------------------------------
#include <stdbool.h>
#include <stdint.h>

#define BUS_UNPOWERED_MS    2000u
#define BUS_POWER_SAMPLE_MS 100u

typedef struct {
    bool     unpowered;     // the verdict
    bool     low_timing;    // every pad was low at the last sample
    uint32_t low_since_ms;  // the first sample of the current all-low run
} bus_power_t;

typedef enum {
    BUS_POWER_NO_CHANGE = 0,
    BUS_POWER_LOST,         // just became unpowered
    BUS_POWER_RETURNED,     // just became powered again
} bus_power_event_t;

/** Starts "powered", with no all-low run. */
void bus_power_init(bus_power_t *b);

/** One sample. `pads_high`: any bit set = that pad reads high (released);
 *  0 = every input low. Returns the transition this sample caused, if any. */
bus_power_event_t bus_power_step(bus_power_t *b, uint32_t pads_high, uint32_t now_ms);
#endif
