#include "harness.h"
#include "../src/provisioning.h"
#include "../src/config_store.h"
#include "../src/psram_image.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static device_config_t mk(const char *s) {
    device_config_t c;
    memset(&c, 0, sizeof c);
    snprintf(c.ssid, sizeof c.ssid, "%s", s);
    snprintf(c.pass, sizeof c.pass, "password");
    snprintf(c.code, sizeof c.code, "ABC123");
    return c;
}

static void test_no_config_starts_in_the_portal(void) {
    config_store_erase();
    provisioning_t p;
    prov_init(&p);
    CHECK_EQ_INT(p.state, PROV_PORTAL);
    CHECK(!p.have_config, "nothing to run with");
}

static void test_stored_config_starts_running(void) {
    config_store_erase();
    device_config_t c = mk("net");
    CHECK(config_store_save(&c), "seed config");
    provisioning_t p;
    prov_init(&p);
    CHECK_EQ_INT(p.state, PROV_RUNNING);
    CHECK(strcmp(p.cfg.ssid, "net") == 0,
          "the config is loaded, not merely detected -- main.c associates with p.cfg");
}

static void test_portal_opens_after_exactly_three_failures(void) {
    config_store_erase();
    device_config_t c = mk("net");
    config_store_save(&c);
    provisioning_t p;
    prov_init(&p);
    CHECK_EQ_INT(prov_on_assoc_result(&p, false), PROV_RUNNING);   // 1
    CHECK_EQ_INT(prov_on_assoc_result(&p, false), PROV_RUNNING);   // 2
    CHECK_EQ_INT(prov_on_assoc_result(&p, false), PROV_PORTAL);    // 3
}

static void test_a_success_resets_the_counter(void) {
    config_store_erase();
    device_config_t c = mk("net");
    config_store_save(&c);
    provisioning_t p;
    prov_init(&p);
    prov_on_assoc_result(&p, false);
    prov_on_assoc_result(&p, false);
    CHECK_EQ_INT(prov_on_assoc_result(&p, true), PROV_RUNNING);
    CHECK_EQ_INT(p.assoc_failures, 0);
    // Two further failures must NOT open the portal: the count restarted,
    // so a board that reconnects between outages never accumulates toward
    // AP mode across them.
    CHECK_EQ_INT(prov_on_assoc_result(&p, false), PROV_RUNNING);
    CHECK_EQ_INT(prov_on_assoc_result(&p, false), PROV_RUNNING);
}

static void test_verified_submit_commits_and_runs(void) {
    config_store_erase();
    provisioning_t p;
    prov_init(&p);
    CHECK_EQ_INT(p.state, PROV_PORTAL);
    device_config_t c = mk("new-net");
    CHECK(prov_on_verified_submit(&p, &c), "commit");
    CHECK_EQ_INT(p.state, PROV_RUNNING);
    device_config_t stored;
    CHECK(config_store_load(&stored), "credentials were persisted");
    CHECK(strcmp(stored.ssid, "new-net") == 0, "the submitted ssid");
    CHECK(strcmp(p.cfg.ssid, "new-net") == 0,
          "and are live in the struct, so main.c does not need to reload");
}

static void test_a_failed_commit_does_not_claim_to_be_running(void) {
    // config_store_save() refuses while a disk is mounted. If the commit
    // fails, staying in PROV_PORTAL is the honest outcome -- reporting
    // RUNNING would send main.c off to associate with credentials that
    // were never stored, and the next boot would land back in the portal
    // with no explanation.
    config_store_erase();
    provisioning_t p;
    prov_init(&p);
    psram_publish_slot(0);
    device_config_t c = mk("new-net");
    CHECK(!prov_on_verified_submit(&p, &c), "commit refused while mounted");
    CHECK_EQ_INT(p.state, PROV_PORTAL);
    psram_publish_slot(SLOT_NONE);
}

static void test_rejected_pairing_code_returns_to_the_portal(void) {
    // Spec D-4b-4. The code now lives in flash and can outlive its
    // 10-minute TTL, so a 400 is terminal rather than retried forever.
    config_store_erase();
    device_config_t c = mk("net");
    config_store_save(&c);
    provisioning_t p;
    prov_init(&p);
    CHECK_EQ_INT(prov_on_pairing_code_rejected(&p), PROV_PORTAL);
    device_config_t stored;
    CHECK(!config_store_load(&stored),
          "a rejected code must clear the stored config so a fresh one can be entered");
    CHECK(!p.have_config, "and the in-memory copy must go with it");
}

// --- Final review, Important 2: the portal is no longer a one-way door ---

// The scenario: a power cut drops the router and the board together. The
// board boots first, burns its three attempts in the 45 s the router is
// still starting up, and opens the portal. With an unbounded wait it stayed
// there until a human arrived with a phone; now an idle window sends it
// back to re-try what is still in flash.
static void test_idle_timeout_retries_the_stored_config(void) {
    config_store_erase();
    device_config_t c = mk("net");
    config_store_save(&c);
    provisioning_t p;
    prov_init(&p);
    prov_on_assoc_result(&p, false);
    prov_on_assoc_result(&p, false);
    CHECK_EQ_INT(prov_on_assoc_result(&p, false), PROV_PORTAL);

    CHECK(prov_on_portal_idle_timeout(&p), "there is a config to re-try");
    CHECK_EQ_INT(p.state, PROV_RUNNING);
    CHECK_EQ_INT(p.assoc_failures, 0);
    CHECK(strcmp(p.cfg.ssid, "net") == 0,
          "the stored credentials are still the ones main.c will associate with");
    CHECK(config_store_load(&c),
          "and nothing was erased -- an idle portal is not a failure");
}

// ...and if the router really is gone, the re-try fails its three attempts
// and the portal opens again. A slow sweep, not a permanent strand, and
// not a permanent RUNNING either.
static void test_a_failed_retry_returns_to_the_portal(void) {
    config_store_erase();
    device_config_t c = mk("net");
    config_store_save(&c);
    provisioning_t p;
    prov_init(&p);
    for (int i = 0; i < PROV_MAX_ASSOC_FAILURES; i++) prov_on_assoc_result(&p, false);
    CHECK_EQ_INT(p.state, PROV_PORTAL);
    CHECK(prov_on_portal_idle_timeout(&p), "back to RUNNING");
    CHECK_EQ_INT(prov_on_assoc_result(&p, false), PROV_RUNNING);   // 1
    CHECK_EQ_INT(prov_on_assoc_result(&p, false), PROV_RUNNING);   // 2
    CHECK_EQ_INT(prov_on_assoc_result(&p, false), PROV_PORTAL);    // 3
    CHECK(prov_on_portal_idle_timeout(&p), "and it can sweep again");
}

// Nothing stored means nothing to re-try: main.c reads the false return as
// "wait indefinitely", so the AP is never bounced under someone who is
// halfway through the form on a board that only a human can move forward.
static void test_idle_timeout_does_nothing_without_a_config(void) {
    config_store_erase();
    provisioning_t p;
    prov_init(&p);
    CHECK_EQ_INT(p.state, PROV_PORTAL);
    CHECK(!prov_on_portal_idle_timeout(&p), "nothing to re-try");
    CHECK_EQ_INT(p.state, PROV_PORTAL);
    CHECK(!p.have_config, "and it did not invent one");
}

// The same holds after a rejected pairing code, which is the other way to
// reach the portal with have_config false: re-trying there would associate
// fine and then be rejected by the server all over again, bouncing the AP
// every window for nothing.
static void test_idle_timeout_does_not_retry_a_rejected_pairing_code(void) {
    config_store_erase();
    device_config_t c = mk("net");
    config_store_save(&c);
    provisioning_t p;
    prov_init(&p);
    prov_on_pairing_code_rejected(&p);
    CHECK(!prov_on_portal_idle_timeout(&p),
          "a dead pairing code is not fixed by trying it again");
    CHECK_EQ_INT(p.state, PROV_PORTAL);
}

int main(void) {
    size_t len = (size_t)TRACK_MAX_BYTES * NUM_TRACKS * SLOT_COUNT;
    void *mem = malloc(len);
    psram_image_set_backing(mem, len);
    RUN(test_no_config_starts_in_the_portal);
    RUN(test_stored_config_starts_running);
    RUN(test_portal_opens_after_exactly_three_failures);
    RUN(test_a_success_resets_the_counter);
    RUN(test_verified_submit_commits_and_runs);
    RUN(test_a_failed_commit_does_not_claim_to_be_running);
    RUN(test_rejected_pairing_code_returns_to_the_portal);
    RUN(test_idle_timeout_retries_the_stored_config);
    RUN(test_a_failed_retry_returns_to_the_portal);
    RUN(test_idle_timeout_does_nothing_without_a_config);
    RUN(test_idle_timeout_does_not_retry_a_rejected_pairing_code);
    free(mem);
    return REPORT();
}
