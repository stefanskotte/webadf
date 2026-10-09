#include "harness.h"
#include "../src/bus_model.h"

// Two status_gate SMs and two flux_out SMs on ONE PIO, sharing the status pads
// and RDATA, under RP2350 datasheet §11.2.6: the highest-numbered SM writing a
// pin in a cycle wins; a pin nobody writes keeps its level. The board is right
// iff the pads show drive k's word while only SEL_k is low, and nothing while
// neither is.

static void each_drive_owns_the_pads_only_during_its_own_select(void) {
    bus_model_t m; bus_model_init(&m, 2);
    bus_model_set_word(&m, 0, 0x0F);   // DF0 asserts four status pins
    bus_model_set_word(&m, 1, 0x30);   // DF1 asserts two others
    bus_model_select(&m, 0x1);  bus_model_run(&m, 20);
    CHECK_EQ_INT(bus_model_pads(&m), 0x0F);
    bus_model_select(&m, 0x0);  bus_model_run(&m, 20);
    CHECK_EQ_INT(bus_model_pads(&m), 0x00);
    bus_model_select(&m, 0x2);  bus_model_run(&m, 20);
    CHECK_EQ_INT(bus_model_pads(&m), 0x30);
    bus_model_select(&m, 0x1);  bus_model_run(&m, 20);   // straight from DF1 to DF0
    CHECK_EQ_INT(bus_model_pads(&m), 0x0F);
}

// The 1.7.4 program wrote `mov pins, null` on every released loop: a second
// SM doing that would overwrite the first ~every 33 ns.
static void a_released_gate_writes_only_once_on_the_deselect(void) {
    bus_model_t m; bus_model_init(&m, 2);
    bus_model_set_word(&m, 0, 0x0F);
    bus_model_select(&m, 0x1); bus_model_run(&m, 20);
    bus_model_select(&m, 0x2); bus_model_run(&m, 40);
    CHECK_EQ_INT(bus_model_released_writes(&m, 0), 1);   // one null write on SEL0's rise
    CHECK_EQ_INT(bus_model_released_writes(&m, 1), 0);   // DF1 was never selected before
}

// flux_out: a deselected SM, or one stalled on an empty FIFO, never writes RDATA.
static void rdata_pulses_only_for_the_selected_drive_and_a_stall_holds_nothing(void) {
    bus_model_t m; bus_model_init(&m, 2);
    bus_model_feed_bits(&m, 0, 0xFFFFFFFFu);   // DF0 has a stream
    // DF1 has none: its SM stalls at `out` with no side-set.
    bus_model_select(&m, 0x1);
    CHECK(bus_model_run_count_rdata_pulses(&m, 8 * 32) == 32, "DF0 pulses every 1 cell");
    bus_model_select(&m, 0x2);
    CHECK(bus_model_run_count_rdata_pulses(&m, 8 * 32) == 0, "DF1 selected, empty: no pulse");
    CHECK(bus_model_rdata(&m) == 0, "and RDATA was left released");
}

// Both selects low together -- many trackloaders select every drive at once
// to stop the motors. With DF1's gate running, its word wins the pads (the
// higher-numbered SM): DF0's lines are overwritten. With DF1 off -- its gate
// disabled (bus_out_drive_enable) -- the pads show DF0's word only, exactly
// as a board with no second machine (1.7.8).
static void a_disabled_df1_leaves_df0s_word_on_the_pads_under_a_dual_select(void) {
    bus_model_t on; bus_model_init(&on, 2);
    bus_model_set_word(&on, 0, 0x0F);
    bus_model_set_word(&on, 1, 0x30);
    bus_model_select(&on, 0x3); bus_model_run(&on, 20);
    CHECK_EQ_INT(bus_model_pads(&on), 0x30);           // the hazard: DF1's word wins

    bus_model_t off; bus_model_init(&off, 2);
    bus_model_set_word(&off, 0, 0x0F);
    bus_model_set_word(&off, 1, 0x30);                 // DF1's word is kept while off
    bus_model_set_enabled(&off, 1, false);
    bus_model_select(&off, 0x3); bus_model_run(&off, 20);
    CHECK_EQ_INT(bus_model_pads(&off), 0x0F);          // DF0's word only
    bus_model_select(&off, 0x2); bus_model_run(&off, 20);
    CHECK_EQ_INT(bus_model_pads(&off), 0x00);          // SEL1 alone: DF0's release, nothing of DF1's
    CHECK_EQ_INT(bus_model_released_writes(&off, 1), 0);   // DF1 never wrote at all

    // Pad for pad, through every select pattern, the one-machine board
    // (1.7.8) it must equal.
    bus_model_t one; bus_model_init(&one, 1);
    bus_model_t two; bus_model_init(&two, 2);
    bus_model_set_word(&one, 0, 0x0F);
    bus_model_set_word(&two, 0, 0x0F);
    bus_model_set_word(&two, 1, 0x30);
    bus_model_set_enabled(&two, 1, false);
    const uint32_t seq[] = { 0x0, 0x1, 0x3, 0x2, 0x3, 0x1, 0x0, 0x2, 0x0, 0x3, 0x0 };
    for (unsigned i = 0; i < sizeof seq / sizeof seq[0]; i++) {
        bus_model_select(&one, seq[i]); bus_model_run(&one, 20);
        bus_model_select(&two, seq[i]); bus_model_run(&two, 20);
        CHECK_EQ_INT(bus_model_pads(&two), bus_model_pads(&one));
    }
}

int main(void) {
    RUN(a_disabled_df1_leaves_df0s_word_on_the_pads_under_a_dual_select);
    RUN(each_drive_owns_the_pads_only_during_its_own_select);
    RUN(a_released_gate_writes_only_once_on_the_deselect);
    RUN(rdata_pulses_only_for_the_selected_drive_and_a_stall_holds_nothing);
    return REPORT();
}
