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
    free(mem);
    return REPORT();
}
