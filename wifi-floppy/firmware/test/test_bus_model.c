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

int main(void) {
    RUN(each_drive_owns_the_pads_only_during_its_own_select);
    RUN(a_released_gate_writes_only_once_on_the_deselect);
    RUN(rdata_pulses_only_for_the_selected_drive_and_a_stall_holds_nothing);
    return REPORT();
}
