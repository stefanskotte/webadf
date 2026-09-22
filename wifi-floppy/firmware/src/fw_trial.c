#include "fw_trial.h"
#include <stdio.h>
#include <string.h>

fw_trial_action_t fw_trial_decide(const fw_trial_in_t *in, const char **reason) {
    *reason = NULL;
    if (!in->trial_boot) return FW_TRIAL_NONE;
    if (in->st->pending && strcmp(in->st->pending_version, in->running_version) != 0) {
        *reason = "version mismatch: the image does not report the release version";
        return FW_TRIAL_GIVE_UP;
    }
    if (in->ms_since_boot >= FW_TRIAL_DEADLINE_MS) {
        *reason = "no heartbeat within 5 minutes";
        return FW_TRIAL_GIVE_UP;
    }
    return in->heartbeat_ok ? FW_TRIAL_BUY : FW_TRIAL_WAIT;
}

static void clear_pending(fw_state_t *st) {
    st->pending = false;
    st->pending_sequence = 0;
    st->pending_version[0] = '\0';
    st->failure[0] = '\0';
}

bool fw_trial_after_buy(fw_state_t *st) {
    if (!st->pending) return false;
    st->installed_sequence = st->pending_sequence;
    clear_pending(st);
    return true;
}

fw_boot_t fw_boot_reconcile(fw_state_t *st, const char *running_version, char *err, int err_len) {
    if (!st->pending) return FW_BOOT_CLEAN;
    if (strcmp(st->pending_version, running_version) == 0) {
        st->installed_sequence = st->pending_sequence;
        clear_pending(st);
        return FW_BOOT_CONFIRMED_LATE;
    }
    snprintf(err, (size_t)err_len, "reverted: %s",
             st->failure[0] ? st->failure : "the new firmware did not confirm itself");
    clear_pending(st);
    return FW_BOOT_REVERTED;
}
