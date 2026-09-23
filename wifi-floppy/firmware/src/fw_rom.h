#ifndef FW_ROM_H
#define FW_ROM_H

#include <stdint.h>
#include <stdbool.h>

// FIRST statement of main(): single-core, before stdio, core1, PSRAM users.
// Loads boot info and the PT, consumes the "proven" mark in watchdog
// scratch[0..1], and on a proven trial boot performs the explicit buy here.
// Logs nothing (logging is not up yet); fw_rom_boot_init reports the outcome.
void fw_rom_boot_early(const char *running_version);
void fw_rom_boot_init(void);           // core0, after wf_log_init, before core1: logs boot info
bool fw_rom_trial_boot(void);          // this boot is an unconfirmed TBYB trial
int  fw_rom_booted_partition(void);    // 0, 1, or -1 (unpartitioned)
bool fw_rom_other_slot(uint32_t *flash_off, uint32_t *len);
// Any core. The trial proved itself: mark scratch[0..1] for running_version
// and request a FLASH_UPDATE reboot into the booted slot, so the next boot
// buys in fw_rom_boot_early. Refused (logged) if a reboot is already pending.
void fw_rom_request_proven_reboot(const char *running_version);
void fw_rom_request_reboot(uint32_t flash_update_off); // 0 = normal reboot; any core
void fw_rom_watchdog_start(void);      // core0, right before its loop
void fw_rom_service(void);             // core0, every loop turn: feed, deadline, honour reboot

#if WF_FW_DEBUG
// Bench-only (fix round 3): reproduces the nested-flash_safe_execute wedge
// shape on purpose, to prove the watchdog now resets the board instead of
// hanging forever. See fw_rom.c for what it does; never built into a
// release (WF_FW_DEBUG defaults OFF, and the publish script refuses an
// image built with it on).
void fw_rom_debug_wedge(void);
#endif

#endif // FW_ROM_H
