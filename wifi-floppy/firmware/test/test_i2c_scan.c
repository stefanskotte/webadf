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

// The boot's I2C bus clear (UM10204 §3.1.16 "Bus clear"; fix round 1, 2026-10-19), against a line model:
// a device that holds SDA low for some clocks (left mid-byte by a warm reset) and stretches SCL for a while after
// each edge it sees (a PN532 clock-stretches, UM0701-02 §6.3.3.3: ~1-2 ms while it wakes). A stretch is waited out
// for up to I2C_SCL_WAIT_US; only a clock held past that is "held".
typedef struct {
    uint32_t t;              // µs
    bool     drive_scl, drive_sda;   // the master pulling the line low
    int      sda_low_clocks; // the device releases SDA after this many SCL rising edges (-1: never)
    uint32_t stretch_us;     // after each master release of SCL, the device holds it this long (UINT32_MAX: forever)
    uint32_t scl_free_at;    // SCL is the device's until then
    int      rises;
    int      scl_pulses, stops;
} lines_t;
static lines_t L;
static bool l_scl(void *c) { (void)c; return !L.drive_scl && L.t >= L.scl_free_at; }
static bool l_sda(void *c) { (void)c; return !L.drive_sda && !(L.sda_low_clocks < 0 || L.rises < L.sda_low_clocks); }
static void l_set_scl(void *c, bool low) {
    (void)c;
    if (L.drive_scl && !low) {                       // released: the device may stretch from now
        L.scl_free_at = L.stretch_us == UINT32_MAX ? UINT32_MAX : L.t + L.stretch_us;
        L.rises++; L.scl_pulses++;
    }
    L.drive_scl = low;
}
static void l_set_sda(void *c, bool low) {
    (void)c;
    if (L.drive_sda && !low && l_scl(NULL)) L.stops++;   // SDA rising while SCL high: a STOP
    L.drive_sda = low;
}
static void l_delay(void *c, uint32_t us) { (void)c; L.t += us; }
static uint32_t l_now(void *c) { (void)c; return L.t; }
static const i2c_lines_t IO = { l_scl, l_sda, l_set_scl, l_set_sda, l_delay, l_now, NULL };
static void lines(int sda_low_clocks, uint32_t stretch_us, uint32_t initial_stretch_us) {
    memset(&L, 0, sizeof L);
    L.sda_low_clocks = sda_low_clocks;
    L.stretch_us = stretch_us;
    L.scl_free_at = initial_stretch_us == UINT32_MAX ? UINT32_MAX : initial_stretch_us;
}

static void an_idle_bus_is_left_alone(void) {
    lines(0, 0, 0);
    int pulses = -1;
    CHECK_EQ_INT(i2c_bus_clear(&IO, &pulses), I2C_REC_IDLE);
    CHECK_EQ_INT(pulses, 0);
    CHECK_EQ_INT(L.scl_pulses, 0);
}

static void sda_held_low_is_clocked_out_then_stopped(void) {
    lines(3, 0, 0);
    int pulses = -1;
    CHECK_EQ_INT(i2c_bus_clear(&IO, &pulses), I2C_REC_STOP);
    CHECK_EQ_INT(pulses, 3);
    CHECK_EQ_INT(L.stops, 1);
    CHECK(l_sda(NULL) && l_scl(NULL), "both lines released at the end");
    lines(-1, 0, 0);                                   // never lets go
    CHECK_EQ_INT(i2c_bus_clear(&IO, &pulses), I2C_REC_STUCK);
    CHECK_EQ_INT(pulses, 9);
}

// The review's I1: a stretch longer than one ~10 µs sample is a stretch, not a held clock.
static void a_clock_stretch_is_waited_out_not_called_held(void) {
    int pulses = -1;
    lines(0, 0, 3000);                                 // stretching for 3 ms when the board looks
    CHECK_EQ_INT(i2c_bus_clear(&IO, &pulses), I2C_REC_IDLE);
    lines(2, 2000, 1500);                              // and 2 ms after every pulse, SDA low for two
    CHECK_EQ_INT(i2c_bus_clear(&IO, &pulses), I2C_REC_STOP);
    CHECK_EQ_INT(pulses, 2);
    lines(0, 0, I2C_SCL_WAIT_US - 100);                // just inside the wait
    CHECK_EQ_INT(i2c_bus_clear(&IO, &pulses), I2C_REC_IDLE);
}

static void a_clock_held_past_the_wait_is_held_and_bounded(void) {
    int pulses = -1;
    lines(0, 0, UINT32_MAX);
    CHECK_EQ_INT(i2c_bus_clear(&IO, &pulses), I2C_REC_SCL_HELD);
    CHECK(L.t >= I2C_SCL_WAIT_US && L.t <= I2C_SCL_WAIT_US + 1000, "gave up after the wait, not before, not long after");
    lines(-1, UINT32_MAX, 0);                          // free at first, then held after the first pulse
    CHECK_EQ_INT(i2c_bus_clear(&IO, &pulses), I2C_REC_SCL_HELD);
    CHECK_EQ_INT(pulses, 1);
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
    RUN(an_idle_bus_is_left_alone);
    RUN(sda_held_low_is_clocked_out_then_stopped);
    RUN(a_clock_stretch_is_waited_out_not_called_held);
    RUN(a_clock_held_past_the_wait_is_held_and_bounded);
    return REPORT();
}
