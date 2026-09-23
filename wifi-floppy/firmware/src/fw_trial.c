#include "fw_trial.h"
#include <stdio.h>
#include <string.h>

fw_trial_action_t fw_trial_decide(const fw_trial_in_t *in, const char **reason) {
    *reason = NULL;
    if (!in->trial_boot) return FW_TRIAL_NONE;
    if (in->st->pending && strcmp(in->st->pending_version, in->running_version) != 0) {
        *reason = "version mismatch";
        return FW_TRIAL_GIVE_UP;
    }
    // Final review I3: a USB-install trial (no pending record) has no image
    // of ours to revert to, so it has no deadline -- fw_rom_service does not
    // arm one either (fw_rom_set_trial_revertible). It waits for
    // connectivity however long the portal and pairing take (the watchdog
    // still covers a hang) and confirms whenever a heartbeat lands; with no
    // deadline reboot to race, the buy cutoff below does not apply.
    if (!in->st->pending) return in->heartbeat_ok ? FW_TRIAL_BUY : FW_TRIAL_WAIT;
    // Fix round 1 (Important 2): stop offering a buy once there is no longer
    // a safe margin before fw_rom_service's own deadline reboot -- a buy in
    // flight when that reboot fires can leave no bootable slot at all. At or
    // past the cutoff, give up instead of buying, even with a heartbeat.
    if (in->heartbeat_ok && in->ms_since_boot < FW_TRIAL_BUY_CUTOFF_MS) {
        return FW_TRIAL_BUY;
    }
    if (in->ms_since_boot >= FW_TRIAL_BUY_CUTOFF_MS) {
        // Final review I2: a heartbeat that landed only past the cutoff is
        // not "no heartbeat" -- the network worked, too late to confirm.
        *reason = in->heartbeat_ok ? "heartbeat came too late to confirm"
                                   : "no heartbeat within 5 minutes";
        return FW_TRIAL_GIVE_UP;
    }
    return FW_TRIAL_WAIT;
}

uint32_t fw_version_hash(const char *version) {
    uint32_t h = 0x811c9dc5u;
    for (const unsigned char *p = (const unsigned char *)version; *p; p++) {
        h ^= *p;
        h *= 0x01000193u;
    }
    return h;
}

bool fw_trial_proven(bool trial_boot, uint32_t scratch0, uint32_t scratch1,
                     const char *running_version) {
    return trial_boot && scratch0 == FW_PROVEN_MAGIC &&
           scratch1 == fw_version_hash(running_version);
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
