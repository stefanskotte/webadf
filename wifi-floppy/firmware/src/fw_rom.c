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
#include "pico/critical_section.h"
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
// Fix round 2 (Important 2b, still open after round 1): g_buying and
// g_reboot_req are a check-then-act pair read and written from BOTH cores
// (fw_rom_buy on core1, fw_rom_service's deadline check on core0). Round 1's
// __dmb only orders each core's OWN accesses -- it gives no mutual exclusion
// between them, so the two checks could still interleave: core0 reads
// !g_buying, core1 sets g_buying and reads g_reboot_req == 0, core0 then
// sets g_reboot_req and reboots mid-buy. g_boot_cs (a hardware spinlock +
// IRQs off on the owning core) makes the check-and-set atomic across both
// cores instead. It is held only around the flag check-and-set, NEVER
// across the flash write itself (flash_safe_execute has its own, separate
// multicore lockout for that) -- so core1 never holds this lock while
// parking core0 inside flash_safe_execute, which is what rules out a
// deadlock between the two mechanisms.
static critical_section_t g_boot_cs;
static volatile bool      g_buying;
static uint8_t __aligned(4) g_work[4096];     // PT load (3.25 KB) and explicit_buy (4 KB)

void fw_rom_boot_init(void) {
    // Before core1 launches, so g_boot_cs is ready for fw_rom_buy the first
    // moment core1 could possibly call it.
    critical_section_init(&g_boot_cs);
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
    // Check-and-set against fw_rom_service's deadline reboot, under the
    // lock: if a reboot has already been requested, back off rather than
    // start a flash write a reset could interrupt. The lock is released
    // before the flash write itself -- see g_boot_cs's comment.
    critical_section_enter_blocking(&g_boot_cs);
    if (g_reboot_req != 0) {
        critical_section_exit(&g_boot_cs);
        return false;
    }
    g_buying = true;
    critical_section_exit(&g_boot_cs);

    int rc = -1;
    bool ok = flash_safe_execute(do_buy, &rc, 2000) == PICO_OK;
    if (ok) {
        wf_logf(rc == 0 ? WF_INFO : WF_ERR, "boot: explicit buy rc %d", rc);
        if (rc == 0) g_bought = true;
    }

    critical_section_enter_blocking(&g_boot_cs);
    g_buying = false;
    critical_section_exit(&g_boot_cs);

    return ok && rc == 0;
}

void fw_rom_request_reboot(uint32_t flash_update_off) {
    // Under the same lock as fw_rom_buy/fw_rom_service, and only if nothing
    // is pending yet -- never overwrite an already-requested reboot (in
    // particular, never let a later, unrelated call race past a revert
    // that's already on its way out).
    critical_section_enter_blocking(&g_boot_cs);
    if (g_reboot_req == 0) {
        g_reboot_off = flash_update_off;
        g_reboot_req = flash_update_off ? 2u : 1u;
    }
    critical_section_exit(&g_boot_cs);
}

void fw_rom_watchdog_start(void) { watchdog_enable(8000, true); }

void fw_rom_service(void) {
    // The trial deadline is enforced HERE, on core0, independent of core1: a
    // trial image whose network side hangs must still revert (spec M5/M6).
    // The read-decide-set below runs under g_boot_cs, the same lock
    // fw_rom_buy takes for its own check-and-set -- so the two can never
    // interleave: either this sees g_buying already true (a buy is under
    // way; skip) or fw_rom_buy sees g_reboot_req already nonzero (a reboot
    // is already decided; refuse to start). There is no window where a buy
    // has started and this path can still slip a reboot request underneath
    // it. wf_logf is kept OUTSIDE the lock (spinlock + IRQs-off sections
    // must stay short); g_reboot_req itself is read again below, outside
    // the lock, which is safe because once set it is never cleared.
    bool deadline_hit = false;
    critical_section_enter_blocking(&g_boot_cs);
    if (g_trial && !g_bought && !g_buying && g_reboot_req == 0 &&
        to_ms_since_boot(get_absolute_time()) >= FW_TRIAL_DEADLINE_MS) {
        g_reboot_req = 1u;
        deadline_hit = true;
    }
    critical_section_exit(&g_boot_cs);
    if (deadline_hit) {
        wf_logf(WF_WARN, "boot: trial not confirmed within 5 minutes -- rebooting to revert");
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
