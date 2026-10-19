#ifndef I2C_SCAN_H
#define I2C_SCAN_H
// What the boot I2C scan (i2c_probe.c) found, kept for the status report
// (device_client.c "i2c"), so a remote board's "no NFC reader" can be read
// from the server instead of a USB log: nothing on the bus, a panel only, or
// a reader on an address this firmware does not drive.
//
// RULE: pure C, host-tested (test/test_i2c_scan.c). Boot scan only -- nothing
// rescans: the OLED and the tag reader share i2c1, and a scan between their
// transfers is exactly the disturbance this record must not cost.
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Bounded: a board has two or three devices at most, and a bus with no
// pull-ups can "answer" at every address -- eight are kept, the rest dropped.
// The server accepts at most eight too (src/app/api/device/status/route.ts).
#define I2C_SCAN_MAX 8
// ,"i2c":[ + eight three-digit numbers + seven commas + ] = 8 + 24 + 7 + 1.
#define I2C_SCAN_JSON_MAX 40

typedef struct i2c_scan {
    uint8_t addr[I2C_SCAN_MAX];
    uint8_t n;
    bool    done;   // the scan finished: an empty list then means "nothing answered"
    bool    held;   // fix round 1: SCL was held low, the scan was skipped and i2c1 never set up this boot
} i2c_scan_t;

// Records one responder. Reserved addresses (outside 0x08..0x77) and any past
// the eighth are ignored.
void i2c_scan_add(i2c_scan_t *s, uint8_t addr);
// The scan finished; from now on the record is reported, even when empty.
void i2c_scan_done(i2c_scan_t *s);
// Whether the finished scan saw `addr` (false before i2c_scan_done, and for a
// NULL record). fw 1.18.0 looks for a PN532 at 0x24 only if this says so.
bool i2c_scan_has(const i2c_scan_t *s, uint8_t addr);
// Writes ,"i2c":[40,60] (decimal JSON numbers, scan order) into out, or ""
// before i2c_scan_done or when out cannot hold the whole key. Returns the
// length written (0 for "").
int i2c_scan_json(const i2c_scan_t *s, char *out, size_t cap);

// The boot's I2C bus clear (UM10204 §3.1.16; 2026-10-19), one decision per look at the lines: a device that was
// mid-byte when the RP2350 reset (a warm reset does not reset the PN532 or the panel) can hold SDA low for good,
// and the boot scan then sees nothing -- or, with the SDK's TX-FIFO wait that has no timeout (i2c.c,
// i2c_read_blocking_internal: `while (!i2c_get_write_available(i2c))`), never returns. The fix: up to nine SCL
// pulses until SDA is released, then a STOP. `pulses` = pulses sent so far.
typedef enum {
    I2C_REC_IDLE,      // both lines high: nothing to do
    I2C_REC_CLOCK,     // SDA low: send one more SCL pulse
    I2C_REC_STOP,      // SDA released after pulses: send a STOP, done
    I2C_REC_STUCK,     // SDA still low after nine pulses: give up (the scan's timeouts are what is left)
    I2C_REC_SCL_HELD,  // SCL low: a device stretching the clock for good -- the master cannot clock it
} i2c_rec_t;
i2c_rec_t i2c_recover_action(bool sda_high, bool scl_high, int pulses);

// The whole bus clear over two open-drain lines (i2c_probe.c gives it the GPIO pads; the host tests a line
// model). Fix round 1: SCL low is first WAITED for -- a PN532 stretches the clock (~1-2 ms while it wakes,
// UM0701-02 §6.3.3.3) -- up to I2C_SCL_WAIT_US, before the bus counts as held; the same after every pulse. A
// clock held past that is I2C_REC_SCL_HELD. Bounded: 10 waits at most, ~0.3 s worst case. *pulses_out = pulses.
#define I2C_SCL_WAIT_US 25000u
typedef struct {
    bool     (*scl)(void *ctx);                // true = high
    bool     (*sda)(void *ctx);
    void     (*set_scl)(void *ctx, bool low);  // true: drive low; false: release (pulled up)
    void     (*set_sda)(void *ctx, bool low);
    void     (*delay_us)(void *ctx, uint32_t us);
    uint32_t (*now_us)(void *ctx);
    void     *ctx;
} i2c_lines_t;
i2c_rec_t i2c_bus_clear(const i2c_lines_t *io, int *pulses_out);

#endif
