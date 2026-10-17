#include "harness.h"
#include "../src/led_activity.h"

/*
 * The activity LED mirrors a real Amiga drive's light: lit while the Amiga is
 * using a drive -- selected AND its motor on -- held across the short gaps
 * between consecutive accesses, dark otherwise. PaulaNET's cylinders on DF1 in
 * Network mode are not disk activity.
 */

static void a_drive_is_busy_only_selected_with_its_motor_on(void) {
    CHECK(led_drive_busy(true, true, false), "selected, motor on: the Amiga is reading or writing it");
    CHECK(!led_drive_busy(true, false, false), "selected, motor off: trackdisk's disk-change poll");
    CHECK(!led_drive_busy(false, true, false), "motor on but another drive selected");
    CHECK(!led_drive_busy(false, false, false), "idle");
}

static void paulanet_cylinders_are_not_disk_activity(void) {
    CHECK(led_pnet_track(true, PNET_CYL), "Network mode, cylinder 77: the data loop");
    CHECK(led_pnet_track(true, PNET_CYL_STATUS), "Network mode, cylinder 76: the status track");
    CHECK(!led_pnet_track(true, 75), "Network mode, a disk cylinder");
    CHECK(!led_pnet_track(true, 78), "Network mode, a disk cylinder above");
    CHECK(!led_pnet_track(true, 0), "Network mode, the boot cylinder");
    CHECK(!led_pnet_track(false, PNET_CYL), "outside Network mode cylinder 77 is disk data");
    CHECK(!led_pnet_track(false, PNET_CYL_STATUS), "outside Network mode cylinder 76 is disk data");
    CHECK(!led_drive_busy(true, true, true), "selected with the motor on, but on PaulaNET's cylinders");
}

static void dark_until_first_activity(void) {
    led_activity_t a; led_activity_init(&a);
    CHECK(!led_activity_step(&a, 0, false), "boot: dark");
    CHECK(!led_activity_step(&a, 5000, false), "still dark, however long");
    // ms 0 is a valid busy time: "never" is its own flag, not a zero time.
    led_activity_init(&a);
    CHECK(led_activity_step(&a, 0, true), "busy at ms 0 lights it");
    CHECK(led_activity_step(&a, 1, false), "and holds");
}

static void lit_while_busy_and_held_across_short_gaps(void) {
    led_activity_t a; led_activity_init(&a);
    CHECK(led_activity_step(&a, 1000, true), "busy: lit at once");
    CHECK(led_activity_step(&a, 1200, true), "steady while busy");
    CHECK(led_activity_step(&a, 1201, false), "a gap begins: held");
    CHECK(led_activity_step(&a, 1200 + LED_ACT_HOLD_MS - 1, false), "held to the end of the hold");
    CHECK(led_activity_step(&a, 1200 + LED_ACT_HOLD_MS - 1, true), "busy again inside the hold: one light");
    const uint32_t last = 1200 + LED_ACT_HOLD_MS - 1;
    CHECK(led_activity_step(&a, last + LED_ACT_HOLD_MS - 1, false), "the hold restarts from the last busy pass");
    CHECK(!led_activity_step(&a, last + LED_ACT_HOLD_MS, false), "dark once the gap outlasts the hold");
    CHECK(!led_activity_step(&a, 9000, false), "stays dark");
}

static void a_one_pass_access_is_still_seen(void) {
    led_activity_t a; led_activity_init(&a);
    CHECK(led_activity_step(&a, 100, true), "one busy pass");
    CHECK(led_activity_step(&a, 100 + LED_ACT_HOLD_MS - 1, false), "is shown for the whole hold");
    CHECK(!led_activity_step(&a, 100 + LED_ACT_HOLD_MS, false), "then dark");
}

static void the_ms_clock_wrapping_does_not_stick_it(void) {
    led_activity_t a; led_activity_init(&a);
    CHECK(led_activity_step(&a, UINT32_MAX - 10, true), "busy just before the wrap");
    CHECK(led_activity_step(&a, 20, false), "held across the wrap");
    CHECK(!led_activity_step(&a, (uint32_t)(UINT32_MAX - 10 + LED_ACT_HOLD_MS), false), "and released after it");
}

static void network_traffic_alone_never_lights_it(void) {
    // PaulaNET at ~20 Hz: DF1 selected with its motor on, on cylinder 77, for ten seconds.
    led_activity_t a; led_activity_init(&a);
    bool ever = false;
    for (uint32_t t = 0; t < 10000; t++) {
        const bool df1_sel = (t % 50) < 25;
        const bool busy = led_drive_busy(false, false, false) ||
                          led_drive_busy(df1_sel, true, led_pnet_track(true, PNET_CYL));
        ever |= led_activity_step(&a, t, busy);
    }
    CHECK(!ever, "Network traffic alone keeps it dark");
}

static void df0_reading_during_network_traffic_shows_steady(void) {
    // The Amiga alternates DF0 (reading a disk, motor on) with DF1 (PaulaNET) every 25 ms.
    led_activity_t a; led_activity_init(&a);
    int dark = 0;
    for (uint32_t t = 0; t < 2000; t++) {
        const bool df0_sel = (t % 50) < 25;
        const bool busy = led_drive_busy(df0_sel, true, false) ||
                          led_drive_busy(!df0_sel, true, led_pnet_track(true, PNET_CYL));
        if (!led_activity_step(&a, t, busy)) dark++;
    }
    CHECK_EQ_INT(dark, 0);
}

static void a_disk_change_poll_never_lights_it(void) {
    // trackdisk selects an idle drive with the motor off every ~2 s to look for a disk.
    led_activity_t a; led_activity_init(&a);
    bool ever = false;
    for (uint32_t t = 0; t < 10000; t++) {
        const bool sel = (t % 2000) < 2;
        ever |= led_activity_step(&a, t, led_drive_busy(sel, false, false));
    }
    CHECK(!ever, "selects with the motor off are not activity");
}

int main(void) {
    RUN(a_drive_is_busy_only_selected_with_its_motor_on);
    RUN(paulanet_cylinders_are_not_disk_activity);
    RUN(dark_until_first_activity);
    RUN(lit_while_busy_and_held_across_short_gaps);
    RUN(a_one_pass_access_is_still_seen);
    RUN(the_ms_clock_wrapping_does_not_stick_it);
    RUN(network_traffic_alone_never_lights_it);
    RUN(df0_reading_during_network_traffic_shows_steady);
    RUN(a_disk_change_poll_never_lights_it);
    return REPORT();
}
