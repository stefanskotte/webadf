#include "harness.h"
#include "../src/i2c_scan.h"

/*
 * The boot I2C scan's record (i2c_scan.h): the addresses that answered, kept
 * so the status report can tell the server what is on the bus -- a remote
 * "no NFC reader" is then diagnosable without a USB log.
 */

static void a_fresh_record_says_nothing(void) {
    static i2c_scan_t s;
    char out[64] = "x";
    CHECK_EQ_INT(i2c_scan_json(&s, out, sizeof out), 0);
    CHECK(strcmp(out, "") == 0, "no scan ran: no key at all (the server keeps null)");
}

static void an_empty_bus_is_an_empty_list(void) {
    static i2c_scan_t s;
    i2c_scan_done(&s);
    char out[64];
    i2c_scan_json(&s, out, sizeof out);
    CHECK(strcmp(out, ",\"i2c\":[]") == 0, "a scan that found nothing says so -- both values of a state");
}

static void addresses_are_kept_in_order_as_decimal(void) {
    static i2c_scan_t s;
    i2c_scan_add(&s, 0x28);
    i2c_scan_add(&s, 0x3c);
    i2c_scan_done(&s);
    char out[64];
    i2c_scan_json(&s, out, sizeof out);
    CHECK(strcmp(out, ",\"i2c\":[40,60]") == 0, "JSON numbers, scan order");
    CHECK_EQ_INT(s.n, 2);
}

static void reserved_addresses_are_never_recorded(void) {
    static i2c_scan_t s;
    i2c_scan_add(&s, 0x07);
    i2c_scan_add(&s, 0x78);
    i2c_scan_add(&s, 0xff);
    i2c_scan_add(&s, 0x08);
    i2c_scan_add(&s, 0x77);
    CHECK_EQ_INT(s.n, 2);
    CHECK_EQ_INT(s.addr[0], 0x08);
    CHECK_EQ_INT(s.addr[1], 0x77);
}

static void the_list_is_bounded_at_eight(void) {
    static i2c_scan_t s;
    for (uint8_t a = 0x08; a <= 0x77; a++) i2c_scan_add(&s, a);   // a floating bus answers everywhere
    i2c_scan_done(&s);
    CHECK_EQ_INT(s.n, I2C_SCAN_MAX);
    CHECK_EQ_INT(I2C_SCAN_MAX, 8);
    CHECK_EQ_INT(s.addr[7], 0x0f);
    char out[64];
    i2c_scan_json(&s, out, sizeof out);
    CHECK(strcmp(out, ",\"i2c\":[8,9,10,11,12,13,14,15]") == 0, "the first eight, no more");
}

static void the_longest_list_fits_its_bound(void) {
    static i2c_scan_t s;
    for (uint8_t a = 0x70; a <= 0x77; a++) i2c_scan_add(&s, a);   // eight three-digit numbers
    i2c_scan_done(&s);
    char out[I2C_SCAN_JSON_MAX + 1];
    const int n = i2c_scan_json(&s, out, sizeof out);
    CHECK(strcmp(out, ",\"i2c\":[112,113,114,115,116,117,118,119]") == 0, "whole");
    CHECK_EQ_INT(n, I2C_SCAN_JSON_MAX);
}

static void a_short_buffer_writes_nothing(void) {
    static i2c_scan_t s;
    i2c_scan_add(&s, 0x28);
    i2c_scan_done(&s);
    char out[8] = "x";
    CHECK_EQ_INT(i2c_scan_json(&s, out, sizeof out), 0);
    CHECK(strcmp(out, "") == 0, "never a cut-off key: invalid JSON would lose the whole report");
}

// fw 1.18.0: the PN532 at 0x24 is looked for only if the boot scan saw it
// (nfc_reader.h nfc_attach_pn532) -- never a frame written to whatever else
// lives at 0x24 (an MCP23017 or PCF8574 expander).
static void has_answers_only_for_a_finished_scan_that_saw_the_address(void) {
    i2c_scan_t s = {0};
    i2c_scan_add(&s, 0x24);
    CHECK(!i2c_scan_has(&s, 0x24), "not before the scan is done");
    i2c_scan_add(&s, 0x3c);
    i2c_scan_done(&s);
    CHECK(i2c_scan_has(&s, 0x24), "0x24 seen");
    CHECK(i2c_scan_has(&s, 0x3c), "0x3c seen");
    CHECK(!i2c_scan_has(&s, 0x28), "0x28 not seen");
    CHECK(!i2c_scan_has(NULL, 0x24), "no record");
}

// The I2C bus recovery's decision (UM10204 §3.1.16 "Bus clear"): a device holding SDA low after a warm reset --
// mid-byte when the RP2350 reset -- is clocked out with up to nine SCL pulses, then a STOP. SCL held low is a
// device clock-stretching for good: nothing the master can clock, so the boot scan is skipped rather than run.
static void the_bus_recovery_clocks_until_sda_is_released(void) {
    // Idle bus: nothing to do.
    CHECK_EQ_INT(i2c_recover_action(true, true, 0), I2C_REC_IDLE);
    // SDA low: clock, up to nine times.
    for (int k = 0; k < 9; k++) CHECK_EQ_INT(i2c_recover_action(false, true, k), I2C_REC_CLOCK);
    // Released after some pulses: STOP and done.
    CHECK_EQ_INT(i2c_recover_action(true, true, 3), I2C_REC_STOP);
    // Still low after nine: stuck; give up (the scan's timeouts and the controller reset then cover it).
    CHECK_EQ_INT(i2c_recover_action(false, true, 9), I2C_REC_STUCK);
    // SCL low: a clock held by a device. Not ours to clock.
    CHECK_EQ_INT(i2c_recover_action(true, false, 0), I2C_REC_SCL_HELD);
    CHECK_EQ_INT(i2c_recover_action(false, false, 4), I2C_REC_SCL_HELD);
}

int main(void) {
    RUN(has_answers_only_for_a_finished_scan_that_saw_the_address);
    RUN(a_fresh_record_says_nothing);
    RUN(an_empty_bus_is_an_empty_list);
    RUN(addresses_are_kept_in_order_as_decimal);
    RUN(reserved_addresses_are_never_recorded);
    RUN(the_list_is_bounded_at_eight);
    RUN(the_longest_list_fits_its_bound);
    RUN(a_short_buffer_writes_nothing);
    RUN(the_bus_recovery_clocks_until_sda_is_released);
    return REPORT();
}
