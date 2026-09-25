#include "nfc_probe.h"
#include "wf_log.h"
#include "fw_rom.h"
#include "pico/stdlib.h"
#include "hardware/i2c.h"
#include <stdio.h>
#include <string.h>

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

// ---- RC522 register access over I2C: [reg, value] to write; [reg] then a
// repeated-start read to read. Registers are MFRC522 datasheet §9.
static bool rc_w(uint8_t reg, uint8_t v) {
    uint8_t b[2] = { reg, v };
    return i2c_write_timeout_us(i2c1, RC522_ADDR, b, 2, false, TIMEOUT_US) == 2;
}
static int rc_r(uint8_t reg) {
    uint8_t v;
    if (i2c_write_timeout_us(i2c1, RC522_ADDR, &reg, 1, true, TIMEOUT_US) != 1 ||
        i2c_read_timeout_us(i2c1, RC522_ADDR, &v, 1, false, TIMEOUT_US) != 1) return -1;
    return v;
}
static void rc_set(uint8_t reg, uint8_t mask) { int v = rc_r(reg); if (v >= 0) rc_w(reg, (uint8_t)(v | mask)); }
static void rc_clr(uint8_t reg, uint8_t mask) { int v = rc_r(reg); if (v >= 0) rc_w(reg, (uint8_t)(v & ~mask)); }

enum { CommandReg = 0x01, ComIEnReg = 0x02, ComIrqReg = 0x04, ErrorReg = 0x06,
       FIFODataReg = 0x09, FIFOLevelReg = 0x0A, ControlReg = 0x0C, BitFramingReg = 0x0D,
       CollReg = 0x0E, Status2Reg = 0x08, ModeReg = 0x11, TxModeReg = 0x12, RxModeReg = 0x13,
       TxControlReg = 0x14, TxASKReg = 0x15, ModWidthReg = 0x24,
       RFCfgReg = 0x26, GsNReg = 0x27, CWGsPReg = 0x28, ModGsPReg = 0x29,
       TModeReg = 0x2A, TPrescalerReg = 0x2B, TReloadRegH = 0x2C, TReloadRegL = 0x2D };

/**
 * After a soft reset, do the registers hold the MFRC522 datasheet's reset
 * values? The version byte is only a label; a matching register map is what
 * says a driver written for the RC522 will work on this chip.
 */
static void rc522_reset_check(void) {
    static const struct { uint8_t reg, want; const char *name; } k[] = {
        { CommandReg, 0x20, "Command" }, { ComIEnReg, 0x80, "ComIEn" },
        { ModeReg, 0x3F, "Mode" },       { TxControlReg, 0x80, "TxControl" },
        { RFCfgReg, 0x48, "RFCfg" },     { GsNReg, 0x88, "GsN" },
        { CWGsPReg, 0x20, "CWGsP" },     { ModGsPReg, 0x20, "ModGsP" },
    };
    rc_w(CommandReg, 0x0F);                       // SoftReset
    sleep_ms(50);
    for (int t = 0; t < 50 && (rc_r(CommandReg) & 0x10); t++) sleep_ms(1);   // PowerDown clears
    int match = 0;
    for (unsigned i = 0; i < sizeof k / sizeof k[0]; i++) {
        int v = rc_r(k[i].reg);
        if (v == k[i].want) match++;
        else wf_logf(WF_INFO, "nfc: reset %s (0x%02x) = %s0x%02x, datasheet 0x%02x",
                     k[i].name, k[i].reg, v < 0 ? "READ FAILED " : "", v < 0 ? 0 : v, k[i].want);
    }
    wf_logf(WF_INFO, "nfc: RC522 reset values: %d of %u match the datasheet",
            match, (unsigned)(sizeof k / sizeof k[0]));
}

/**
 * One Transceive: send `n` bytes (the last one `last_bits` long, 0 = whole),
 * receive into `out`. Returns bytes received, or -1 (timeout / no card) or -2
 * (protocol error; ErrorReg logged by the caller if it cares).
 */
static int g_last_err = 0;

static int rc_transceive(const uint8_t *tx, int n, uint8_t last_bits, uint8_t *out, int cap) {
    rc_w(CommandReg, 0x00);                        // Idle
    rc_w(ComIrqReg, 0x7F);                         // clear every IRQ bit
    rc_w(FIFOLevelReg, 0x80);                      // flush
    for (int i = 0; i < n; i++) rc_w(FIFODataReg, tx[i]);
    rc_w(BitFramingReg, last_bits);
    rc_w(CommandReg, 0x0C);                        // Transceive
    rc_set(BitFramingReg, 0x80);                   // StartSend
    int irq = 0;
    for (int t = 0; t < 40; t++) {                 // the chip's own timer fires at ~25 ms
        irq = rc_r(ComIrqReg);
        if (irq < 0) return -2;
        if (irq & 0x30) break;                     // RxIRq | IdleIRq
        if (irq & 0x01) return -1;                 // TimerIRq: nobody answered
        sleep_ms(1);
    }
    rc_clr(BitFramingReg, 0x80);
    if (!(irq & 0x30)) return -1;
    int err = rc_r(ErrorReg);
    // The vendor's mask (SI512_App.c PcdComMF522): BufferOvfl | CollErr |
    // ParityErr | ProtocolErr.
    if (err < 0 || (err & 0x1B)) { g_last_err = err; return -2; }
    int got = rc_r(FIFOLevelReg);
    if (got < 0) return -2;
    if (got > cap) got = cap;
    for (int i = 0; i < got; i++) out[i] = (uint8_t)rc_r(FIFODataReg);
    return got;
}

/**
 * For `seconds`, look for a tag and log each one that arrives: ATQA (the tag
 * type), and the cascade-level-1 UID with its BCC checked. Bench only -- it
 * blocks core0's init for the whole window, before the drive is serving.
 */
static void rc522_watch_cards(int seconds) {
    // The vendor's reader init, line for line (SI512_App.c
    // PCD_SI512_TypeA_Init). The FIRST line is the one an RC522 driver does
    // not have: the Si512 is a PN512-style part that can also be a CARD, and
    // until ControlReg's Initiator bit is set it is not a reader at all --
    // the first tag watch saw nothing, twice, without it.
    rc_w(ControlReg, 0x10);                               // Initiator
    rc_clr(Status2Reg, 0x08);                             // MFCrypto1On off
    rc_w(TxModeReg, 0x00); rc_w(RxModeReg, 0x00);         // 106 kbit, ISO 14443A framing
    rc_w(ModWidthReg, 0x26);
    rc_w(RFCfgReg, 0x68);                                 // RxGain 43 dB (vendor RFCfgReg_Val)
    rc_w(TModeReg, 0x80); rc_w(TPrescalerReg, 0xA9);     // ~25 ms timer, auto-start
    rc_w(TReloadRegH, 0x03); rc_w(TReloadRegL, 0xE8);
    rc_w(TxASKReg, 0x40);                                 // 100 % ASK
    rc_w(ModeReg, 0x3D);                                  // CRC preset 0x6363
    rc_w(CommandReg, 0x00);                               // receiver analog part on
    rc_set(TxControlReg, 0x03);                           // antenna on
    wf_logf(WF_INFO, "nfc: init readback Control 0x%02x TxControl 0x%02x Command 0x%02x",
            rc_r(ControlReg), rc_r(TxControlReg), rc_r(CommandReg));
    wf_logf(WF_INFO, "nfc: antenna on -- hold a tag on the reader now (%d s)", seconds);

    uint8_t last[5] = {0}; bool present = false; int seen = 0;
    int tries = 0, timeouts = 0, errors = 0;
    absolute_time_t end = make_timeout_time_ms((uint32_t)seconds * 1000u);
    while (!time_reached(end)) {
        uint8_t atqa[2], uid[5];
        rc_clr(CollReg, 0x80);
        uint8_t wupa = 0x52;                              // WUPA: wakes IDLE and HALT tags
        int n = rc_transceive(&wupa, 1, 0x07, atqa, sizeof atqa);
        tries++;
        if (n == -1) timeouts++;
        else if (n < 0) errors++;
        if (n == 2) {
            static const uint8_t anticoll[2] = { 0x93, 0x20 };
            int m = rc_transceive(anticoll, 2, 0x00, uid, sizeof uid);
            bool bcc = m == 5 && (uid[0] ^ uid[1] ^ uid[2] ^ uid[3]) == uid[4];
            if (m == 5 && (!present || memcmp(uid, last, 5) != 0)) {
                wf_logf(WF_INFO, "nfc: TAG ATQA %02x %02x  UID %02x %02x %02x %02x  BCC %s%s",
                        atqa[0], atqa[1], uid[0], uid[1], uid[2], uid[3], bcc ? "ok" : "BAD",
                        uid[0] == 0x88 ? "  (0x88 = cascade tag: a 7-byte UID, NTAG/Ultralight)" : "");
                memcpy(last, uid, 5); seen++;
            } else if (m != 5 && !present) {
                wf_logf(WF_INFO, "nfc: tag answered WUPA (ATQA %02x %02x) but anticollision gave %d",
                        atqa[0], atqa[1], m);
            }
            present = true;
        } else if (present) {
            wf_logf(WF_INFO, "nfc: tag removed");
            present = false;
        }
        // Field off and on: sends every tag back to IDLE, so the next WUPA is a
        // fresh detection rather than a tag stuck in READY from the last round.
        rc_clr(TxControlReg, 0x03); sleep_ms(10); rc_set(TxControlReg, 0x03);
        sleep_ms(100);
    }
    rc_clr(TxControlReg, 0x03);
    wf_logf(WF_INFO, "nfc: antenna off -- %d tag arrival(s) seen; %d WUPA tries: %d timeouts, "
            "%d errors (last ErrorReg 0x%02x)", seen, tries, timeouts, errors, g_last_err);
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
    if (at24) pn532_firmware(PN532_ADDR);
    if (at28) {
        rc522_version();
        rc522_reset_check();
        // NEVER on a trial boot: the boot ROM gives a freshly installed image
        // a deadline (~16 s) to prove itself, and 20 s spent here would miss
        // it and revert the board to its other slot. The confirmed boot that
        // follows a proven trial runs it instead.
        if (fw_rom_trial_boot())
            wf_logf(WF_INFO, "nfc: trial boot -- tag watch skipped; it runs on the confirmed boot");
        else
            rc522_watch_cards(20);
    }
}
