#include "harness.h"
#include "../src/df1_live.h"

// OFF (machines disabled) -> NEXT: an empty, write-protected DD drive, and
// the machines start only after the ID and lines are set.
static void switching_on_answers_dd_with_an_empty_drive(void) {
    const df1_live_t p = df1_live_apply(DF1_MODE_NEXT, false);
    CHECK(p.set_id, "the ID is written");
    CHECK_EQ_INT(p.id, DRIVE_ID_KIND_DD);
    CHECK(p.lines, "WPROT and TRK0");
    CHECK(p.eject, "empty: CHNG asserted, RDY released");
    CHECK(p.enable, "the machines start");
    CHECK(p.rescan, "a disk core1 already handed over is inserted");
    CHECK(!p.parked, "on, not parked");
}

// NEXT -> OFF while running: PARKED -- the machines keep running, so CHNG
// stays asserted (a released CHNG reads as a disk: a phantom).
static void switching_off_while_on_parks_and_never_disables(void) {
    const df1_live_t p = df1_live_apply(DF1_MODE_OFF, true);
    CHECK(p.parked, "parked");
    CHECK(p.set_id, "the ID is written");
    CHECK_EQ_INT(p.id, DRIVE_ID_KIND_NONE);
    CHECK(p.eject, "CHNG asserted, RDY released");
    CHECK(p.unmount, "DF1's stream stops");
    CHECK(!p.enable, "nothing is enabled");
    CHECK(!p.rescan, "no disk is looked for");
}

// Parked -> NEXT: back on; the machines already run (enable is a no-op).
static void switching_on_from_parked_answers_dd_again(void) {
    const df1_live_t p = df1_live_apply(DF1_MODE_NEXT, true);
    CHECK_EQ_INT(p.id, DRIVE_ID_KIND_DD);
    CHECK(p.enable && p.eject && p.lines && p.rescan, "as from off");
    CHECK(!p.parked, "on");
}

// OFF at boot, OFF again (a re-sent setting): an absent drive stays absent --
// nothing enabled, no line, no ID write.
static void off_while_off_does_nothing(void) {
    const df1_live_t p = df1_live_apply(DF1_MODE_OFF, false);
    CHECK(!p.set_id && !p.lines && !p.eject && !p.unmount && !p.enable && !p.rescan,
          "nothing at all");
    CHECK(!p.parked, "not parked: the machines are not running");
}

// Parked, OFF again: stays parked (idempotent, never disabled).
static void off_while_parked_stays_parked(void) {
    const df1_live_t p = df1_live_apply(DF1_MODE_OFF, true);
    CHECK(p.parked && !p.enable, "parked");
    CHECK_EQ_INT(p.id, DRIVE_ID_KIND_NONE);
}

static void the_step_isr_moves_df1_while_its_machines_run(void) {
    CHECK_EQ_INT(df1_serving_mask(2, true), 3);    // on or parked: DF1's head moves
    CHECK_EQ_INT(df1_serving_mask(2, false), 1);   // off: SEL1 steps are telemetry
    CHECK_EQ_INT(df1_serving_mask(1, true), 1);    // a one-drive build has no DF1
    CHECK_EQ_INT(df1_serving_mask(1, false), 1);
}

int main(void) {
    RUN(switching_on_answers_dd_with_an_empty_drive);
    RUN(switching_off_while_on_parks_and_never_disables);
    RUN(switching_on_from_parked_answers_dd_again);
    RUN(off_while_off_does_nothing);
    RUN(off_while_parked_stays_parked);
    RUN(the_step_isr_moves_df1_while_its_machines_run);
    return REPORT();
}
