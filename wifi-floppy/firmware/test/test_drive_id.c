// The Amiga drive-ID protocol as floppy.pio's drive_id program answers it,
// select by select, through the pure model in src/drive_id.c (HD spec §5.4).
// This model is the REFERENCE: the PIO program is changed only together with
// it. The PIO itself was verified on the bench 2026-09-27 (HANDOFF §3an,
// firmware 1.4.1): DD and HD both boot on Kickstart 3.1.
//
// The phase is the amiga-hddlw PAL's (github.com/schlae/amiga-hddlw,
// pal/amiga-hddlw.pld), a real drive's: a motor-ON select resets the answer,
// and the FIRST motor-off select after it carries bit 31.
#include "harness.h"
#include "../src/drive_id.h"

// What the Amiga samples. The board drives a BSS138 gate, so GPIO HIGH pulls
// the bus line LOW (floppy_io.h, bus_gate.c). /RDY is active low, and the
// Amiga counts a select that finds /RDY low as a 1 bit: a DD drive holds it
// low for all 32 reads, 0xFFFFFFFF.
static int rdy_line(const drive_id_model_t *m) { return drive_id_model_rdy_gpio(m) ? 0 : 1; }
static uint32_t sample(const drive_id_model_t *m) { return rdy_line(m) == 0 ? 1u : 0u; }

// 32 motor-off selects, each sampled, MSB first.
static uint32_t read_32(drive_id_model_t *m) {
    uint32_t id = 0;
    for (int i = 0; i < 32; i++) {
        drive_id_model_select(m, false);
        id = (id << 1) | sample(m);
        drive_id_model_deselect(m);
    }
    return id;
}

// Kickstart's read (the PAL's reading of it): a select with the motor on --
// the reset -- then 32 motor-off selects, sampled from the first.
static uint32_t amiga_reads_id(drive_id_model_t *m) {
    drive_id_model_select(m, true);  drive_id_model_deselect(m);
    return read_32(m);
}

static void the_amiga_reads_hd_and_dd(void) {
    drive_id_model_t m;
    drive_id_model_init(&m, DRIVE_ID_HD);
    CHECK_EQ_INT(amiga_reads_id(&m), DRIVE_ID_HD);
    drive_id_model_init(&m, DRIVE_ID_DD);
    CHECK_EQ_INT(amiga_reads_id(&m), DRIVE_ID_DD);
    // Again after the motor has run with RDY asserted: the motor-on select
    // starts a fresh answer.
    drive_id_model_level(&m, true);
    CHECK_EQ_INT(amiga_reads_id(&m), DRIVE_ID_DD);
}

static void the_first_motor_off_select_carries_bit_31(void) {
    // THE bench finding (2026-09-27, the PAL): whatever the ID, the first
    // motor-off select after a motor-on one answers bit 31, and for both IDs
    // that is asserted -- DD asserts on every motor-off select, HD alternates
    // starting asserted.
    const uint32_t ids[] = { DRIVE_ID_HD, DRIVE_ID_DD };
    for (unsigned k = 0; k < 2; k++) {
        drive_id_model_t m;
        drive_id_model_init(&m, ids[k]);
        drive_id_model_select(&m, true);  drive_id_model_deselect(&m);
        drive_id_model_select(&m, false);
        CHECK(drive_id_model_rdy_gpio(&m), "first motor-off select: RDY asserted (bit 31)");
        drive_id_model_deselect(&m);
        CHECK(!drive_id_model_rdy_gpio(&m), "released on deselect");
        drive_id_model_select(&m, false);
        CHECK_EQ_INT(sample(&m), (ids[k] >> 30) & 1u);
    }
}

static void a_reader_one_select_late_sees_the_old_phase(void) {
    // Pinned so the phase stays visible: skipping the first motor-off select
    // (what 1.4.0 assumed Kickstart did) reads bits 30..0 and then the
    // repeat's bit 31: HD becomes 0x55555555. The PAL, and the bench, say the
    // first motor-off select is sampled.
    drive_id_model_t m;
    drive_id_model_init(&m, DRIVE_ID_HD);
    drive_id_model_select(&m, true);  drive_id_model_deselect(&m);
    drive_id_model_select(&m, false); drive_id_model_deselect(&m);   // not sampled
    CHECK_EQ_INT(read_32(&m), 0x55555555u);
}

static void power_up_needs_no_motor_on_select(void) {
    // The program starts at on_released: power-up counts as "motor was on",
    // so the first motor-off select after it carries bit 31 (cold boot with
    // the HD disk in passed on the bench).
    drive_id_model_t m;
    drive_id_model_init(&m, DRIVE_ID_HD);
    CHECK_EQ_INT(read_32(&m), DRIVE_ID_HD);
    drive_id_model_init(&m, DRIVE_ID_DD);
    CHECK_EQ_INT(read_32(&m), DRIVE_ID_DD);
}

static void a_motor_on_select_mid_answer_resets_it(void) {
    drive_id_model_t m;
    drive_id_model_init(&m, DRIVE_ID_HD);
    drive_id_model_select(&m, true);  drive_id_model_deselect(&m);
    for (int i = 0; i < 5; i++) { drive_id_model_select(&m, false); drive_id_model_deselect(&m); }
    // Five bits in: a motor-on select abandons the answer ...
    CHECK_EQ_INT(amiga_reads_id(&m), DRIVE_ID_HD);
    // ... from any point, including the last bit.
    drive_id_model_select(&m, true);  drive_id_model_deselect(&m);
    for (int i = 0; i < 31; i++) { drive_id_model_select(&m, false); drive_id_model_deselect(&m); }
    CHECK_EQ_INT(amiga_reads_id(&m), DRIVE_ID_HD);
}

static void the_pattern_repeats_while_the_motor_is_off(void) {
    // Kickstart reads the ID again while running (a burst of 49 motor-off
    // selects after track reads, spike). After 32 bits the answer repeats
    // seamlessly, starting again at bit 31.
    drive_id_model_t m;
    drive_id_model_init(&m, DRIVE_ID_HD);
    amiga_reads_id(&m);
    CHECK_EQ_INT(read_32(&m), DRIVE_ID_HD);
    CHECK_EQ_INT(read_32(&m), DRIVE_ID_HD);
    drive_id_model_init(&m, DRIVE_ID_DD);
    amiga_reads_id(&m);
    for (int i = 0; i < 40; i++) {
        drive_id_model_select(&m, false);
        CHECK_EQ_INT(sample(&m), 1u);
        drive_id_model_deselect(&m);
    }
}

static void a_second_burst_after_track_reads_reads_the_same(void) {
    drive_id_model_t m;
    drive_id_model_init(&m, DRIVE_ID_HD);
    drive_id_model_level(&m, true);
    for (int i = 0; i < 20; i++) { drive_id_model_select(&m, true); drive_id_model_deselect(&m); }
    CHECK_EQ_INT(amiga_reads_id(&m), DRIVE_ID_HD);
}

static void motor_on_selected_is_the_cpu_level_and_released_otherwise(void) {
    drive_id_model_t m;
    drive_id_model_init(&m, DRIVE_ID_DD);
    drive_id_model_level(&m, true);
    CHECK(!drive_id_model_rdy_gpio(&m), "deselected: released whatever the CPU wants");
    drive_id_model_select(&m, true);
    CHECK(drive_id_model_rdy_gpio(&m), "motor on, selected: the CPU level");
    drive_id_model_deselect(&m);
    CHECK(!drive_id_model_rdy_gpio(&m), "released on deselect");
    drive_id_model_level(&m, false);
    drive_id_model_select(&m, true);
    CHECK(!drive_id_model_rdy_gpio(&m), "motor on, selected, CPU released: released");
    drive_id_model_deselect(&m);
}

static void an_assert_mid_select_shows_at_once_a_release_waits(void) {
    // The level is driven once per select (`mov pins, x`), not re-driven in a
    // loop. bus_out_set execs `set pins, 1` when RDY is asserted while the
    // machine sits at on_selected's wait, so an assert (the motor spun up)
    // shows at once; a release takes effect at the deselect.
    drive_id_model_t m;
    drive_id_model_init(&m, DRIVE_ID_DD);
    drive_id_model_select(&m, true);
    CHECK(!drive_id_model_rdy_gpio(&m), "selected, CPU released");
    drive_id_model_level(&m, true);
    CHECK(drive_id_model_rdy_gpio(&m), "assert mid-select: at once");
    drive_id_model_level(&m, false);
    CHECK(drive_id_model_rdy_gpio(&m), "release mid-select: waits for the deselect");
    drive_id_model_deselect(&m);
    CHECK(!drive_id_model_rdy_gpio(&m), "released on deselect");
    // Never during a motor-off (ID) select: HD's bit 30 is 0, so an assert
    // that leaked through would show.
    drive_id_model_set_id(&m, DRIVE_ID_HD);
    drive_id_model_select(&m, true);  drive_id_model_deselect(&m);
    drive_id_model_select(&m, false);                                  // bit 31 (1)
    drive_id_model_deselect(&m);
    drive_id_model_select(&m, false);                                  // bit 30 (0)
    CHECK(!drive_id_model_rdy_gpio(&m), "ID select: HD's bit 30 released");
    drive_id_model_level(&m, true);
    CHECK(!drive_id_model_rdy_gpio(&m), "ID select: a CPU assert does not reach RDY");
    drive_id_model_deselect(&m);
    drive_id_model_level(&m, false);
}

static void an_id_change_waits_for_the_next_answer(void) {
    // A swap lands mid-answer: the answer in progress finishes as it began,
    // and the new ID starts at the next load -- the 32-bit repeat, or the
    // next motor-on select -- never mid-answer (HD spec §5.4).
    drive_id_model_t m;
    drive_id_model_init(&m, DRIVE_ID_DD);
    drive_id_model_select(&m, true);  drive_id_model_deselect(&m);
    for (int i = 0; i < 10; i++) {
        drive_id_model_select(&m, false); CHECK_EQ_INT(sample(&m), 1u); drive_id_model_deselect(&m);
    }
    drive_id_model_set_id(&m, DRIVE_ID_HD);
    for (int i = 10; i < 32; i++) {
        drive_id_model_select(&m, false);
        CHECK_EQ_INT(sample(&m), 1u);                                  // still DD's answer
        drive_id_model_deselect(&m);
    }
    drive_id_model_select(&m, false); CHECK_EQ_INT(sample(&m), 1u); drive_id_model_deselect(&m); // HD bit 31
    drive_id_model_select(&m, false); CHECK_EQ_INT(sample(&m), 0u); drive_id_model_deselect(&m); // HD bit 30
    CHECK_EQ_INT(amiga_reads_id(&m), DRIVE_ID_HD);
    drive_id_model_set_id(&m, DRIVE_ID_DD);
    CHECK_EQ_INT(amiga_reads_id(&m), DRIVE_ID_DD);                    // and back
}

// Kickstart 3.1's own read (disk.resource, ROM $FC0442): a motor-on select, a
// motor-off select that is not sampled, then 32 sampled ones. As DF1 on the
// A500's internal connector sees it: that connector carries MTR0D* (DF0's
// motor, latched on the motherboard, HRM p.320), not the raw DSKMOTOR*, so
// DF1's motor-on select arrives as motor-off.
static uint32_t ks31_reads_df1(drive_id_model_t *m) {
    drive_id_model_select(m, false); drive_id_model_deselect(m);    // the motor-on select, seen as off
    drive_id_model_select(m, false); drive_id_model_deselect(m);    // the reset select, not sampled
    return read_32(m);
}

static void df1_a_new_id_needs_a_restart_without_a_visible_motor(void) {
    // Bench 2026-10-13 (fw 1.11.0): Off -> Next or Network live, then ONE warm
    // reset: no DF1; a second reset finds it. Without a visible motor-on
    // select nothing restarts the answer, so the first read runs on the old
    // word's shifter.
    drive_id_model_t m;
    drive_id_model_init(&m, DRIVE_ID_DD);
    drive_id_model_set_id(&m, 0u);                              // parked: ID NONE
    CHECK_EQ_INT(ks31_reads_df1(&m), 0u);                       // the reset after Off: no DF1
    drive_id_model_set_id(&m, DRIVE_ID_DD);                     // switched on live
    CHECK(ks31_reads_df1(&m) != DRIVE_ID_DD, "no restart: the first reset reads the old answer");
    CHECK_EQ_INT(ks31_reads_df1(&m), DRIVE_ID_DD);              // the second reset finds it

    // The fix (bus_out_drive_id_set): an ID change on DF1 restarts the answer.
    drive_id_model_init(&m, DRIVE_ID_DD);
    drive_id_model_set_id(&m, 0u);
    drive_id_model_restart(&m);
    CHECK_EQ_INT(ks31_reads_df1(&m), 0u);
    drive_id_model_set_id(&m, DRIVE_ID_DD);
    drive_id_model_restart(&m);
    CHECK_EQ_INT(ks31_reads_df1(&m), DRIVE_ID_DD);              // the first reset finds it
    drive_id_model_set_id(&m, 0u);
    drive_id_model_restart(&m);
    CHECK_EQ_INT(ks31_reads_df1(&m), 0u);                       // and Off again
}

static void drive_id_for_maps_the_mounted_kind(void) {
    CHECK_EQ_INT(drive_id_for(true), DRIVE_ID_HD);
    CHECK_EQ_INT(drive_id_for(false), DRIVE_ID_DD);
}

int main(void) {
    RUN(the_amiga_reads_hd_and_dd);
    RUN(the_first_motor_off_select_carries_bit_31);
    RUN(a_reader_one_select_late_sees_the_old_phase);
    RUN(power_up_needs_no_motor_on_select);
    RUN(a_motor_on_select_mid_answer_resets_it);
    RUN(the_pattern_repeats_while_the_motor_is_off);
    RUN(a_second_burst_after_track_reads_reads_the_same);
    RUN(motor_on_selected_is_the_cpu_level_and_released_otherwise);
    RUN(an_assert_mid_select_shows_at_once_a_release_waits);
    RUN(an_id_change_waits_for_the_next_answer);
    RUN(df1_a_new_id_needs_a_restart_without_a_visible_motor);
    RUN(drive_id_for_maps_the_mounted_kind);
    return REPORT();
}
