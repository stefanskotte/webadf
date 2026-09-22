#ifndef FW_TRIAL_H
#define FW_TRIAL_H

#include "fw_state.h"

#define FW_TRIAL_DEADLINE_MS 300000u

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
