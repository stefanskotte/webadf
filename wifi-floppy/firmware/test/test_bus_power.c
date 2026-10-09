#include "harness.h"
#include "../src/bus_power.h"

/*
 * The Amiga switched off: every bus pull-up loses its +5 V and all seven
 * inputs read low. Bench 2026-10-09: the power-down latched "motor ON" and the
 * staged update never applied. bus_power decides "unpowered" from all pads
 * low for BUS_UNPOWERED_MS, so core0 can clear the latch.
 */

// Samples every BUS_POWER_SAMPLE_MS from `from` up to and including `to`,
// all low. Returns the last event seen that was not NO_CHANGE.
static bus_power_event_t run_low(bus_power_t *b, uint32_t from, uint32_t to) {
    bus_power_event_t last = BUS_POWER_NO_CHANGE;
    for (uint32_t t = from; (int32_t)(to - t) >= 0; t += BUS_POWER_SAMPLE_MS) {
        bus_power_event_t e = bus_power_step(b, 0, t);
        if (e != BUS_POWER_NO_CHANGE) last = e;
    }
    return last;
}

static void powered_by_default(void) {
    bus_power_t b; bus_power_init(&b);
    CHECK(!b.unpowered, "starts powered");
    CHECK_EQ_INT(bus_power_step(&b, 0x7f, 0), BUS_POWER_NO_CHANGE);
    CHECK_EQ_INT(bus_power_step(&b, 0x01, 100), BUS_POWER_NO_CHANGE);
    CHECK(!b.unpowered, "pads high: powered");
}

static void all_low_for_1900_ms_is_not_yet_unpowered(void) {
    bus_power_t b; bus_power_init(&b);
    CHECK_EQ_INT(run_low(&b, 1000, 2900), BUS_POWER_NO_CHANGE);
    CHECK(!b.unpowered, "1.9 s all low: still powered");
}

static void all_low_for_2_s_is_unpowered_once(void) {
    bus_power_t b; bus_power_init(&b);
    CHECK_EQ_INT(run_low(&b, 1000, 2900), BUS_POWER_NO_CHANGE);
    CHECK_EQ_INT(bus_power_step(&b, 0, 3000), BUS_POWER_LOST);
    CHECK(b.unpowered, "2 s all low: unpowered");
    CHECK_EQ_INT(bus_power_step(&b, 0, 3100), BUS_POWER_NO_CHANGE);
    CHECK_EQ_INT(run_low(&b, 3200, 60000), BUS_POWER_NO_CHANGE);
    CHECK(b.unpowered, "and stays so, reported once");
}

static void one_pad_high_restarts_the_timer(void) {
    bus_power_t b; bus_power_init(&b);
    run_low(&b, 0, 1900);
    CHECK_EQ_INT(bus_power_step(&b, 1u << 3, 2000), BUS_POWER_NO_CHANGE);  // e.g. WGATE high
    CHECK_EQ_INT(run_low(&b, 2100, 4000), BUS_POWER_NO_CHANGE);
    CHECK(!b.unpowered, "1.9 s since the restart: still powered");
    CHECK_EQ_INT(bus_power_step(&b, 0, 4100), BUS_POWER_LOST);
}

static void any_pad_high_is_powered_again(void) {
    for (unsigned bit = 0; bit < 7; bit++) {
        bus_power_t b; bus_power_init(&b);
        CHECK_EQ_INT(run_low(&b, 0, 2000), BUS_POWER_LOST);
        CHECK_EQ_INT(bus_power_step(&b, 1u << bit, 2100), BUS_POWER_RETURNED);
        CHECK(!b.unpowered, "one pad high: powered");
        CHECK_EQ_INT(bus_power_step(&b, 0x7f, 2200), BUS_POWER_NO_CHANGE);
        // and a second power-off is detected afresh, timed from its own start
        CHECK_EQ_INT(run_low(&b, 2300, 4200), BUS_POWER_NO_CHANGE);
        CHECK_EQ_INT(bus_power_step(&b, 0, 4300), BUS_POWER_LOST);
    }
}

static void wraparound_of_the_ms_clock(void) {
    bus_power_t b; bus_power_init(&b);
    const uint32_t start = 0xFFFFFFFFu - 1000u;          // wraps 1 s into the run
    CHECK_EQ_INT(run_low(&b, start, start + 1900u), BUS_POWER_NO_CHANGE);
    CHECK(!b.unpowered, "1.9 s across the wrap: still powered");
    CHECK_EQ_INT(bus_power_step(&b, 0, start + 2000u), BUS_POWER_LOST);
    CHECK_EQ_INT(bus_power_step(&b, 0x10, start + 2100u), BUS_POWER_RETURNED);
}

static void a_low_run_started_long_ago_still_counts_from_its_start(void) {
    // Sparse samples (a slow loop pass): the run is timed from its first
    // all-low sample, not from the previous sample.
    bus_power_t b; bus_power_init(&b);
    CHECK_EQ_INT(bus_power_step(&b, 0, 500), BUS_POWER_NO_CHANGE);
    CHECK_EQ_INT(bus_power_step(&b, 0, 2499), BUS_POWER_NO_CHANGE);
    CHECK_EQ_INT(bus_power_step(&b, 0, 2500), BUS_POWER_LOST);
}

int main(void) {
    RUN(powered_by_default);
    RUN(all_low_for_1900_ms_is_not_yet_unpowered);
    RUN(all_low_for_2_s_is_unpowered_once);
    RUN(one_pad_high_restarts_the_timer);
    RUN(any_pad_high_is_powered_again);
    RUN(wraparound_of_the_ms_clock);
    RUN(a_low_run_started_long_ago_still_counts_from_its_start);
    return REPORT();
}
