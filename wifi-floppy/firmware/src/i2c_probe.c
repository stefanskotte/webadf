#include "i2c_probe.h"
#include "floppy_io.h"
#include "wf_log.h"
#include "pico/stdlib.h"
#include "hardware/i2c.h"

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

int i2c_probe_bus(void) {
    i2c_init(i2c1, PROBE_HZ);
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
        if (i2c_read_timeout_us(i2c1, a, &discard, 1, false, PROBE_TIMEOUT_US) >= 0) {
            wf_logf(WF_INFO, "i2c1: device at 0x%02x%s", a, known(a));
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
    return found;
}
