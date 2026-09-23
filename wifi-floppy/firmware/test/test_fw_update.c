#include "harness.h"
#include "../src/fw_update.h"
#include "../src/sha256.h"
#include <string.h>

static uint8_t stage[64];
static const char IMG[] = "new-firmware-image";
static int fetch_status; static int fetches, applies, saves, reboots;
static fw_apply_result_t apply_result;
static fw_state_t saved;

static int f_fetch(void *ctx, const char *v, fw_stage_t *s) {
    (void)ctx; (void)v; fetches++;
    if (fetch_status == 200) fw_stage_sink(s, (const uint8_t *)IMG, (int)strlen(IMG));
    return fetch_status;
}
static fw_apply_result_t f_apply(void *ctx, const uint8_t *img, uint32_t len, const char *sha, uint32_t *off) {
    (void)ctx; (void)img; (void)len; (void)sha; applies++; *off = 0x408000; return apply_result;
}
static bool f_save(void *ctx, const fw_state_t *st) { (void)ctx; saves++; saved = *st; return true; }
static void f_reboot(void *ctx, uint32_t off) { (void)ctx; (void)off; reboots++; }
static const fwu_ops_t OPS = { f_fetch, f_apply, f_save, f_reboot, NULL };

static fw_offer_t offer(void) {
    fw_offer_t o; memset(&o, 0, sizeof o);
    snprintf(o.version, sizeof o.version, "%s", "1.1.0+gnew");
    o.sequence = 5; o.size_bytes = (uint32_t)strlen(IMG);
    sha256_t s; uint8_t d[32]; sha256_init(&s); sha256_update(&s, (const uint8_t *)IMG, strlen(IMG));
    sha256_final(&s, d); sha256_hex(d, o.sha256);
    return o;
}
static fwu_t u; static fw_state_t st;
static void fresh(void) {
    fwu_init(&u, stage, sizeof stage); memset(&st, 0, sizeof st); st.installed_sequence = 4;
    memset(&saved, 0, sizeof saved);
    fetch_status = 200; apply_result = FWA_OK; fetches = applies = saves = reboots = 0;
}
static void run_until_quiet(bool idle) { for (int i = 0; i < 10; i++) fwu_step(&u, &OPS, &st, idle, 1000); }

static void test_fresh_updater_reports_nothing(void) {           // Review Focus 5
    fresh();
    CHECK(fwu_state_text(&u) == NULL, "a board that just booted claims no progress");
}
static void test_happy_path_ends_in_a_reboot_with_pending_recorded(void) {
    fresh();
    fw_offer_t o = offer(); fwu_on_instruction(&u, &o, FW_OK);
    CHECK(strcmp(fwu_state_text(&u), "queued") == 0, "queued first");
    run_until_quiet(true);
    CHECK_EQ_INT(u.phase, FWU_REBOOTING);
    CHECK_EQ_INT(reboots, 1);
    CHECK(saved.pending && saved.pending_sequence == 5 && strcmp(saved.pending_version, "1.1.0+gnew") == 0,
          "pending recorded BEFORE the reboot");
    CHECK_EQ_INT(saved.installed_sequence, 4);
}
static void test_each_step_is_one_phase_so_it_can_be_reported(void) {
    fresh();
    fw_offer_t o = offer(); fwu_on_instruction(&u, &o, FW_OK);
    CHECK(fwu_step(&u, &OPS, &st, true, 1000) && strcmp(fwu_state_text(&u), "downloading") == 0, "downloading, not yet fetched");
    CHECK_EQ_INT(fetches, 0);
    CHECK(fwu_step(&u, &OPS, &st, true, 1000) && u.phase == FWU_STAGED, "fetched and verified");
    CHECK(fwu_step(&u, &OPS, &st, true, 1000) && strcmp(fwu_state_text(&u), "applying") == 0, "applying, not yet written");
    CHECK_EQ_INT(applies, 0);
}
static void test_staged_waits_for_idle(void) {                    // Review Focus 3
    fresh();
    fw_offer_t o = offer(); fwu_on_instruction(&u, &o, FW_OK);
    run_until_quiet(false);
    CHECK_EQ_INT(u.phase, FWU_STAGED);
    CHECK_EQ_INT(applies, 0);
    CHECK(strcmp(fwu_state_text(&u), "queued") == 0, "reported as queued while it waits");
    run_until_quiet(true);
    CHECK_EQ_INT(applies, 1);
}
static void test_cancel_while_staged_never_applies(void) {        // Review Focus 2
    fresh();
    fw_offer_t o = offer(); fwu_on_instruction(&u, &o, FW_OK);
    run_until_quiet(false);
    fwu_on_instruction(&u, NULL, FW_OK);
    run_until_quiet(true);
    CHECK_EQ_INT(applies, 0);
    CHECK_EQ_INT(u.phase, FWU_IDLE);
    CHECK(fwu_state_text(&u) == NULL, "idle reports nothing");
}
static void test_refused_offer_fails_with_the_reason(void) {
    fresh();
    fw_offer_t o = offer(); fwu_on_instruction(&u, &o, FW_ROLLBACK);
    CHECK_EQ_INT(u.phase, FWU_FAILED);
    CHECK(strstr(fwu_error_text(&u), "anti-rollback") != NULL, "says why");
    run_until_quiet(true);
    CHECK_EQ_INT(fetches, 0);
}
static void test_new_instruction_after_failure_requeues(void) {  // Review Focus 4
    fresh();
    fw_offer_t o = offer(); fwu_on_instruction(&u, &o, FW_BAD_SIGNATURE);
    fwu_on_instruction(&u, &o, FW_OK);
    CHECK_EQ_INT(u.phase, FWU_QUEUED);
    CHECK(fwu_error_text(&u) == NULL, "the old failure is cleared");
}
static void test_hash_mismatch_fails_without_applying(void) {
    fresh();
    fw_offer_t o = offer(); o.sha256[0] = (o.sha256[0] == 'a') ? 'b' : 'a';
    fwu_on_instruction(&u, &o, FW_OK);
    run_until_quiet(true);
    CHECK_EQ_INT(u.phase, FWU_FAILED);
    CHECK_EQ_INT(applies, 0);
}
static void test_404_fails_5xx_retries_with_backoff(void) {
    fresh();
    fw_offer_t o = offer(); fwu_on_instruction(&u, &o, FW_OK);
    fetch_status = 503;
    fwu_step(&u, &OPS, &st, true, 1000);   // -> downloading
    fwu_step(&u, &OPS, &st, true, 1000);   // fetch 503 -> queued, retry later
    CHECK_EQ_INT(u.phase, FWU_QUEUED);
    CHECK(!fwu_step(&u, &OPS, &st, true, 1000 + FWU_RETRY_FLOOR_MS - 1), "not before the backoff");
    CHECK(fwu_step(&u, &OPS, &st, true, 1000 + FWU_RETRY_FLOOR_MS), "retried after it");
    fetch_status = 404;
    fwu_step(&u, &OPS, &st, true, 1000 + FWU_RETRY_FLOOR_MS);
    CHECK_EQ_INT(u.phase, FWU_FAILED);
}
static void test_flash_failure_is_reported_and_no_reboot(void) {
    fresh();
    apply_result = FWA_READBACK_MISMATCH;
    fw_offer_t o = offer(); fwu_on_instruction(&u, &o, FW_OK);
    run_until_quiet(true);
    CHECK_EQ_INT(u.phase, FWU_FAILED);
    CHECK_EQ_INT(reboots, 0);
    CHECK(!saved.pending, "nothing pending recorded for an image that did not write");
}

// Task 11 fix round 2: a refusal from main.c (malformed instruction, a board
// that cannot update) goes through the same point-of-no-return guard as
// fwu_on_instruction -- it may never knock an apply or a reboot back.
static void test_refuse_is_ignored_past_the_point_of_no_return(void) {
    fresh();
    fw_offer_t o = offer();
    fwu_on_instruction(&u, &o, FW_OK);
    run_until_quiet(true);
    CHECK_EQ_INT(u.phase, FWU_REBOOTING);
    fwu_refuse(&u, "refused: malformed update instruction");
    CHECK_EQ_INT(u.phase, FWU_REBOOTING);
    CHECK(fwu_error_text(&u) == NULL, "no error attached while rebooting");
}
static void test_refuse_while_queued_fails_with_the_reason(void) {
    fresh();
    fw_offer_t o = offer();
    fwu_on_instruction(&u, &o, FW_OK);
    CHECK_EQ_INT(u.phase, FWU_QUEUED);
    fwu_refuse(&u, "refused: this board cannot update");
    CHECK_EQ_INT(u.phase, FWU_FAILED);
    CHECK(fwu_error_text(&u) && strcmp(fwu_error_text(&u), "refused: this board cannot update") == 0,
          "the reason is reported");
}

int main(void) {
    RUN(test_fresh_updater_reports_nothing);
    RUN(test_happy_path_ends_in_a_reboot_with_pending_recorded);
    RUN(test_each_step_is_one_phase_so_it_can_be_reported);
    RUN(test_staged_waits_for_idle);
    RUN(test_cancel_while_staged_never_applies);
    RUN(test_refused_offer_fails_with_the_reason);
    RUN(test_new_instruction_after_failure_requeues);
    RUN(test_hash_mismatch_fails_without_applying);
    RUN(test_404_fails_5xx_retries_with_backoff);
    RUN(test_flash_failure_is_reported_and_no_reboot);
    RUN(test_refuse_is_ignored_past_the_point_of_no_return);
    RUN(test_refuse_while_queued_fails_with_the_reason);
    return REPORT();
}
