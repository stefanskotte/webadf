#ifndef BOOT_TRAIL_H
#define BOOT_TRAIL_H
// The boot trail (2026-10-19, fw 1.18.2): how far each core got, and why the chip last reset, kept where a
// watchdog or software reset does not clear it -- so the NEXT boot can tell the server where the previous one
// stopped, without a serial cable. A tester's board sat at "applying" after two updates and once went silent for
// 10 h with its IP still showing; a power cycle fixed each, and nothing said where it had stopped.
//
// Storage (boot_trail_hw.c): POWMAN SCRATCH0 (core0's word) and SCRATCH1 (core1's). They survive a watchdog reset
// and the firmware's own rom_reboot (the watchdog resets the PSM, not powman, unless CHIP_RESET asks it to -- the
// SDK never does), and are cleared by power-on, brown-out and the RUN pin. So a hang the WATCHDOG ends is reported
// with its stage; one a person ends by pulling the power is reported only as "power-on" (nothing survives that).
// pico_low_power uses SCRATCH6/7; the boot ROM uses the BOOT registers, not SCRATCH; watchdog SCRATCH0-1 are the
// proven/OTA marks (fw_trial.h) and 2-7 the ROM's reboot parameters and the SDK's magic -- so POWMAN 0-1.
//
// A word: 0xB7 in the top byte (the magic), the stage in bits 16-23, seconds since boot in bits 0-15 (saturating
// at 65535, ~18 h). Each core writes only its own word, so no read-modify-write crosses the cores.
//
// RULE: pure C, host-tested (test/test_boot_trail.c).
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// core0's stages, in boot order. NONE (0) is no record.
enum { BT0_NONE, BT0_EARLY, BT0_PSRAM, BT0_I2C, BT0_DISPLAY, BT0_NFC, BT0_LOOP, BT0_REBOOT };
// core1's stages.
enum { BT1_NONE, BT1_START, BT1_WIFI, BT1_SERVER, BT1_TRIAL, BT1_LOOP };
#define BT_STAGE_MAX BT0_REBOOT

// POWMAN CHIP_RESET's HAD_* bits (RP2350 datasheet, POWMAN CHIP_RESET; pico-sdk hardware/regs/powman.h --
// boot_trail_hw.c checks each against the SDK's at compile time).
#define BT_HAD_POR                   0x00010000u
#define BT_HAD_BOR                   0x00020000u
#define BT_HAD_RUN_LOW               0x00040000u
#define BT_HAD_DP_RESET_REQ          0x00080000u
#define BT_HAD_RESCUE                0x00200000u
#define BT_HAD_WATCHDOG_RESET_POWMAN_ASYNC 0x00400000u
#define BT_HAD_WATCHDOG_RESET_POWMAN 0x00800000u
#define BT_HAD_WATCHDOG_RESET_SWCORE 0x01000000u
#define BT_HAD_SWCORE_PD             0x02000000u
#define BT_HAD_GLITCH_DETECT         0x04000000u
#define BT_HAD_HZD_SYS_RESET_REQ     0x08000000u
#define BT_HAD_WATCHDOG_RESET_PSM    0x10000000u

typedef enum {
    BT_RESET_UNKNOWN, BT_RESET_POWER_ON, BT_RESET_BROWN_OUT, BT_RESET_RUN_PIN, BT_RESET_DEBUGGER,
    BT_RESET_GLITCH, BT_RESET_WATCHDOG, BT_RESET_SOFTWARE, BT_RESET_SYSRESET,
} bt_reset_t;

// The word for `stage` at `up_ms` since boot.
uint32_t bt_word(int stage, uint32_t up_ms);
// A word's stage and seconds. false: no record (no magic, or a stage out of range).
bool bt_word_read(uint32_t w, int *stage, uint32_t *up_s);
// Why the chip reset: CHIP_RESET, WATCHDOG REASON (TIMER bit 0, FORCE bit 1), and core0's word from the boot
// that ended. Power-on, brown-out and the RUN pin first (they clear the trail anyway); then a glitch or a
// debugger; then core0's word: BT0_REBOOT means the firmware asked for the reboot (fw_rom_service, the only
// place one happens) -- "software"; otherwise any watchdog sign is "watchdog": a hang it caught.
bt_reset_t bt_reset_reason(uint32_t chip_reset, uint32_t wd_reason, uint32_t w0);
const char *bt_reset_name(bt_reset_t r);
const char *bt_stage_name(int core, int stage);

// {"reset":"watchdog","c0":"nfc","up0":3,"c1":"wifi","up1":2}: the previous boot, as the status report's
// lastBoot. A core with no record is left out. -1 if it does not fit `cap` (never clipped); else its length.
#define BT_JSON_MAX 80
int bt_json(char *out, size_t cap, uint32_t chip_reset, uint32_t wd_reason, uint32_t w0, uint32_t w1);

// ---- device side (boot_trail_hw.c; not in the host build) ----
// First thing in main(): reads what the previous boot left (and CHIP_RESET, the watchdog's reason), keeps it for
// bt_hw_json, and starts this boot's trail at BT0_EARLY.
void bt_hw_capture(void);
// `core` 0 or 1: this core reached `stage`.
void bt_hw_mark(int core, int stage);
// Called often from a core's loop: rewrites its word with the current uptime, at most once a second.
void bt_hw_tick(int core);
// The previous boot, as bt_json made it at capture ("" if it did not fit).
const char *bt_hw_json(void);
#endif
