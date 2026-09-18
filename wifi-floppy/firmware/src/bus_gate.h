#ifndef BUS_GATE_H
#define BUS_GATE_H
// ---------------------------------------------------------------------------
// SEL0 gating: the pure half (HANDOFF 4d).
//
// On a bus shared with a second drive (external DF1, or a second internal
// drive on a big-box machine) the board may only answer for DF0: its outputs
// released unless SEL0 is asserted, and STEP/MTR/WGATE acted on only when
// meant for it. Measured 2026-09-18 with a real DF1 attached and ungated
// firmware: every DF1 disk-change click stepped DF0's head (30 -> 79), and a
// DOS floppy in DF1 came up as DF1:???? because the board's flux was on the
// shared RDATA line while DF1 was selected.
//
// The timing lives in PIO (floppy.pio: status_gate, sel_mtr, step_dir,
// flux_out); selects last 5-100 us, far too short for an interrupt. What those
// programs are fed and what their words mean lives here, host-tested.
// ---------------------------------------------------------------------------
#include <stdbool.h>
#include <stdint.h>

// The status gate's OUT window is GP0..GP(COUNT-1). Only the five status pins
// are handed to its PIO, so writes to the rest of the window reach no pad.
#define BUS_GATE_OUT_COUNT 14

// INDEX, CHNG, WPROT, RDY, TRK0 as a GPIO bitmask. Not RDATA: flux_out gates
// that one itself, per bit cell.
uint32_t bus_gate_status_mask(void);

// `shadow` with `pin` asserted or released. Pins outside the status mask leave
// it unchanged.
uint32_t bus_gate_apply(uint32_t shadow, unsigned pin, bool assert);

// One step_dir word: GP2..GP5 (SEL0 SEL1 MTR DIR) as sampled when STEP fell.
typedef struct {
    bool selected;   // SEL0 asserted (low): the step is DF0's
    bool outwards;   // DIR high: towards track 0
} bus_step_t;
bus_step_t bus_step_decode(uint32_t word);

// bus_sniff's packed 12-bit sample -> a plain GPIO mask (bit n = GPn).
// WDATA (GP7) and RDATA (GP11) are never sampled.
uint32_t bus_sniff_decode(uint32_t packed);

// True if a decoded sample shows a status output asserted while SEL0 is
// released -- the thing the gate exists to prevent.
bool bus_sniff_violation(uint32_t gpio_mask);

#endif
