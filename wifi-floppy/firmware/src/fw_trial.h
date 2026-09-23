#ifndef FW_TRIAL_H
#define FW_TRIAL_H

#include "fw_state.h"

#define FW_TRIAL_DEADLINE_MS 300000u
// Fix round 1 (Important 2), kept in round 4: stop offering a buy this
// close to fw_rom_service's own deadline reboot (FW_TRIAL_DEADLINE_MS), so a
// proven trial's reboot-to-buy is always decided well before the deadline
// could race it. (Since round 4 the buy itself runs early in the NEXT boot,
// but a trial that proves itself at the last moment still gives up instead.)
#define FW_TRIAL_BUY_CUTOFF_MS (FW_TRIAL_DEADLINE_MS - 15000u)

typedef enum {
    FW_TRIAL_NONE,
    FW_TRIAL_WAIT,
    FW_TRIAL_BUY,
    FW_TRIAL_GIVE_UP
} fw_trial_action_t;

typedef struct {
    bool              trial_boot;       // boot ROM: TBYB buy pending on this boot
    const fw_state_t *st;               // loaded (zeroed if no record)
    const char       *running_version;  // WF_FIRMWARE_VERSION
    bool              heartbeat_ok;     // a status report naming running_version got a 2xx
    uint32_t          ms_since_boot;
} fw_trial_in_t;

fw_trial_action_t fw_trial_decide(const fw_trial_in_t *in, const char **reason);

// Fix round 4: the "proven" mark. A trial that proved itself on core1 does
// NOT buy there (calling the ROM buy from core1, with PSRAM live and core0
// running, wedged the board twice on the bench). It writes this mark to
// watchdog scratch[0] (and fw_version_hash(its version) to scratch[1]) and
// reboots into its own slot; the next boot, still a trial, sees the mark in
// main() before core1 or anything else starts, and buys there, single-core.
// "PRVN". scratch[0..3] are the application's: the boot ROM's reboot
// parameters use scratch[2..7] and the SDK's watchdog magic scratch[4..7],
// and the mark only uses [0..1].
#define FW_PROVEN_MAGIC 0x5052564eu
uint32_t fw_version_hash(const char *version);   // FNV-1a 32
// True only on a trial boot whose scratch[0..1] carry the mark for exactly
// running_version. Anything else is a plain trial (or no trial at all).
bool fw_trial_proven(bool trial_boot, uint32_t scratch0, uint32_t scratch1,
                     const char *running_version);
bool fw_trial_after_buy(fw_state_t *st);   // true if *st changed and must be saved

typedef enum {
    FW_BOOT_CLEAN,
    FW_BOOT_REVERTED,
    FW_BOOT_CONFIRMED_LATE
} fw_boot_t;

fw_boot_t fw_boot_reconcile(fw_state_t *st, const char *running_version, char *err, int err_len);

#endif // FW_TRIAL_H
