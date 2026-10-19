#include "harness.h"
#include "../src/boot_trail.h"

// The boot trail (2026-10-19): where the previous boot got to, and why it ended -- so a hang shows up on the next
// boot without a serial cable. Pure here; the registers are boot_trail_hw.c's.

static void a_word_holds_its_stage_and_seconds(void) {
    uint32_t w = bt_word(BT0_I2C, 12345);
    int st = -1; uint32_t up = 0;
    CHECK(bt_word_read(w, &st, &up), "a word with the magic reads back");
    CHECK_EQ_INT(st, BT0_I2C);
    CHECK_EQ_INT(up, 12);                               // seconds, rounded down
    CHECK(!bt_word_read(0, &st, &up), "zero (a power-up's scratch) is no record");
    CHECK(!bt_word_read(0x12000301u, &st, &up), "a stray value without the magic is no record");
    CHECK(!bt_word_read(bt_word(BT0_I2C, 0) | (0x7Fu << 16), &st, &up), "a stage past the last is no record");
    CHECK(bt_word_read(bt_word(BT1_LOOP, 0xFFFFFFFFu), &st, &up), "a long uptime");
    CHECK_EQ_INT(up, 0xFFFF);                           // saturates at ~18 h, never wraps to a small number
}

static void the_reset_reason_comes_from_the_chip_and_the_trail(void) {
    const uint32_t w_i2c = bt_word(BT0_I2C, 2000), w_reboot = bt_word(BT0_REBOOT, 9000);
    CHECK_EQ_INT(bt_reset_reason(BT_HAD_POR, 0, 0), BT_RESET_POWER_ON);
    CHECK_EQ_INT(bt_reset_reason(BT_HAD_BOR, 0, 0), BT_RESET_BROWN_OUT);
    CHECK_EQ_INT(bt_reset_reason(BT_HAD_RUN_LOW, 0, 0), BT_RESET_RUN_PIN);
    CHECK_EQ_INT(bt_reset_reason(BT_HAD_GLITCH_DETECT, 0, w_i2c), BT_RESET_GLITCH);
    CHECK_EQ_INT(bt_reset_reason(BT_HAD_DP_RESET_REQ, 0, w_i2c), BT_RESET_DEBUGGER);
    // A watchdog reset with the trail at a stage: the watchdog caught a hang.
    CHECK_EQ_INT(bt_reset_reason(BT_HAD_WATCHDOG_RESET_PSM, 1, w_i2c), BT_RESET_WATCHDOG);
    CHECK_EQ_INT(bt_reset_reason(0, 1, w_i2c), BT_RESET_WATCHDOG);   // the watchdog's own reason alone
    // The firmware's own reboot goes through the watchdog too (rom_reboot); the trail says it was asked for.
    CHECK_EQ_INT(bt_reset_reason(BT_HAD_WATCHDOG_RESET_PSM, 2, w_reboot), BT_RESET_SOFTWARE);
    CHECK_EQ_INT(bt_reset_reason(BT_HAD_HZD_SYS_RESET_REQ, 0, w_i2c), BT_RESET_SYSRESET);
    CHECK_EQ_INT(bt_reset_reason(0, 0, 0), BT_RESET_UNKNOWN);
    // Power-on wins over a stale-looking trail: it cannot have survived one.
    CHECK_EQ_INT(bt_reset_reason(BT_HAD_POR | BT_HAD_WATCHDOG_RESET_PSM, 1, w_reboot), BT_RESET_POWER_ON);
}

static void the_report_names_both_cores(void) {
    char b[BT_JSON_MAX + 1];
    int n = bt_json(b, sizeof b, BT_HAD_WATCHDOG_RESET_PSM, 1, bt_word(BT0_NFC, 3500), bt_word(BT1_WIFI, 2100));
    CHECK(n > 0, "written");
    CHECK(strcmp(b, "{\"reset\":\"watchdog\",\"c0\":\"nfc\",\"up0\":3,\"c1\":\"wifi\",\"up1\":2}") == 0, b);
    // A power-up: nothing survived, the reason alone.
    n = bt_json(b, sizeof b, BT_HAD_POR, 0, 0, 0);
    CHECK(strcmp(b, "{\"reset\":\"power-on\"}") == 0, b);
    // core1 never started: core0's stage alone.
    n = bt_json(b, sizeof b, 0, 1, bt_word(BT0_DISPLAY, 900), 0);
    CHECK(strcmp(b, "{\"reset\":\"watchdog\",\"c0\":\"display\",\"up0\":0}") == 0, b);
    // Every name, at the widest, fits BT_JSON_MAX.
    static const int c0s[] = { BT0_EARLY, BT0_PSRAM, BT0_I2C, BT0_DISPLAY, BT0_NFC, BT0_LOOP, BT0_REBOOT };
    static const int c1s[] = { BT1_START, BT1_WIFI, BT1_SERVER, BT1_TRIAL, BT1_LOOP };
    static const uint32_t resets[] = { BT_HAD_POR, BT_HAD_BOR, BT_HAD_RUN_LOW, BT_HAD_GLITCH_DETECT,
                                       BT_HAD_DP_RESET_REQ, BT_HAD_HZD_SYS_RESET_REQ, 0 };
    int widest = 0;
    for (unsigned i = 0; i < sizeof c0s / sizeof c0s[0]; i++)
        for (unsigned j = 0; j < sizeof c1s / sizeof c1s[0]; j++)
            for (unsigned k = 0; k < sizeof resets / sizeof resets[0]; k++) {
                char big[256];
                int m = bt_json(big, sizeof big, resets[k], 1, bt_word(c0s[i], 0xFFFFFFFFu),
                                bt_word(c1s[j], 0xFFFFFFFFu));
                if (m > widest) widest = m;
            }
    printf("  widest lastBoot object: %d bytes (BT_JSON_MAX %d)\n", widest, BT_JSON_MAX);
    CHECK(widest <= BT_JSON_MAX, "fits");
    // Too small a buffer: refused, never clipped into bad JSON.
    CHECK_EQ_INT(bt_json(b, 10, BT_HAD_POR, 0, 0, 0), -1);
}

int main(void) {
    RUN(a_word_holds_its_stage_and_seconds);
    RUN(the_reset_reason_comes_from_the_chip_and_the_trail);
    RUN(the_report_names_both_cores);
    return REPORT();
}
