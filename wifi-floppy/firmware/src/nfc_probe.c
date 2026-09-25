#include "nfc_probe.h"
#include "wf_log.h"
#include "pico/stdlib.h"
#include "hardware/i2c.h"
#include <stdio.h>

#define RC522_ADDR     0x28
#define PN532_ADDR     0x24
#define RC522_VERSION  0x37
#define TIMEOUT_US     5000

/** Does anything ACK this address? The same 1-byte read i2c_probe_bus uses. */
static bool present(uint8_t addr) {
    uint8_t discard;
    return i2c_read_timeout_us(i2c1, addr, &discard, 1, false, TIMEOUT_US) >= 0;
}

/** "n bytes: aa bb cc ..." into `out`, for a log line. */
static void hex(char *out, size_t cap, const uint8_t *b, int n) {
    size_t at = (size_t)snprintf(out, cap, "%d bytes:", n);
    for (int i = 0; i < n && at + 4 < cap; i++)
        at += (size_t)snprintf(out + at, cap - at, " %02x", b[i]);
}

static void rc522_version(void) {
    uint8_t reg = RC522_VERSION, v = 0;
    // Register address, then a repeated-start read: the MFRC522's I2C read.
    if (i2c_write_timeout_us(i2c1, RC522_ADDR, &reg, 1, true, TIMEOUT_US) != 1 ||
        i2c_read_timeout_us(i2c1, RC522_ADDR, &v, 1, false, TIMEOUT_US) != 1) {
        wf_logf(WF_INFO, "nfc: 0x28 RC522 VersionReg read failed (not an RC522-style chip?)");
        return;
    }
    const char *what = v == 0x91 ? "NXP MFRC522 v1" : v == 0x92 ? "NXP MFRC522 v2"
                     : v == 0x88 ? "FM17522 (RC522 clone)" : "unknown";
    wf_logf(WF_INFO, "nfc: 0x28 RC522 VersionReg = 0x%02x -- %s", v, what);
}

/**
 * Wait for the PN532's I2C status byte to read 0x01 (ready), then read `n`
 * bytes of which the first is that status byte. Every PN532 I2C read starts
 * with it, which is why the ready poll and the payload read are the same read.
 */
static int pn532_read(uint8_t addr, uint8_t *buf, int n, int wait_ms) {
    for (int t = 0; t < wait_ms; t++) {
        if (i2c_read_timeout_us(i2c1, addr, buf, (size_t)n, false, TIMEOUT_US) == n && buf[0] == 0x01)
            return n;
        sleep_ms(1);
    }
    return -1;
}

static void pn532_firmware(uint8_t addr) {
    // Normal information frame: preamble, start code, LEN=2, LCS, TFI=D4,
    // command 0x02 (GetFirmwareVersion), DCS, postamble.
    static const uint8_t cmd[] = { 0x00, 0x00, 0xFF, 0x02, 0xFE, 0xD4, 0x02, 0x2A, 0x00 };
    uint8_t ack[7], resp[14];
    char line[96];

    if (i2c_write_timeout_us(i2c1, addr, cmd, sizeof cmd, false, TIMEOUT_US) != (int)sizeof cmd) {
        wf_logf(WF_INFO, "nfc: 0x%02x PN532 GetFirmwareVersion: write NAKed", addr);
        return;
    }
    if (pn532_read(addr, ack, sizeof ack, 100) < 0) {
        wf_logf(WF_INFO, "nfc: 0x%02x PN532: no ACK within 100 ms (not a PN532?)", addr);
        return;
    }
    hex(line, sizeof line, ack, sizeof ack);
    wf_logf(WF_INFO, "nfc: 0x%02x PN532 ack %s", addr, line);
    if (pn532_read(addr, resp, sizeof resp, 200) < 0) {
        wf_logf(WF_INFO, "nfc: 0x%02x PN532: ACKed but no response within 200 ms", addr);
        return;
    }
    hex(line, sizeof line, resp, sizeof resp);
    // resp: status, 00 00 FF 06 FA, D5 03, IC, Ver, Rev, Support, DCS, 00
    bool ok = resp[6] == 0xD5 && resp[7] == 0x03;
    wf_logf(WF_INFO, "nfc: 0x%02x PN532 fw %s%s", addr, line,
            ok && resp[8] == 0x32 ? " -- PN532 confirmed" : ok ? " -- PN53x, IC not 0x32" : "");
    if (ok)
        wf_logf(WF_INFO, "nfc: 0x%02x IC 0x%02x firmware %u.%u support 0x%02x",
                addr, resp[8], resp[9], resp[10], resp[11]);
}

void nfc_probe_identify(void) {
    // The boot scan runs ~7 ms after power-on, which may be before a reader has
    // started; give it up to 300 ms to show up before concluding it is absent.
    bool at24 = false, at28 = false;
    for (int t = 0; t < 30 && !at24 && !at28; t++) {
        at24 = present(PN532_ADDR);
        at28 = present(RC522_ADDR);
        if (!at24 && !at28) sleep_ms(10);
    }
    wf_logf(WF_INFO, "nfc: identify -- 0x24 %s, 0x28 %s",
            at24 ? "answers" : "silent", at28 ? "answers" : "silent");
    if (at28) rc522_version();
    if (at24) pn532_firmware(PN532_ADDR);
    if (at28) pn532_firmware(RC522_ADDR);
}
