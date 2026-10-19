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
    static const char *const c0[] = { "", "early", "buy", "bought", "psram-init", "psram", "i2c", "display", "nfc",
                                      "loop", "reboot" };
    static const char *const c1[] = { "", "start", "wifi", "server", "trial", "proven", "loop", "contact" };
    if (core == 0) return stage > 0 && stage < (int)(sizeof c0 / sizeof c0[0]) ? c0[stage] : "";
    return stage > 0 && stage < (int)(sizeof c1 / sizeof c1[0]) ? c1[stage] : "";
}

int bt_json(char *out, size_t cap, uint32_t chip_reset, uint32_t wd_reason, uint32_t w0, uint32_t w1,
            const char *upd) {
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
    if (upd && upd[0]) n += snprintf(tmp + n, sizeof tmp - (size_t)n, ",\"upd\":\"%s\"", upd);
    n += snprintf(tmp + n, sizeof tmp - (size_t)n, "}");
    if (n < 0 || (size_t)n + 1 > cap) return -1;
    memcpy(out, tmp, (size_t)n + 1);
    return n;
}

// ---- the flash update trail ----

#define UT_MAGIC 0x55540000u   // "UT"

static uint32_t rd32(const uint8_t *p) { return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }
static void wr32(uint8_t *p, uint32_t v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24); }

void ut_page(uint8_t out[UT_PAGE], int k, int stage, uint32_t hash) {
    memset(out, 0xFF, UT_PAGE);
    const uint32_t w0 = UT_MAGIC | ((uint32_t)(k & 0xFF) << 8) | (uint32_t)(stage & 0xFF);
    wr32(out, w0);
    wr32(out + 4, hash);
    wr32(out + 8, ~(w0 ^ hash));
}

// Page k's stage, or 0 if page k is not a well-formed trail page for k.
static int page_stage(const uint8_t *sector, int k, uint32_t *hash) {
    const uint8_t *p = sector + k * UT_PAGE;
    const uint32_t w0 = rd32(p), h = rd32(p + 4), chk = rd32(p + 8);
    if ((w0 & 0xFFFF0000u) != UT_MAGIC || ((w0 >> 8) & 0xFFu) != (uint32_t)k || chk != ~(w0 ^ h)) return 0;
    if (hash) *hash = h;
    return (int)(w0 & 0xFFu);
}

ut_view_t ut_decode(const uint8_t sector[UT_SECTOR]) {
    ut_view_t v;
    memset(&v, 0, sizeof v);
    uint32_t h = 0;
    if (page_stage(sector, 0, &h) != UT_BUY) return v;
    v.present = true;
    v.hash = h;
    v.last = UT_BUY;
    int k = 1;
    for (; k < UT_SECTOR / UT_PAGE; k++) {
        const int st = page_stage(sector, k, NULL);
        if (st == UT_CONSUMED) { v.consumed = true; k++; break; }
        if (st <= v.last || st > UT_CONTACT) break;   // unwritten, or out of order: the trail ends here
        v.last = st;
        if (st == UT_CONTACT) { v.done = true; k++; break; }
    }
    v.next_page = k;
    return v;
}

bool ut_stalled(const ut_view_t *v, bool bought_now) {
    if (!v->present || v->done || v->consumed) return false;
    return !(bought_now && v->last == UT_BUY);
}

bool ut_active(const ut_view_t *v, bool bought_now) {
    return v->present && !v->done && !v->consumed && bought_now && v->last == UT_BUY;
}

const char *ut_stage_name(int stage) {
    static const char *const n[] = { "", "buy", "psram", "i2c", "display", "launch", "server", "contact" };
    return stage > 0 && stage < (int)(sizeof n / sizeof n[0]) ? n[stage] : "";
}
