#include "harness.h"
#include "../src/orig_drive.h"
#include "../src/floppy_io.h"

/*
 * Rev C's original drive (orig_drive.h): the power-on decision, U8's register
 * values, and which select line each of the board's units answers on.
 */

static void no_expander_is_no_drive(void) {
    orig_state_t s = orig_drive_decide(ORIG_MODE_AUTO, false, 0x00);
    CHECK(!s.expander && !s.present && !s.active, "a failed read: rev A/B, or a silent U8 -- no drive");
}

static void auto_with_a_drive_is_active(void) {
    orig_state_t s = orig_drive_decide(ORIG_MODE_AUTO, true, 0xFE);   // IO0 low
    CHECK(s.expander && s.present && s.active, "Auto + DET low: the drive is DF0");
}

static void auto_without_a_drive_is_not(void) {
    orig_state_t s = orig_drive_decide(ORIG_MODE_AUTO, true, 0xFF);   // IO0 high: R37 pulls it up
    CHECK(s.expander && !s.present && !s.active, "Auto, nothing on J5: board DF0 + DF1");
}

static void off_never_activates(void) {
    orig_state_t s = orig_drive_decide(ORIG_MODE_OFF, true, 0xFE);
    CHECK(s.present && !s.active, "Off: the drive is seen but never enabled");
}

static void only_det_counts(void) {
    CHECK(orig_drive_decide(ORIG_MODE_AUTO, true, 0x01).present == false, "IO0 high, the rest low: no drive");
    CHECK(orig_drive_decide(ORIG_MODE_AUTO, true, 0xF0).present == true, "IO0 low, the rest anything: a drive");
}

static void registers_enable_only_io1(void) {
    CHECK_EQ_INT(orig_drive_output_reg(true), 0xFD);
    CHECK_EQ_INT(orig_drive_config_reg(true), 0xFD);   // IO1 an output; IO0 (DET) stays an input
    CHECK_EQ_INT(orig_drive_output_reg(false), 0xFF);
    CHECK_EQ_INT(orig_drive_config_reg(false), 0xFF);  // all inputs: R36 holds DRV_EN_N high
    CHECK((orig_drive_config_reg(true) & ORIG_BIT_DET) != 0, "DET is never made an output");
}

static void wire_words_round_trip(void) {
    orig_mode_t m = ORIG_MODE_OFF;
    CHECK(orig_mode_from_wire("auto", &m) && m == ORIG_MODE_AUTO, "auto");
    CHECK(orig_mode_from_wire("off", &m) && m == ORIG_MODE_OFF, "off");
    m = ORIG_MODE_OFF;
    CHECK(!orig_mode_from_wire("df0", &m) && m == ORIG_MODE_OFF, "unknown word ignored, out untouched");
    CHECK(!orig_mode_from_wire(NULL, &m), "NULL ignored");
    CHECK(strcmp(orig_mode_wire(ORIG_MODE_AUTO), "auto") == 0 && strcmp(orig_mode_wire(ORIG_MODE_OFF), "off") == 0, "wire");
    CHECK(orig_mode_from_byte(1) == ORIG_MODE_OFF && orig_mode_from_byte(0) == ORIG_MODE_AUTO &&
          orig_mode_from_byte(0xFF) == ORIG_MODE_AUTO, "stored byte: only 1 is Off");
}

static void units_keep_their_lines_unless_swapped(void) {
    g_orig_swapped = false;
    CHECK_EQ_INT(orig_unit_line(0), 0); CHECK_EQ_INT(orig_unit_line(1), 1);
    CHECK_EQ_INT(PIN_SEL_OF(0), PIN_SEL0); CHECK_EQ_INT(PIN_SEL_OF(1), PIN_SEL1);
    CHECK(orig_unit_is_df0(0) && !orig_unit_is_df0(1), "unit 0 is DF0");
    CHECK_EQ_INT(orig_lines_to_units(1), 1); CHECK_EQ_INT(orig_lines_to_units(2), 2); CHECK_EQ_INT(orig_lines_to_units(3), 3);
    g_orig_swapped = true;
    CHECK_EQ_INT(PIN_SEL_OF(0), PIN_SEL1); CHECK_EQ_INT(PIN_SEL_OF(1), PIN_SEL0);
    CHECK(!orig_unit_is_df0(0) && !orig_unit_is_df0(1), "the original drive is DF0: no unit is");
    CHECK_EQ_INT(orig_lines_to_units(1), 2); CHECK_EQ_INT(orig_lines_to_units(2), 1); CHECK_EQ_INT(orig_lines_to_units(3), 3);
    CHECK_EQ_INT(orig_lines_to_units(0), 0);
    g_orig_swapped = false;
}

int main(void) {
    RUN(no_expander_is_no_drive);
    RUN(auto_with_a_drive_is_active);
    RUN(auto_without_a_drive_is_not);
    RUN(off_never_activates);
    RUN(only_det_counts);
    RUN(registers_enable_only_io1);
    RUN(wire_words_round_trip);
    RUN(units_keep_their_lines_unless_swapped);
    return REPORT();
}
