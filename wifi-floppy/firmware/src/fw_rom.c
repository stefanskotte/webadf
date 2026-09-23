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
#include "hardware/sync.h"
#include "boot/bootrom_constants.h"
#include "boot/picobin.h"
#include "boot/picoboot_constants.h"
#include "fw_apply.h"
#include "hardware/address_mapped.h"   // XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE

static bool     g_trial;
static int      g_partition = -1;
static uint32_t g_boot_type;
static int      g_pt_rc;
static volatile bool     g_bought;
static volatile uint32_t g_reboot_req;        // 0 none, 1 normal, 2 flash update
static volatile uint32_t g_reboot_off;
// g_reboot_req/g_reboot_off are read and written from BOTH cores
// (fw_rom_request_reboot / fw_rom_request_proven_reboot on core1,
// fw_rom_service's deadline check on core0). g_boot_cs (a hardware spinlock +
// IRQs off on the owning core) makes each check-and-set atomic across the
// cores: whichever side sets g_reboot_req first wins, and the other side
// sees it and backs off. It is held only around register/flag writes, never
// across a flash operation.
static critical_section_t g_boot_cs;
static uint8_t __aligned(4) g_work[4096];     // PT load (3.25 KB) and explicit_buy (4 KB)

// What fw_rom_boot_early saw and did, for fw_rom_boot_init to log once
// logging is up.
typedef enum { EARLY_NO_MARK, EARLY_STALE_MARK, EARLY_BOUGHT, EARLY_BUY_FAILED } early_t;
static early_t  g_early = EARLY_NO_MARK;
static uint32_t g_mark0, g_mark1;
static int      g_buy_rc;

// ---- the early buy (fix rounds 4-5) ---------------------------------------
//
// Measured on the board (controller probe, round 5): rom_explicit_buy HANGS,
// between erasing the image's trailing metadata sector and rewriting it,
// whenever PSRAM (QMI CS1) is configured -- and an armed watchdog does not
// reset it. With PSRAM unconfigured the same buy returns 0 and the bought
// slot persists. Restoring QMI afterwards (round 4) cannot help: the hang is
// inside the ROM. So the SDK's pre-main PSRAM init is skipped
// (PICO_RUNTIME_SKIP_INIT_PSRAM=1, CMakeLists.txt), this runs as the first
// statement of main() with PSRAM still unconfigured, and main() brings PSRAM
// up right after it (runtime_init_setup_psram) on every boot.
static int early_buy(void) {
    // A hang net for the buy itself (the regular watchdog is not armed until
    // core0's loop). 8 s is ~100x a 4 KB erase + program.
    watchdog_enable(8000, false);
    uint32_t irq = save_and_disable_interrupts();
    // Core1 is not started, so flash_safe_execute inside rom_explicit_buy
    // takes the PICO_MULTICORE_LOCKOUT_BEFORE_CORE1_STARTED path (no
    // handshake) and just disables IRQs, which are already off.
    int rc = rom_explicit_buy(g_work, sizeof g_work);
    restore_interrupts(irq);
    // Disarm only after a SUCCESSFUL buy. After a failed one leave it armed:
    // disarming could also cancel a watchdog the ROM armed for the trial, and
    // the revert reboot is wanted anyway (fw_rom_boot_early requests it; if
    // core0's loop does not get there first, this watchdog does it).
    if (rc == 0) watchdog_disable();
    return rc;
}

void fw_rom_boot_early(const char *running_version) {
    // Before core1 launches, so g_boot_cs is ready for every cross-core
    // request, including the one a failed buy below makes.
    critical_section_init(&g_boot_cs);
    boot_info_t bi;
    memset(&bi, 0, sizeof bi);
    if (rom_get_boot_info(&bi)) {
        g_partition = bi.partition;
        g_trial = (bi.tbyb_and_update_info & BOOT_TBYB_AND_UPDATE_FLAG_BUY_PENDING) != 0;
    }
    g_boot_type = bi.boot_type;
    // Before any part_range() use, and before the buy.
    g_pt_rc = rom_load_partition_table(g_work, sizeof g_work, false);

    // Consume the mark whatever it says: cleared FIRST, so neither a failed
    // buy nor a later boot can ever act on it twice.
    g_mark0 = watchdog_hw->scratch[0];
    g_mark1 = watchdog_hw->scratch[1];
    watchdog_hw->scratch[0] = 0;
    watchdog_hw->scratch[1] = 0;

    if (!fw_trial_proven(g_trial, g_mark0, g_mark1, running_version)) {
        g_early = (g_mark0 == FW_PROVEN_MAGIC) ? EARLY_STALE_MARK : EARLY_NO_MARK;
        return;                                   // a plain trial, or no trial at all
    }
    g_buy_rc = early_buy();
    if (g_buy_rc == 0) {
        g_bought = true;                          // trial over; the deadline stands down
        g_early = EARLY_BOUGHT;
    } else {
        g_early = EARLY_BUY_FAILED;
        fw_rom_request_reboot(0);                 // unbought -> the old slot (M5)
    }
}

void fw_rom_boot_init(void) {
    wf_logf(WF_INFO, "boot: partition %d type 0x%02x%s, pt load rc %d",
            g_partition, (unsigned)g_boot_type,
            fw_rom_trial_boot() ? " TRIAL (buy pending)" : "", g_pt_rc);
    switch (g_early) {
    case EARLY_BOUGHT:
        wf_logf(WF_INFO, "boot: proven trial -- explicit buy rc 0, confirmed");
        break;
    case EARLY_BUY_FAILED:
        wf_logf(WF_ERR, "boot: proven trial -- explicit buy rc %d, rebooting to revert", g_buy_rc);
        break;
    case EARLY_STALE_MARK:
        wf_logf(WF_WARN, "boot: ignored a proven mark not for this boot (%08lx %08lx)",
                (unsigned long)g_mark0, (unsigned long)g_mark1);
        break;
    case EARLY_NO_MARK:
        break;
    }
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

void fw_rom_request_proven_reboot(const char *running_version) {
    uint32_t off = 0, len = 0;
    if ((g_partition != 0 && g_partition != 1) || !part_range(g_partition, &off, &len) || off == 0) {
        // Cannot name our own slot, so cannot come back to it as a trial.
        // Revert instead: an unbought image never becomes current.
        wf_logf(WF_ERR, "trial: no range for booted partition %d -- rebooting to revert",
                g_partition);
        fw_rom_request_reboot(0);
        return;
    }
    uint32_t h = fw_version_hash(running_version);
    bool accepted = false;
    critical_section_enter_blocking(&g_boot_cs);
    if (g_reboot_req == 0) {
        watchdog_hw->scratch[0] = FW_PROVEN_MAGIC;
        watchdog_hw->scratch[1] = h;
        g_reboot_off = off;
        g_reboot_req = 2u;
        accepted = true;
    }
    critical_section_exit(&g_boot_cs);
    if (accepted)
        wf_logf(WF_INFO, "trial: proven -- rebooting into slot %d (0x%lx) to buy",
                g_partition, (unsigned long)off);
    else
        wf_logf(WF_WARN, "trial: proven, but a reboot is already pending -- not marking");
}

void fw_rom_request_reboot(uint32_t flash_update_off) {
    // Under the same lock as fw_rom_service/fw_rom_request_proven_reboot,
    // and only if nothing is pending yet -- never overwrite an
    // already-requested reboot.
    critical_section_enter_blocking(&g_boot_cs);
    if (g_reboot_req == 0) {
        g_reboot_off = flash_update_off;
        g_reboot_req = flash_update_off ? 2u : 1u;
    }
    critical_section_exit(&g_boot_cs);
}

void fw_rom_watchdog_start(void) {
    // Fix round 3 (bench): pause_on_debug is now OFF. This board never runs
    // under a debugger (no SWD probe attached in the field or on the
    // bench), and a watchdog left paused while the chip is halted in a
    // debug/lockup state is the leading explanation for the observed
    // failure mode -- USB enumerated but dead, and the 8 s watchdog never
    // reset the board during the nested-flash_safe_execute wedge above.
    watchdog_enable(8000, false);
}

void fw_rom_service(void) {
    // The trial deadline is enforced HERE, on core0, independent of core1: a
    // trial image whose network side hangs must still revert (spec M5/M6).
    // The read-decide-set runs under g_boot_cs, so it cannot interleave with
    // core1's fw_rom_request_proven_reboot: whichever sets g_reboot_req first
    // wins. It never fires once the early buy set g_bought. wf_logf is kept
    // OUTSIDE the lock; g_reboot_req is read again below outside the lock,
    // which is safe because once set it is never cleared.
    bool deadline_hit = false;
    critical_section_enter_blocking(&g_boot_cs);
    if (g_trial && !g_bought && g_reboot_req == 0 &&
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

// ---- device flash ops for fw_apply_image (D7) ------------------------------
//
// hardware_flash under pico/flash's flash_safe_execute, which saves/restores
// PSRAM's QMI CS1 state around the callback -- see fw_rom_boot_early's
// comment above for the measured reason that matters and why the boot-ROM
// buy itself must NOT go through this path. Each sector gets its own short
// flash_safe_execute window (tens of ms with core0 parked), never one long
// window spanning the whole image, so the watchdog never has to cover it.
typedef struct { uint32_t off; const uint8_t *data; } fr_prog_t;
static void do_erase(void *p) { flash_range_erase(*(uint32_t *)p, FLASH_SECTOR_SIZE); }
static void do_prog(void *p) { fr_prog_t *a = p; flash_range_program(a->off, a->data, FLASH_SECTOR_SIZE); }
// Hardening round (post-approval): recomputed on every call rather than
// cached once, so it always reflects the current g_partition and never
// trusts a value that could go stale -- fw_rom_other_slot() is a cheap
// boot-ROM partition-table query (already called uncached elsewhere in this
// file, e.g. fw_rom_request_proven_reboot's part_range()), not a flash
// access, so there is no cost worth caching against. Refuses any offset
// that is not sector-aligned or that falls outside the OTHER slot's range,
// so the booted slot, the partition table at offset 0, and the
// config/token/state sectors at the top of flash are all unwritable
// through fw_rom_flash even if a caller ever passed a wrong offset.
static bool sector_in_other_slot(uint32_t off) {
    if ((off % FLASH_SECTOR_SIZE) != 0) return false;
    uint32_t slot_off, slot_len;
    if (!fw_rom_other_slot(&slot_off, &slot_len)) return false;
    if (slot_len < FLASH_SECTOR_SIZE) return false;
    if (off < slot_off) return false;
    if (off - slot_off > slot_len - FLASH_SECTOR_SIZE) return false;
    return true;
}
static bool fr_erase(void *ctx, uint32_t off) {
    (void)ctx;
    if (!sector_in_other_slot(off)) return false;
    return flash_safe_execute(do_erase, &off, 1000) == PICO_OK;
}
static bool fr_program(void *ctx, uint32_t off, const uint8_t data[4096]) {
    (void)ctx;
    if (!sector_in_other_slot(off)) return false;
    fr_prog_t a = { off, data };
    return flash_safe_execute(do_prog, &a, 1000) == PICO_OK;
}
// NOTRANSLATE: the other slot is not mapped at XIP_BASE (spec M3).
static const uint8_t *fr_raw(void *ctx, uint32_t off) {
    (void)ctx; return (const uint8_t *)(XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE + off);
}
const fw_flash_t fw_rom_flash = { fr_erase, fr_program, fr_raw, NULL };

#if WF_FW_DEBUG
static void debug_wedge_cb(void *p) {
    (void)p;
    for (;;) tight_loop_contents();
}

// Bench-only (fix round 3): deliberately reproduces the exact wedge shape
// the bench hit -- a core1 callback that never returns while it holds
// flash_safe_execute's multicore lockout, so core0 is parked (interrupts
// disabled, spinning) for as long as core1 spins. Nothing feeds the
// watchdog from inside that lockout, so the only way off the board is the
// watchdog itself firing at 8 s (see fw_rom_watchdog_start's
// pause_on_debug=false fix, in the same round). This function exists to
// let the bench PROVE that reset happens now, on demand, without having to
// wait for another real bug to reproduce it. The caller (main.c's
// WF_FW_DEBUG poll loop) logs before calling this -- core1 only ever
// produces log records (wf_log.h), never drains them, so whether that
// record reaches the USB port before the reset depends on core0's own
// drain winning the race against the lockout; the record itself is not
// lost either way.
void fw_rom_debug_wedge(void) {
    flash_safe_execute(debug_wedge_cb, NULL, UINT32_MAX);
}
#endif
