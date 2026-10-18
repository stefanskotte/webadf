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

#endif
