// Device-only boot ROM / flash / watchdog glue for 2b. Every DECISION it acts
// on is made in a host-tested unit (fw_trial, fw_apply, fw_update); this file
// only performs them.
#include "fw_rom.h"
#include "fw_trial.h"
#include "wf_log.h"
#include <string.h>
#include "pico/stdlib.h"
#include "pico/bootrom.h"
#include "pico/flash.h"
#include "hardware/flash.h"
#include "hardware/watchdog.h"
#include "boot/bootrom_constants.h"
#include "boot/picobin.h"
#include "boot/picoboot_constants.h"

static bool     g_trial;
static int      g_partition = -1;
static volatile bool     g_bought;
static volatile uint32_t g_reboot_req;        // 0 none, 1 normal, 2 flash update
static volatile uint32_t g_reboot_off;
static uint8_t __aligned(4) g_work[4096];     // PT load (3.25 KB) and explicit_buy (4 KB)

void fw_rom_boot_init(void) {
    boot_info_t bi;
    memset(&bi, 0, sizeof bi);
    if (rom_get_boot_info(&bi)) {
        g_partition = bi.partition;
        g_trial = (bi.tbyb_and_update_info & BOOT_TBYB_AND_UPDATE_FLAG_BUY_PENDING) != 0;
    }
    int rc = rom_load_partition_table(g_work, sizeof g_work, false);
    wf_logf(WF_INFO, "boot: partition %d type 0x%02x%s, pt load rc %d",
            g_partition, (unsigned)bi.boot_type, g_trial ? " TRIAL (buy pending)" : "", rc);
}

bool fw_rom_trial_boot(void)      { return g_trial && !g_bought; }
int  fw_rom_booted_partition(void) { return g_partition; }

static bool part_range(int n, uint32_t *off, uint32_t *len) {
    uint32_t buf[4];
    int rc = rom_get_partition_table_info(buf, 4,
        PT_INFO_PARTITION_LOCATION_AND_FLAGS | PT_INFO_SINGLE_PARTITION | ((uint32_t)n << 24));
    if (rc < 2) return false;
    uint32_t first = (buf[1] >> PICOBIN_PARTITION_LOCATION_FIRST_SECTOR_LSB) & 0x1fffu;
    uint32_t last  = (buf[1] >> PICOBIN_PARTITION_LOCATION_LAST_SECTOR_LSB) & 0x1fffu;
    *off = first * 4096u;
    *len = (last + 1u - first) * 4096u;
    return true;
}

bool fw_rom_other_slot(uint32_t *off, uint32_t *len) {
    if (g_partition != 0 && g_partition != 1) return false;   // unpartitioned: no OTA
    return part_range(g_partition == 0 ? 1 : 0, off, len);
}

static void do_buy(void *p) { *(int *)p = rom_explicit_buy(g_work, sizeof g_work); }

bool fw_rom_buy(void) {
    int rc = -1;
    if (flash_safe_execute(do_buy, &rc, 2000) != PICO_OK) return false;
    wf_logf(rc == 0 ? WF_INFO : WF_ERR, "boot: explicit buy rc %d", rc);
    if (rc == 0) g_bought = true;
    return rc == 0;
}

void fw_rom_request_reboot(uint32_t flash_update_off) {
    g_reboot_off = flash_update_off;
    __dmb();
    g_reboot_req = flash_update_off ? 2u : 1u;
}

void fw_rom_watchdog_start(void) { watchdog_enable(8000, true); }

void fw_rom_service(void) {
    // The trial deadline is enforced HERE, on core0, independent of core1: a
    // trial image whose network side hangs must still revert (spec M5/M6).
    if (g_trial && !g_bought && g_reboot_req == 0 &&
        to_ms_since_boot(get_absolute_time()) >= FW_TRIAL_DEADLINE_MS) {
        wf_logf(WF_WARN, "boot: trial not confirmed within 5 minutes -- rebooting to revert");
        g_reboot_req = 1u;
    }
    if (g_reboot_req) {
        // M9: rom_reboot schedules the reset on the watchdog, and feeding the
        // watchdog cancels it. So this is the one place a reboot happens, and
        // nothing feeds the watchdog after it.
        uint32_t type = g_reboot_req == 2u ? REBOOT2_FLAG_REBOOT_TYPE_FLASH_UPDATE
                                            : REBOOT2_FLAG_REBOOT_TYPE_NORMAL;
        // The boot ROM's convention for "start of the updated region" is an XIP
        // address (spec M5). Built in two statements so Task 1's XIP_BASE-plus
        // guard stays a rule without exceptions -- this is not a flash read.
        uint32_t base = 0;
        if (g_reboot_req == 2u) { base = (uint32_t)XIP_BASE; base += g_reboot_off; }
        wf_log_drain(64);
        rom_reboot(type | REBOOT2_FLAG_NO_RETURN_ON_SUCCESS, 100, base, 0);
        for (;;) tight_loop_contents();
    }
    watchdog_update();
}
