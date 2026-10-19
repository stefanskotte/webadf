#include "boot_trail.h"
#include <stdio.h>
#include <string.h>

#define BT_MAGIC 0xB7u

uint32_t bt_word(int stage, uint32_t up_ms) {
    uint32_t s = up_ms / 1000u;
    if (s > 0xFFFFu) s = 0xFFFFu;
    return (BT_MAGIC << 24) | ((uint32_t)(stage & 0xFF) << 16) | s;
}

bool bt_word_read(uint32_t w, int *stage, uint32_t *up_s) {
    if ((w >> 24) != BT_MAGIC) return false;
    int st = (int)((w >> 16) & 0xFFu);
    if (st == 0 || st > BT_STAGE_MAX) return false;
    *stage = st;
    *up_s = w & 0xFFFFu;
    return true;
}

bt_reset_t bt_reset_reason(uint32_t chip_reset, uint32_t wd_reason, uint32_t w0) {
    if (chip_reset & BT_HAD_POR) return BT_RESET_POWER_ON;
    if (chip_reset & BT_HAD_BOR) return BT_RESET_BROWN_OUT;
    if (chip_reset & BT_HAD_RUN_LOW) return BT_RESET_RUN_PIN;
    if (chip_reset & BT_HAD_GLITCH_DETECT) return BT_RESET_GLITCH;
    if (chip_reset & (BT_HAD_DP_RESET_REQ | BT_HAD_RESCUE)) return BT_RESET_DEBUGGER;
    int st = 0; uint32_t up;
    if (bt_word_read(w0, &st, &up) && st == BT0_REBOOT) return BT_RESET_SOFTWARE;
    const uint32_t wd_bits = BT_HAD_WATCHDOG_RESET_PSM | BT_HAD_WATCHDOG_RESET_SWCORE |
                             BT_HAD_WATCHDOG_RESET_POWMAN | BT_HAD_WATCHDOG_RESET_POWMAN_ASYNC;
    if ((chip_reset & wd_bits) || (wd_reason & 0x3u)) return BT_RESET_WATCHDOG;
    if (chip_reset & BT_HAD_HZD_SYS_RESET_REQ) return BT_RESET_SYSRESET;
    return BT_RESET_UNKNOWN;
}

const char *bt_reset_name(bt_reset_t r) {
    switch (r) {
    case BT_RESET_POWER_ON:  return "power-on";
    case BT_RESET_BROWN_OUT: return "brown-out";
    case BT_RESET_RUN_PIN:   return "run-pin";
    case BT_RESET_DEBUGGER:  return "debugger";
    case BT_RESET_GLITCH:    return "glitch";
    case BT_RESET_WATCHDOG:  return "watchdog";
    case BT_RESET_SOFTWARE:  return "software";
    case BT_RESET_SYSRESET:  return "sysreset";
    default:                 return "unknown";
    }
}

const char *bt_stage_name(int core, int stage) {
    static const char *const c0[] = { "", "early", "psram", "i2c", "display", "nfc", "loop", "reboot" };
    static const char *const c1[] = { "", "start", "wifi", "server", "trial", "loop" };
    if (core == 0) return stage > 0 && stage < (int)(sizeof c0 / sizeof c0[0]) ? c0[stage] : "";
    return stage > 0 && stage < (int)(sizeof c1 / sizeof c1[0]) ? c1[stage] : "";
}

int bt_json(char *out, size_t cap, uint32_t chip_reset, uint32_t wd_reason, uint32_t w0, uint32_t w1) {
    char tmp[160];
    int n = snprintf(tmp, sizeof tmp, "{\"reset\":\"%s\"", bt_reset_name(bt_reset_reason(chip_reset, wd_reason, w0)));
    const uint32_t w[2] = { w0, w1 };
    for (int core = 0; core < 2; core++) {
        int st; uint32_t up;
        if (!bt_word_read(w[core], &st, &up)) continue;
        const char *name = bt_stage_name(core, st);
        if (!name[0]) continue;
        n += snprintf(tmp + n, sizeof tmp - (size_t)n, ",\"c%d\":\"%s\",\"up%d\":%lu", core, name, core,
                      (unsigned long)up);
    }
    n += snprintf(tmp + n, sizeof tmp - (size_t)n, "}");
    if (n < 0 || (size_t)n + 1 > cap) return -1;
    memcpy(out, tmp, (size_t)n + 1);
    return n;
}
