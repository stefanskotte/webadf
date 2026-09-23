#ifndef FW_ROM_H
#define FW_ROM_H

#include <stdint.h>
#include <stdbool.h>

void fw_rom_boot_init(void);           // core0, before core1 launches: loads PT, records boot info
bool fw_rom_trial_boot(void);          // this boot is an unconfirmed TBYB trial
int  fw_rom_booted_partition(void);    // 0, 1, or -1 (unpartitioned)
bool fw_rom_other_slot(uint32_t *flash_off, uint32_t *len);
bool fw_rom_buy(void);                 // rom_explicit_buy (which itself uses flash_safe_execute) -- never wrap it in another one
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
