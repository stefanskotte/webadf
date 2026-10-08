#include "harness.h"
#include "../src/bus_gate.h"
#include "../src/floppy_io.h"

/*
 * The decisions behind SEL0 gating (HANDOFF 4d), without the PIO.
 *
 * On a bus shared with a second drive the board must answer only for DF0:
 * drive its outputs only while SEL0 is asserted, and act on STEP and MTR only
 * when they are meant for it. The PIO programs do the timing; these functions
 * are what they are fed and what their words mean, and a wrong bit here is a
 * wrong pin on the bus.
 */

#define BIT(p) (1u << (p))

static void status_pins_are_exactly_the_five_gated_outputs(void) {
    uint32_t m = bus_gate_status_mask();
    CHECK_EQ_INT(m, BIT(PIN_INDEX) | BIT(PIN_CHNG) | BIT(PIN_WPROT) |
                    BIT(PIN_RDY) | BIT(PIN_TRK0));
    // RDATA is gated inside flux_out on pio0. If it were in this mask the
    // status gate would fight flux_out's side-set for the same pad.
    CHECK((m & BIT(PIN_RDATA)) == 0, "RDATA is not a status pin");
    // Every status pin must sit inside the gate's OUT window, GP0..GP13.
    CHECK((m & ~((1u << BUS_GATE_OUT_COUNT) - 1u)) == 0,
          "every status pin is inside the gate's OUT window");
    // And no input may be in it: a status write must never touch a bus input.
    uint32_t ins = BIT(PIN_SEL0) | BIT(PIN_SEL1) | BIT(PIN_MTR) | BIT(PIN_DIR) |
                   BIT(PIN_STEP) | BIT(PIN_WDATA) | BIT(PIN_WGATE) | BIT(PIN_SIDE);
    CHECK((m & ins) == 0, "no bus input is a status pin");
}

static void apply_sets_and_clears_one_pin_without_touching_others(void) {
    uint32_t s = 0;
    s = bus_gate_apply(s, PIN_TRK0, true);
    CHECK_EQ_INT(s, BIT(PIN_TRK0));
    s = bus_gate_apply(s, PIN_WPROT, true);
    CHECK_EQ_INT(s, BIT(PIN_TRK0) | BIT(PIN_WPROT));
    s = bus_gate_apply(s, PIN_TRK0, false);
    CHECK_EQ_INT(s, BIT(PIN_WPROT));
    // Idempotent both ways.
    CHECK_EQ_INT(bus_gate_apply(s, PIN_WPROT, true), s);
    CHECK_EQ_INT(bus_gate_apply(s, PIN_INDEX, false), s);
}

static void apply_ignores_pins_that_are_not_status_outputs(void) {
    // A stray call with an input or RDATA must not put a bit on the gate's
    // OUT window -- for RDATA that bit would reach no pad, but for a future
    // pin assignment it could.
    uint32_t s = BIT(PIN_CHNG);
    CHECK_EQ_INT(bus_gate_apply(s, PIN_RDATA, true), s);
    CHECK_EQ_INT(bus_gate_apply(s, PIN_SEL0, true), s);
    CHECK_EQ_INT(bus_gate_apply(s, PIN_STEP, true), s);
    CHECK_EQ_INT(bus_gate_apply(s, 40, true), s);
}

/*
 * step_dir pushes one 4-bit word per STEP fall: GP2..GP5 as sampled at that
 * instant, bit 0 = SEL0, bit 3 = DIR. Every bus input is active low through
 * the '541, so SEL0 = 0 means DF0 is selected, and DIR = 1 means outwards.
 */
static void step_word_selected_inward(void) {
    bus_step_t s = bus_step_decode(0x0);          // SEL0 low, DIR low
    CHECK(s.selected, "SEL0 low -> selected");
    CHECK(!s.outwards, "DIR low -> inwards");
}

static void step_word_selected_outward(void) {
    bus_step_t s = bus_step_decode(0x8);          // DIR high
    CHECK(s.selected, "SEL0 low -> selected");
    CHECK(s.outwards, "DIR high -> outwards");
}

static void step_word_for_the_other_drive(void) {
    // The DF1 disk-change click measured 2026-09-18: SEL0 released (high),
    // SEL1 asserted (low). It must not move DF0's head.
    bus_step_t s = bus_step_decode(0x1);          // SEL0 high, SEL1 low
    CHECK(!s.selected, "SEL0 high -> not ours");
    s = bus_step_decode(0x1 | 0x8);
    CHECK(!s.selected, "direction does not make it ours");
}

static void step_word_ignores_sel1_and_mtr(void) {
    // Only SEL0 decides. SEL1 and MTR ride along in the sample and mean nothing.
    CHECK(bus_step_decode(0x2).selected, "SEL1 released, SEL0 asserted: ours");
    CHECK(bus_step_decode(0x4).selected, "MTR level is irrelevant");
    CHECK(bus_step_decode(0x6).selected, "both irrelevant bits set: still ours");
    CHECK(!bus_step_decode(0x7).selected, "SEL0 released: not ours");
}

/*
 * bus_sniff (diagnostic) packs GP0..GP6, GP8..GP10 and GP12..GP13 into 12
 * bits, dropping WDATA (GP7) and RDATA (GP11), whose flux would flood the
 * FIFO. Decoded, it is a plain GPIO mask: bit n = GPn.
 */
static uint32_t pack_sniff(uint32_t gpio) {
    // Mirrors the PIO: in osr,7 ; out null,8 ; in osr,3 ; out null,4 ; in osr,2
    // with a left-shifting ISR -- the first bits taken end up highest.
    uint32_t lo = gpio & 0x7fu;                   // GP0..GP6
    uint32_t mid = (gpio >> 8) & 0x7u;            // GP8..GP10
    uint32_t hi = (gpio >> 12) & 0x3u;            // GP12..GP13
    return (lo << 5) | (mid << 2) | hi;
}

static void sniff_decode_round_trips_every_sampled_pin(void) {
    const unsigned pins[] = {0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 13};
    for (unsigned i = 0; i < sizeof pins / sizeof pins[0]; i++) {
        uint32_t g = BIT(pins[i]);
        CHECK_EQ_INT(bus_sniff_decode(pack_sniff(g)), g);
    }
    uint32_t all = 0x3fffu & ~BIT(PIN_WDATA) & ~BIT(PIN_RDATA);
    CHECK_EQ_INT(bus_sniff_decode(pack_sniff(all)), all);
    CHECK_EQ_INT(bus_sniff_decode(0), 0);
}

static void sniff_decode_never_reports_the_flux_pins(void) {
    uint32_t d = bus_sniff_decode(0xfffu);
    CHECK((d & BIT(PIN_WDATA)) == 0, "WDATA is not sampled");
    CHECK((d & BIT(PIN_RDATA)) == 0, "RDATA is not sampled");
    CHECK_EQ_INT(d, 0x3fffu & ~BIT(PIN_WDATA) & ~BIT(PIN_RDATA));
}

static void sniff_violation_is_a_status_output_while_sel0_released(void) {
    // The acceptance check for the gate, as the log analysis will apply it.
    CHECK(!bus_sniff_violation(BIT(PIN_SEL0)), "released, nothing asserted: fine");
    CHECK(bus_sniff_violation(BIT(PIN_SEL0) | BIT(PIN_TRK0)), "released + TRK0: violation");
    CHECK(bus_sniff_violation(BIT(PIN_SEL0) | BIT(PIN_INDEX)), "released + INDEX: violation");
    CHECK(!bus_sniff_violation(BIT(PIN_TRK0) | BIT(PIN_RDY)), "selected: outputs allowed");
    CHECK(!bus_sniff_violation(BIT(PIN_SEL0) | BIT(PIN_SEL1) | BIT(PIN_STEP)),
          "inputs alone are never a violation");
}

// SEL1 is bit 1 of the step word (GP3 when SEL0 is GP2). Both active low.
static void step_word_names_every_select_that_was_low(void) {
    // bits: 0 SEL0, 1 SEL1, 2 MTR, 3 DIR (1 = released / outwards)
    bus_step_t a = bus_step_decode(0x2u);          // SEL0 low, SEL1 high
    CHECK_EQ_INT(a.sel_mask, BUS_SEL_DF0);
    CHECK(a.selected, "SEL0 low: DF0's step");
    bus_step_t b = bus_step_decode(0x1u);          // SEL0 high, SEL1 low
    CHECK_EQ_INT(b.sel_mask, BUS_SEL_DF1);
    CHECK(!b.selected, "a DF1 step is not DF0's");
    bus_step_t c = bus_step_decode(0x0u);          // both low: both drives step, as real ones would
    CHECK_EQ_INT(c.sel_mask, BUS_SEL_DF0 | BUS_SEL_DF1);
    bus_step_t d = bus_step_decode(0x3u | 0x8u);   // neither, DIR outwards
    CHECK_EQ_INT(d.sel_mask, 0);
    CHECK(d.outwards, "DIR still decoded");
}

// A real DF1 steps (disk-change clicks, recalibrates); an absent one never does:
// all 1,838 STEP falls of a no-DF1 boot came with SEL0 (floppy.pio step_dir header).
// Three, not one: the power-event burst (HANDOFF, main.c step filter comment) is
// rejected by the 1 ms filter BEFORE counting, but one stray filtered pulse at a
// power edge must still not read as a drive.
static void df1_is_seen_only_after_several_steps(void) {
    CHECK(!bus_df1_seen(0), "no steps: none seen");
    CHECK(!bus_df1_seen(BUS_DF1_SEEN_STEPS - 1), "below the threshold: none seen");
    CHECK(bus_df1_seen(BUS_DF1_SEEN_STEPS), "at the threshold: seen");
    CHECK(bus_df1_seen(250), "the 4e bench count: seen");
}

int main(void) {
    RUN(status_pins_are_exactly_the_five_gated_outputs);
    RUN(apply_sets_and_clears_one_pin_without_touching_others);
    RUN(apply_ignores_pins_that_are_not_status_outputs);
    RUN(step_word_selected_inward);
    RUN(step_word_selected_outward);
    RUN(step_word_for_the_other_drive);
    RUN(step_word_ignores_sel1_and_mtr);
    RUN(step_word_names_every_select_that_was_low);
    RUN(df1_is_seen_only_after_several_steps);
    RUN(sniff_decode_round_trips_every_sampled_pin);
    RUN(sniff_decode_never_reports_the_flux_pins);
    RUN(sniff_violation_is_a_status_output_while_sel0_released);
    return REPORT();
}
