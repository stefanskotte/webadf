#ifndef FW_TRIAL_H
#define FW_TRIAL_H

#include "fw_state.h"

#define FW_TRIAL_DEADLINE_MS 300000u
// Fix round 1 (Important 2): buy vs. deadline-reboot race. fw_rom_buy's
// flash_safe_execute can still be in flight when core0's deadline check
// (fw_rom_service, at FW_TRIAL_DEADLINE_MS) decides to reboot for reverting;
// a reset mid-buy can leave the old slot's header erased and the new image
// unbought -- no bootable slot at all. Stop offering a buy this close to the
// deadline, so any buy that does start has the whole cutoff window to finish
// well before fw_rom_service's own reboot could fire.
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
bool fw_trial_after_buy(fw_state_t *st);   // true if *st changed and must be saved

typedef enum {
    FW_BOOT_CLEAN,
    FW_BOOT_REVERTED,
    FW_BOOT_CONFIRMED_LATE
} fw_boot_t;

fw_boot_t fw_boot_reconcile(fw_state_t *st, const char *running_version, char *err, int err_len);

#endif // FW_TRIAL_H
