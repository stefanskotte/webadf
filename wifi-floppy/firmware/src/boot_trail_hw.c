// The boot trail's registers (boot_trail.h). Device-only: POWMAN SCRATCH0/1, POWMAN CHIP_RESET, WATCHDOG REASON.
#include "boot_trail.h"
#include "pico/stdlib.h"
#include "hardware/structs/powman.h"
#include "hardware/structs/watchdog.h"
#include "hardware/regs/powman.h"
#include "hardware/flash.h"
#include "hardware/address_mapped.h"   // XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE
#include "pico/flash.h"
#include "fw_trial.h"                  // fw_version_hash
#include "wifi_floppy_version.h"        // WF_FIRMWARE_VERSION
#include <string.h>

_Static_assert(BT_HAD_POR == POWMAN_CHIP_RESET_HAD_POR_BITS, "CHIP_RESET bits");
_Static_assert(BT_HAD_BOR == POWMAN_CHIP_RESET_HAD_BOR_BITS, "CHIP_RESET bits");
_Static_assert(BT_HAD_RUN_LOW == POWMAN_CHIP_RESET_HAD_RUN_LOW_BITS, "CHIP_RESET bits");
_Static_assert(BT_HAD_DP_RESET_REQ == POWMAN_CHIP_RESET_HAD_DP_RESET_REQ_BITS, "CHIP_RESET bits");
_Static_assert(BT_HAD_RESCUE == POWMAN_CHIP_RESET_HAD_RESCUE_BITS, "CHIP_RESET bits");
_Static_assert(BT_HAD_WATCHDOG_RESET_POWMAN_ASYNC == POWMAN_CHIP_RESET_HAD_WATCHDOG_RESET_POWMAN_ASYNC_BITS, "bits");
_Static_assert(BT_HAD_WATCHDOG_RESET_POWMAN == POWMAN_CHIP_RESET_HAD_WATCHDOG_RESET_POWMAN_BITS, "CHIP_RESET bits");
_Static_assert(BT_HAD_WATCHDOG_RESET_SWCORE == POWMAN_CHIP_RESET_HAD_WATCHDOG_RESET_SWCORE_BITS, "CHIP_RESET bits");
_Static_assert(BT_HAD_SWCORE_PD == POWMAN_CHIP_RESET_HAD_SWCORE_PD_BITS, "CHIP_RESET bits");
_Static_assert(BT_HAD_GLITCH_DETECT == POWMAN_CHIP_RESET_HAD_GLITCH_DETECT_BITS, "CHIP_RESET bits");
_Static_assert(BT_HAD_HZD_SYS_RESET_REQ == POWMAN_CHIP_RESET_HAD_HZD_SYS_RESET_REQ_BITS, "CHIP_RESET bits");
_Static_assert(BT_HAD_WATCHDOG_RESET_PSM == POWMAN_CHIP_RESET_HAD_WATCHDOG_RESET_PSM_BITS, "CHIP_RESET bits");

static char     g_prev[BT_JSON_MAX + 1];
static uint8_t  g_stage[2];
static uint32_t g_tick_at[2];
static uint32_t g_cr, g_wd, g_w0, g_w1;   // what capture read, for ut_hw_capture's rebuild

void bt_hw_capture(void) {
    g_w0 = powman_hw->scratch[0];
    g_w1 = powman_hw->scratch[1];
    g_cr = powman_hw->chip_reset;
    g_wd = watchdog_hw->reason;
    if (bt_json(g_prev, sizeof g_prev, g_cr, g_wd, g_w0, g_w1, NULL) < 0) g_prev[0] = '\0';
    // SCRATCH is written plainly: POWMAN's password (0x5AFE in bits 31:16) guards its control registers, not
    // SCRATCH -- pico_low_power stores a whole function pointer there the same way.
    powman_hw->scratch[1] = 0;
    bt_hw_mark(0, BT0_EARLY);
}

void bt_hw_mark(int core, int stage) {
    core &= 1;
    g_stage[core] = (uint8_t)stage;
    g_tick_at[core] = to_ms_since_boot(get_absolute_time());
    powman_hw->scratch[core] = bt_word(stage, g_tick_at[core]);
}

void bt_hw_tick(int core) {
    core &= 1;
    const uint32_t now = to_ms_since_boot(get_absolute_time());
    if (g_stage[core] == 0 || now - g_tick_at[core] < 1000u) return;
    g_tick_at[core] = now;
    powman_hw->scratch[core] = bt_word(g_stage[core], now);
}

const char *bt_hw_json(void) { return g_prev; }

// ---- the flash update trail (boot_trail.h) ----
//
// Top-of-flash map (each one sector, counted down from the end): -1 token, -2 config, -3 fw_state, -4 display,
// -5 drive_store, -6 override -- and -7 this one. The A/B partitions end at 8224K, far below. Not one of the
// install image's kept records (make_install_uf2.py RECORD_SECTORS): a diagnostic, nothing to keep.
#define UT_FLASH_OFFSET (PICO_FLASH_SIZE_BYTES - 7 * FLASH_SECTOR_SIZE)

static bool g_ut_active, g_ut_consume;
static int  g_ut_next;

typedef struct { bool erase; uint32_t off; const uint8_t *page; } ut_op_t;
static void ut_do(void *p) {
    const ut_op_t *o = p;
    if (o->erase) flash_range_erase(UT_FLASH_OFFSET, FLASH_SECTOR_SIZE);
    flash_range_program(o->off, o->page, UT_PAGE);
}
static bool ut_program(bool erase, int k, int stage, uint32_t hash) {
    static uint8_t page[UT_PAGE];   // static: off the caller's stack
    ut_page(page, k, stage, hash);
    ut_op_t o = { erase, UT_FLASH_OFFSET + (uint32_t)k * UT_PAGE, page };
    return flash_safe_execute(ut_do, &o, 1000) == PICO_OK;
}

void ut_hw_capture(bool bought_now) {
    const uint8_t *sec = (const uint8_t *)(XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE + UT_FLASH_OFFSET);
    const ut_view_t v = ut_decode(sec);
    const bool mine = bought_now && v.hash == fw_version_hash(WF_FIRMWARE_VERSION);
    g_ut_active = ut_active(&v, mine);
    g_ut_next = v.next_page;
    if (ut_stalled(&v, mine)) {
        g_ut_consume = true;   // reported once: UT_CONSUMED at the first mark (after PSRAM)
        if (bt_json(g_prev, sizeof g_prev, g_cr, g_wd, g_w0, g_w1, ut_stage_name(v.last)) < 0) g_prev[0] = '\0';
    }
}

void ut_hw_begin(const char *version) {
    // A fresh trail for this update: erase, then the header. core1, in the trial loop, before the proven reboot.
    g_ut_next = 1;
    g_ut_consume = false;
    g_ut_active = false;   // this boot is the trial; the boot that buys it carries it on
    (void)ut_program(true, 0, UT_BUY, fw_version_hash(version));
}

void ut_hw_mark(int stage) {
    if (g_ut_consume && g_ut_next < UT_SECTOR / UT_PAGE) {
        g_ut_consume = false;
        if (ut_program(false, g_ut_next, UT_CONSUMED, 0)) g_ut_next++;
    }
    if (!g_ut_active || g_ut_next >= UT_SECTOR / UT_PAGE) return;
    if (ut_program(false, g_ut_next, stage, 0)) g_ut_next++;
    if (stage == UT_CONTACT) g_ut_active = false;
}
