#include "i2c_probe.h"
#include "floppy_io.h"
#include "wf_log.h"
#include "pico/stdlib.h"
#include "hardware/i2c.h"
#include "board_hw.h"

// 100 kHz, not 400: this runs once at boot over hand-wired Dupont leads, where
// signal integrity is whatever the wires happen to give. The slow rate is the
// one that answers "is it connected", which is the only question here.
#define PROBE_HZ        100000
// A present device ACKs its address immediately; an absent one NAKs, which the
// SDK reports as an error without waiting. The timeout only matters for a bus
// held low by bad wiring -- without it, one shorted lead hangs boot forever.
#define PROBE_TIMEOUT_US 2000

// 0x00-0x07 and 0x78-0x7f are reserved by the I2C spec and must not be probed.
#define ADDR_FIRST 0x08
#define ADDR_LAST  0x77

/** Panels this project is likely to meet, named so a bare number is not the
 *  whole answer. Not exhaustive and not authoritative -- an unrecognised
 *  address is reported plainly rather than guessed at. */
static const char *known(uint8_t addr) {
    if (addr == 0x3c || addr == 0x3d) return " — SSD1306/SH1106 OLED";
    return "";
}

// The bus clear (i2c_scan.h i2c_bus_clear; UM10204 §3.1.16), bit-banged on the two pads before the I2C block
// owns them. Open-drain by hand: a line is driven low (output 0) or released (input, pulled up), never driven high.
// HYPOTHESIS, not measured (2026-10-19): a PN532 left mid-byte by a warm reset holds SDA low, and the boot scan
// then never finds it -- or wedges in the SDK's untimed FIFO wait.
static bool     io_scl(void *c) { (void)c; return gpio_get(PIN_I2C_SCL); }
static bool     io_sda(void *c) { (void)c; return gpio_get(PIN_I2C_SDA); }
static void     io_line(uint pin, bool low) { if (low) { gpio_set_dir(pin, GPIO_OUT); gpio_put(pin, 0); } else gpio_set_dir(pin, GPIO_IN); }
static void     io_set_scl(void *c, bool low) { (void)c; io_line(PIN_I2C_SCL, low); }
static void     io_set_sda(void *c, bool low) { (void)c; io_line(PIN_I2C_SDA, low); }
static void     io_delay(void *c, uint32_t us) { (void)c; sleep_us(us); }
static uint32_t io_now(void *c) { (void)c; return time_us_32(); }

static i2c_rec_t bus_clear(int *pulses_out) {
    gpio_init(PIN_I2C_SDA); gpio_init(PIN_I2C_SCL);   // SIO, input, output latch 0
    gpio_pull_up(PIN_I2C_SDA); gpio_pull_up(PIN_I2C_SCL);
    const i2c_lines_t io = { io_scl, io_sda, io_set_scl, io_set_sda, io_delay, io_now, NULL };
    return i2c_bus_clear(&io, pulses_out);
}

int i2c_probe_bus(uint8_t *panel_addr, i2c_scan_t *scan) {
    uint8_t panel = 0;
    int pulses = 0;
    const i2c_rec_t rec = bus_clear(&pulses);
    if (rec == I2C_REC_STOP)
        wf_logf(WF_WARN, "i2c1: SDA was held low -- released after %d clock(s) and a STOP", pulses);
    else if (rec == I2C_REC_STUCK)
        wf_logf(WF_ERR, "i2c1: SDA held low through 9 clocks -- the bus is stuck");
    else if (rec == I2C_REC_SCL_HELD) {
        // A device holding SCL past I2C_SCL_WAIT_US: every transfer would queue in a controller that cannot run
        // it, and enough of them wedge the SDK's untimed FIFO wait. So the I2C block is never set up this boot
        // (i2c_init is not called, the pads stay GPIO inputs): the scan is skipped (done, empty, held), main.c turns
        // the reader off for the boot (nfc_disable), and with no panel address nothing draws.
        wf_logf(WF_ERR, "i2c1: SCL held low on GP%d past %u ms -- no I2C this boot, display and NFC off "
                        "(power-cycle the board)", PIN_I2C_SCL, (unsigned)(I2C_SCL_WAIT_US / 1000u));
        if (scan) { scan->held = true; i2c_scan_done(scan); }
        if (panel_addr) *panel_addr = 0;
        return 0;
    }
    i2c_init(board_i2c(), PROBE_HZ);
    gpio_set_function(PIN_I2C_SDA, GPIO_FUNC_I2C);
    gpio_set_function(PIN_I2C_SCL, GPIO_FUNC_I2C);
    // Internal pull-ups are weak (~50k) and a real module brings its own
    // (~4.7k), which simply wins. They are enabled anyway so that a bus with
    // NOTHING on it idles high and every address NAKs quickly, instead of
    // floating and reporting phantom devices.
    gpio_pull_up(PIN_I2C_SDA);
    gpio_pull_up(PIN_I2C_SCL);

    int found = 0;
    for (uint8_t a = ADDR_FIRST; a <= ADDR_LAST; a++) {
        uint8_t discard;
        // A 1-byte read is the standard probe: it is the address phase that
        // answers, and the byte itself is thrown away.
        const int rc = i2c_read_timeout_us(board_i2c(), a, &discard, 1, false, PROBE_TIMEOUT_US);
        if (rc == PICO_ERROR_TIMEOUT) {
            // A timeout leaves the transfer queued in the controller (the SDK does not abort it). Sixteen of them
            // fill the TX FIFO, and the next read's `while (!i2c_get_write_available(i2c))` -- no timeout --
            // never returns: the boot hangs here. i2c_init resets the block, FIFO and all.
            i2c_init(board_i2c(), PROBE_HZ);
            continue;
        }
        if (rc >= 0) {
            wf_logf(WF_INFO, "i2c1: device at 0x%02x%s", a, known(a));
            if (panel == 0 && (a == 0x3c || a == 0x3d)) panel = a;
            if (scan) i2c_scan_add(scan, a);
            found++;
        }
    }

    if (found == 0) {
        // Says where it looked, because the commonest cause of nothing is a
        // lead on the wrong header pin, and the pin numbers are the thing a
        // person needs in front of them at that moment.
        wf_logf(WF_INFO, "i2c1: nothing on GP%d/GP%d (header pins 24/25) — "
                "check SDA/SCL, 3V3 on pin 36, GND on pin 23",
                PIN_I2C_SDA, PIN_I2C_SCL);
    }
    if (scan) i2c_scan_done(scan);
    if (panel_addr) *panel_addr = panel;
    return found;
}
