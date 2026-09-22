#include "harness.h"
#include "../src/fw_trial.h"
#include "../src/fw_state.h"
#include <string.h>

static fw_state_t st_pending(const char *ver, uint32_t seq) {
    fw_state_t s; memset(&s, 0, sizeof s);
    s.installed_sequence = seq - 1; s.pending = true; s.pending_sequence = seq;
    snprintf(s.pending_version, sizeof s.pending_version, "%s", ver);
    return s;
}
static fw_trial_in_t in_for(const fw_state_t *st, bool trial, bool hb, uint32_t ms) {
    fw_trial_in_t in = { trial, st, "1.1.0+gnew", hb, ms };
    return in;
}

static void test_a_normal_boot_is_not_a_trial(void) {
    fw_state_t s; memset(&s, 0, sizeof s);
    fw_trial_in_t in = in_for(&s, false, true, 0);
    const char *why = NULL;
    CHECK_EQ_INT(fw_trial_decide(&in, &why), FW_TRIAL_NONE);
}
static void test_waits_until_a_heartbeat_lands(void) {
    fw_state_t s = st_pending("1.1.0+gnew", 5);
    fw_trial_in_t in = in_for(&s, true, false, 1000);
    const char *why = NULL;
    CHECK_EQ_INT(fw_trial_decide(&in, &why), FW_TRIAL_WAIT);
}
static void test_buys_after_a_heartbeat(void) {
    fw_state_t s = st_pending("1.1.0+gnew", 5);
    fw_trial_in_t in = in_for(&s, true, true, 1000);
    const char *why = NULL;
    CHECK_EQ_INT(fw_trial_decide(&in, &why), FW_TRIAL_BUY);
}
// A mislabelled release: the server derives completion from the reported version, so a
// board that bought an image reporting a different version would leave the update
// "requested" forever. Give up at once, even with a heartbeat.
static void test_version_mismatch_gives_up_immediately(void) {
    fw_state_t s = st_pending("1.1.0+gOTHER", 5);
    fw_trial_in_t in = in_for(&s, true, true, 10);
    const char *why = NULL;
    CHECK_EQ_INT(fw_trial_decide(&in, &why), FW_TRIAL_GIVE_UP);
    CHECK(why && strstr(why, "version") != NULL, "the reason names the version");
}
static void test_deadline_gives_up(void) {
    fw_state_t s = st_pending("1.1.0+gnew", 5);
    fw_trial_in_t in = in_for(&s, true, true, FW_TRIAL_DEADLINE_MS);
    const char *why = NULL;
    CHECK_EQ_INT(fw_trial_decide(&in, &why), FW_TRIAL_GIVE_UP);
    CHECK(why && strstr(why, "5 minutes") != NULL, "the reason names the deadline");
}
// First USB install (D11): a trial boot with no pending record buys on connectivity alone
// and leaves installed_sequence alone.
static void test_usb_install_buys_without_a_pending_record(void) {
    fw_state_t s; memset(&s, 0, sizeof s);
    fw_trial_in_t in = in_for(&s, true, true, 1000);
    const char *why = NULL;
    CHECK_EQ_INT(fw_trial_decide(&in, &why), FW_TRIAL_BUY);
    CHECK(!fw_trial_after_buy(&s), "nothing to record after a USB install");
    CHECK_EQ_INT(s.installed_sequence, 0);
}
static void test_after_buy_records_the_sequence_and_clears_pending(void) {
    fw_state_t s = st_pending("1.1.0+gnew", 5);
    CHECK(fw_trial_after_buy(&s), "state changed");
    CHECK_EQ_INT(s.installed_sequence, 5);
    CHECK(!s.pending, "pending cleared");
    CHECK(s.pending_version[0] == '\0', "version cleared");
}
static void test_reconcile_clean_boot(void) {
    fw_state_t s; memset(&s, 0, sizeof s); s.installed_sequence = 4;
    char err[96] = "";
    CHECK_EQ_INT(fw_boot_reconcile(&s, "1.0.0+gold", err, sizeof err), FW_BOOT_CLEAN);
    CHECK_EQ_INT(s.installed_sequence, 4);
}
// The old image booted with a pending record: the trial did not stick.
static void test_reconcile_revert_reports_the_trial_reason(void) {
    fw_state_t s = st_pending("1.1.0+gnew", 5);
    snprintf(s.failure, sizeof s.failure, "%s", "no heartbeat within 5 minutes");
    char err[96] = "";
    CHECK_EQ_INT(fw_boot_reconcile(&s, "1.0.0+gold", err, sizeof err), FW_BOOT_REVERTED);
    CHECK(strstr(err, "reverted") && strstr(err, "no heartbeat"), "names what happened and why");
    CHECK(!s.pending && s.failure[0] == '\0', "cleared so it is reported once");
    CHECK_EQ_INT(s.installed_sequence, 4);
}
// A hang or power cut leaves no reason behind: say so rather than inventing one.
static void test_reconcile_revert_without_a_reason(void) {
    fw_state_t s = st_pending("1.1.0+gnew", 5);
    char err[96] = "";
    CHECK_EQ_INT(fw_boot_reconcile(&s, "1.0.0+gold", err, sizeof err), FW_BOOT_REVERTED);
    CHECK(strstr(err, "did not confirm") != NULL, "honest about not knowing why");
}
// Bought, but power was lost before the state write: the running image IS the pending one.
static void test_reconcile_confirms_a_buy_whose_record_was_lost(void) {
    fw_state_t s = st_pending("1.1.0+gnew", 5);
    char err[96] = "";
    CHECK_EQ_INT(fw_boot_reconcile(&s, "1.1.0+gnew", err, sizeof err), FW_BOOT_CONFIRMED_LATE);
    CHECK_EQ_INT(s.installed_sequence, 5);
    CHECK(!s.pending, "cleared");
}

// Verify that all GIVE_UP reasons fit in the failure field (FW_STATE_REASON_MAX = 48 bytes).
static void test_give_up_reasons_fit_in_failure_field(void) {
    // Test version mismatch reason
    {
        fw_state_t s = st_pending("1.1.0+gOTHER", 5);
        fw_trial_in_t in = in_for(&s, true, true, 10);
        const char *why = NULL;
        CHECK_EQ_INT(fw_trial_decide(&in, &why), FW_TRIAL_GIVE_UP);
        CHECK(why != NULL, "reason is set");
        CHECK(strlen(why) <= FW_STATE_REASON_MAX,
              "version mismatch reason fits in failure field");
    }
    // Test deadline reason
    {
        fw_state_t s = st_pending("1.1.0+gnew", 5);
        fw_trial_in_t in = in_for(&s, true, true, FW_TRIAL_DEADLINE_MS);
        const char *why = NULL;
        CHECK_EQ_INT(fw_trial_decide(&in, &why), FW_TRIAL_GIVE_UP);
        CHECK(why != NULL, "reason is set");
        CHECK(strlen(why) <= FW_STATE_REASON_MAX,
              "deadline reason fits in failure field");
    }
}

// USB install with no heartbeat that reaches deadline gives up (not a buy).
static void test_usb_install_no_heartbeat_at_deadline_gives_up(void) {
    fw_state_t s; memset(&s, 0, sizeof s);
    fw_trial_in_t in = in_for(&s, true, false, FW_TRIAL_DEADLINE_MS);
    const char *why = NULL;
    CHECK_EQ_INT(fw_trial_decide(&in, &why), FW_TRIAL_GIVE_UP);
    CHECK(why && strstr(why, "5 minutes") != NULL, "reason names the deadline");
}

// Fix round 1 (Important 2): buy vs. deadline-reboot race. A heartbeat that
// lands right at the cutoff must NOT buy -- there would be no margin left
// before fw_rom_service's own deadline reboot could fire mid-buy.
static void test_heartbeat_at_the_buy_cutoff_gives_up(void) {
    fw_state_t s = st_pending("1.1.0+gnew", 5);
    fw_trial_in_t in = in_for(&s, true, true, FW_TRIAL_BUY_CUTOFF_MS);
    const char *why = NULL;
    CHECK_EQ_INT(fw_trial_decide(&in, &why), FW_TRIAL_GIVE_UP);
    CHECK(why && strstr(why, "5 minutes") != NULL, "reason names the deadline");
}
// One millisecond earlier, there is still a full cutoff window left: buy.
static void test_heartbeat_just_before_the_buy_cutoff_buys(void) {
    fw_state_t s = st_pending("1.1.0+gnew", 5);
    fw_trial_in_t in = in_for(&s, true, true, FW_TRIAL_BUY_CUTOFF_MS - 1);
    const char *why = NULL;
    CHECK_EQ_INT(fw_trial_decide(&in, &why), FW_TRIAL_BUY);
}

int main(void) {
    RUN(test_a_normal_boot_is_not_a_trial);
    RUN(test_waits_until_a_heartbeat_lands);
    RUN(test_buys_after_a_heartbeat);
    RUN(test_version_mismatch_gives_up_immediately);
    RUN(test_deadline_gives_up);
    RUN(test_usb_install_buys_without_a_pending_record);
    RUN(test_after_buy_records_the_sequence_and_clears_pending);
    RUN(test_reconcile_clean_boot);
    RUN(test_reconcile_revert_reports_the_trial_reason);
    RUN(test_reconcile_revert_without_a_reason);
    RUN(test_reconcile_confirms_a_buy_whose_record_was_lost);
    RUN(test_give_up_reasons_fit_in_failure_field);
    RUN(test_usb_install_no_heartbeat_at_deadline_gives_up);
    RUN(test_heartbeat_at_the_buy_cutoff_gives_up);
    RUN(test_heartbeat_just_before_the_buy_cutoff_buys);
    return REPORT();
}
