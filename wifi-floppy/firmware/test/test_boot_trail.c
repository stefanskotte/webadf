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
    int n = bt_json(b, sizeof b, BT_HAD_WATCHDOG_RESET_PSM, 1, bt_word(BT0_NFC, 3500), bt_word(BT1_WIFI, 2100), NULL);
    CHECK(n > 0, "written");
    CHECK(strcmp(b, "{\"reset\":\"watchdog\",\"c0\":\"nfc\",\"up0\":3,\"c1\":\"wifi\",\"up1\":2}") == 0, b);
    // A power-up: nothing in POWMAN survived, the reason alone.
    n = bt_json(b, sizeof b, BT_HAD_POR, 0, 0, 0, NULL);
    CHECK(strcmp(b, "{\"reset\":\"power-on\"}") == 0, b);
    // ...but the flash update trail did: an update's restart that stopped after the I2C scan began.
    n = bt_json(b, sizeof b, BT_HAD_POR, 0, 0, 0, "i2c");
    CHECK(strcmp(b, "{\"reset\":\"power-on\",\"upd\":\"i2c\"}") == 0, b);
    // core1 never started: core0's stage alone.
    n = bt_json(b, sizeof b, 0, 1, bt_word(BT0_DISPLAY, 900), 0, NULL);
    CHECK(strcmp(b, "{\"reset\":\"watchdog\",\"c0\":\"display\",\"up0\":0}") == 0, b);
    // The confirm path, stage by stage, has names.
    static const int c0s[] = { BT0_EARLY, BT0_BUY, BT0_BOUGHT, BT0_PSRAM_INIT, BT0_PSRAM, BT0_I2C, BT0_DISPLAY,
                               BT0_NFC, BT0_LOOP, BT0_REBOOT };
    static const int c1s[] = { BT1_START, BT1_WIFI, BT1_SERVER, BT1_TRIAL, BT1_PROVEN, BT1_LOOP, BT1_CONTACT };
    for (unsigned i = 0; i < sizeof c0s / sizeof c0s[0]; i++) CHECK(bt_stage_name(0, c0s[i])[0] != '\0', "c0 named");
    for (unsigned i = 0; i < sizeof c1s / sizeof c1s[0]; i++) CHECK(bt_stage_name(1, c1s[i])[0] != '\0', "c1 named");
    CHECK(strcmp(bt_stage_name(0, BT0_BUY), "buy") == 0, "buy");
    CHECK(strcmp(bt_stage_name(0, BT0_PSRAM_INIT), "psram-init") == 0, "psram-init");
    CHECK(strcmp(bt_stage_name(1, BT1_PROVEN), "proven") == 0, "proven");
    // Every name, at the widest, fits BT_JSON_MAX.
    static const uint32_t resets[] = { BT_HAD_POR, BT_HAD_BOR, BT_HAD_RUN_LOW, BT_HAD_GLITCH_DETECT,
                                       BT_HAD_DP_RESET_REQ, BT_HAD_HZD_SYS_RESET_REQ, 0 };
    static const int uts[] = { UT_BUY, UT_PSRAM, UT_I2C, UT_DISPLAY, UT_LAUNCH, UT_SERVER };
    int widest = 0;
    for (unsigned i = 0; i < sizeof c0s / sizeof c0s[0]; i++)
        for (unsigned j = 0; j < sizeof c1s / sizeof c1s[0]; j++)
            for (unsigned k = 0; k < sizeof resets / sizeof resets[0]; k++)
                for (unsigned u = 0; u < sizeof uts / sizeof uts[0]; u++) {
                    char big[256];
                    int m = bt_json(big, sizeof big, resets[k], 1, bt_word(c0s[i], 0xFFFFFFFFu),
                                    bt_word(c1s[j], 0xFFFFFFFFu), ut_stage_name(uts[u]));
                    if (m > widest) widest = m;
                }
    printf("  widest lastBoot object: %d bytes (BT_JSON_MAX %d)\n", widest, BT_JSON_MAX);
    CHECK(widest <= BT_JSON_MAX, "fits");
    CHECK_EQ_INT(bt_json(b, 10, BT_HAD_POR, 0, 0, 0, NULL), -1);   // too small: refused, never clipped
}

// ---- the flash update trail (survives a power cut; the update path only) ----------------------------------

static uint8_t sec[UT_SECTOR];
static void erased(void) { memset(sec, 0xFF, sizeof sec); }
// What the device does: page k programmed with ut_page(k, stage, hash) -- one program per page, never twice.
static void write(int k, int stage, uint32_t hash) {
    uint8_t pg[UT_PAGE];
    ut_page(pg, k, stage, hash);
    for (int i = 0; i < UT_PAGE; i++) sec[k * UT_PAGE + i] &= pg[i];   // NOR: program only clears bits
}

static void an_erased_or_foreign_sector_is_no_trail(void) {
    erased();
    ut_view_t v = ut_decode(sec);
    CHECK(!v.present, "erased: nothing");
    memset(sec, 0x00, sizeof sec);
    v = ut_decode(sec);
    CHECK(!v.present, "zeros: nothing");
    erased();
    write(1, UT_PSRAM, 0);                               // no header page: not a trail
    CHECK(!ut_decode(sec).present, "no header");
}

static void the_trail_reads_how_far_the_update_restart_got(void) {
    erased();
    write(0, UT_BUY, 0x1234ABCDu);
    ut_view_t v = ut_decode(sec);
    CHECK(v.present, "the header");
    CHECK_EQ_INT(v.hash, 0x1234ABCD);
    CHECK_EQ_INT(v.last, UT_BUY);
    CHECK_EQ_INT(v.next_page, 1);
    CHECK(!v.done && !v.consumed, "open");
    write(1, UT_PSRAM, 0);
    write(2, UT_I2C, 0);
    v = ut_decode(sec);
    CHECK_EQ_INT(v.last, UT_I2C);
    CHECK_EQ_INT(v.next_page, 3);
    // A page out of order (a stage lower than the last) ends the trail where it was: never read backwards.
    write(3, UT_PSRAM, 0);
    CHECK_EQ_INT(ut_decode(sec).last, UT_I2C);
}

static void a_finished_or_already_reported_trail_is_not_reported(void) {
    erased();
    write(0, UT_BUY, 1); write(1, UT_PSRAM, 0); write(2, UT_I2C, 0); write(3, UT_DISPLAY, 0);
    write(4, UT_LAUNCH, 0); write(5, UT_SERVER, 0); write(6, UT_CONTACT, 0);
    ut_view_t v = ut_decode(sec);
    CHECK(v.done, "contact reached: done");
    CHECK(!ut_stalled(&v, false), "done is no stall");
    erased();
    write(0, UT_BUY, 1); write(1, UT_PSRAM, 0); write(2, UT_I2C, 0);
    v = ut_decode(sec);
    CHECK(ut_stalled(&v, false), "a later boot finds it open: the update's restart stalled after the I2C mark");
    write(3, UT_CONSUMED, 0);
    v = ut_decode(sec);
    CHECK(v.consumed, "reported once");
    CHECK_EQ_INT(v.last, UT_I2C);                        // the consumed page does not move the stage
    CHECK(!ut_stalled(&v, false), "never again");
}

// Only the boot right after the buy writes the trail on (fw_rom bought it this boot). Any other boot that finds a
// header with nothing after it: the proven reboot, the buy or PSRAM init stopped -- a stall at "buy".
static void the_boot_right_after_the_buy_carries_it_on(void) {
    erased();
    write(0, UT_BUY, 1);
    ut_view_t v = ut_decode(sec);
    CHECK(!ut_stalled(&v, true), "this boot bought it: it is the restart in progress, not a stall");
    CHECK(ut_active(&v, true), "and it writes the next pages");
    CHECK(ut_stalled(&v, false), "a boot that did not buy it: the restart never got past the buy");
    CHECK(!ut_active(&v, false), "and writes nothing");
    CHECK(strcmp(ut_stage_name(v.last), "buy") == 0, "named");
    write(1, UT_PSRAM, 0);
    v = ut_decode(sec);
    CHECK(!ut_active(&v, true), "a trail already past the header is a previous restart's, whatever this boot did");
    CHECK(ut_stalled(&v, true), "and is reported");
}

int main(void) {
    RUN(a_word_holds_its_stage_and_seconds);
    RUN(the_reset_reason_comes_from_the_chip_and_the_trail);
    RUN(the_report_names_both_cores);
    RUN(an_erased_or_foreign_sector_is_no_trail);
    RUN(the_trail_reads_how_far_the_update_restart_got);
    RUN(a_finished_or_already_reported_trail_is_not_reported);
    RUN(the_boot_right_after_the_buy_carries_it_on);
    return REPORT();
}
