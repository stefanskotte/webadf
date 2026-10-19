// The boot trail's registers (boot_trail.h). Device-only: POWMAN SCRATCH0/1, POWMAN CHIP_RESET, WATCHDOG REASON.
#include "boot_trail.h"
#include "pico/stdlib.h"
#include "hardware/structs/powman.h"
#include "hardware/structs/watchdog.h"
#include "hardware/regs/powman.h"

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

void bt_hw_capture(void) {
    const uint32_t w0 = powman_hw->scratch[0], w1 = powman_hw->scratch[1];
    if (bt_json(g_prev, sizeof g_prev, powman_hw->chip_reset, watchdog_hw->reason, w0, w1) < 0) g_prev[0] = '\0';
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
