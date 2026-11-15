#include "harness.h"
#include "../src/provisioning.h"
#include "../src/config_store.h"
#include "../src/psram_image.h"
#include "../src/token_store.h"
#include "../src/secure_zero.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// One saved network (the layout every board in the field had before
// 2026-11-15), as a stored config.
static device_config_t mk(const char *s) {
    device_config_t c;
    memset(&c, 0, sizeof c);
    snprintf(c.net[0].ssid, sizeof c.net[0].ssid, "%s", s);
    snprintf(c.net[0].pass, sizeof c.net[0].pass, "password");
    c.n_nets = 1;
    c.last = 0;
    snprintf(c.code, sizeof c.code, "ABC123");
    return c;
}

// What the portal hands over: one network and maybe a code ("" = keep).
static setup_form_t form(const char *ssid, const char *pass, const char *code) {
    setup_form_t f;
    memset(&f, 0, sizeof f);
    snprintf(f.ssid, sizeof f.ssid, "%s", ssid);
    snprintf(f.pass, sizeof f.pass, "%s", pass);
    snprintf(f.code, sizeof f.code, "%s", code);
    return f;
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
    CHECK(strcmp(p.cfg.net[prov_next_net(&p)].ssid, "net") == 0,
          "the config is loaded, not merely detected -- main.c associates with p.cfg");
}

static void test_portal_opens_after_exactly_three_failures(void) {
    config_store_erase();
    device_config_t c = mk("net");
    config_store_save(&c);
    provisioning_t p;
    prov_init(&p);
    CHECK_EQ_INT(prov_on_join_result(&p, NET_JOIN_NOT_FOUND), PROV_RUNNING);   // 1
    CHECK_EQ_INT(prov_on_join_result(&p, NET_JOIN_NOT_FOUND), PROV_RUNNING);   // 2
    CHECK_EQ_INT(prov_on_join_result(&p, NET_JOIN_NOT_FOUND), PROV_PORTAL);    // 3
}

static void test_a_success_resets_the_counter(void) {
    config_store_erase();
    device_config_t c = mk("net");
    config_store_save(&c);
    provisioning_t p;
    prov_init(&p);
    prov_on_join_result(&p, NET_JOIN_NOT_FOUND);
    prov_on_join_result(&p, NET_JOIN_NOT_FOUND);
    CHECK_EQ_INT(prov_on_join_result(&p, NET_JOIN_OK), PROV_RUNNING);
    CHECK_EQ_INT(p.assoc_failures, 0);
    // Two further failures must NOT open the portal: the count restarted,
    // so a board that reconnects between outages never accumulates toward
    // AP mode across them.
    CHECK_EQ_INT(prov_on_join_result(&p, NET_JOIN_NOT_FOUND), PROV_RUNNING);
    CHECK_EQ_INT(prov_on_join_result(&p, NET_JOIN_NOT_FOUND), PROV_RUNNING);
}

static void test_verified_submit_commits_and_runs(void) {
    config_store_erase();
    provisioning_t p;
    prov_init(&p);
    CHECK_EQ_INT(p.state, PROV_PORTAL);
    setup_form_t c = form("new-net", "password", "ABC123");
    CHECK(prov_on_verified_submit(&p, &c), "commit");
    CHECK_EQ_INT(p.state, PROV_RUNNING);
    device_config_t stored;
    CHECK(config_store_load(&stored), "credentials were persisted");
    CHECK(strcmp(stored.net[stored.last].ssid, "new-net") == 0, "the submitted ssid");
    CHECK(strcmp(p.cfg.net[prov_next_net(&p)].ssid, "new-net") == 0,
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
    setup_form_t c = form("new-net", "password", "ABC123");
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
    prov_on_join_result(&p, NET_JOIN_NOT_FOUND);
    prov_on_join_result(&p, NET_JOIN_NOT_FOUND);
    CHECK_EQ_INT(prov_on_join_result(&p, NET_JOIN_NOT_FOUND), PROV_PORTAL);

    CHECK(prov_on_portal_idle_timeout(&p), "there is a config to re-try");
    CHECK_EQ_INT(p.state, PROV_RUNNING);
    CHECK_EQ_INT(p.assoc_failures, 0);
    CHECK(strcmp(p.cfg.net[prov_next_net(&p)].ssid, "net") == 0,
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
    for (int i = 0; i < PROV_MAX_ASSOC_FAILURES; i++) prov_on_join_result(&p, NET_JOIN_NOT_FOUND);
    CHECK_EQ_INT(p.state, PROV_PORTAL);
    CHECK(prov_on_portal_idle_timeout(&p), "back to RUNNING");
    CHECK_EQ_INT(prov_on_join_result(&p, NET_JOIN_NOT_FOUND), PROV_RUNNING);   // 1
    CHECK_EQ_INT(prov_on_join_result(&p, NET_JOIN_NOT_FOUND), PROV_RUNNING);   // 2
    CHECK_EQ_INT(prov_on_join_result(&p, NET_JOIN_NOT_FOUND), PROV_PORTAL);    // 3
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

// --- Several networks (field report 2026-11-14) ---

// Three saved networks a, b, c; the record's page 0 holds b (cfg.last = 1).
static void seed_three(void) {
    config_store_erase();
    device_config_t c = mk("a");
    snprintf(c.net[1].ssid, sizeof c.net[1].ssid, "b");
    snprintf(c.net[1].pass, sizeof c.net[1].pass, "password-b");
    snprintf(c.net[2].ssid, sizeof c.net[2].ssid, "c");
    snprintf(c.net[2].pass, sizeof c.net[2].pass, "password-c");
    c.n_nets = 3;
    c.last = 1;
    CHECK(config_store_save(&c), "seed three networks");
}

static const char *next_ssid(const provisioning_t *p) {
    int i = prov_next_net(p);
    return i < 0 ? "(none)" : p->cfg.net[i].ssid;
}

// Review I2 (operator 2026-11-15): at power-on the order is the saved order,
// whatever page 0 holds.
static void test_at_power_on_a_round_goes_in_saved_order(void) {
    seed_three();
    provisioning_t p;
    prov_init(&p);
    CHECK(!p.joined, "nothing joined yet: the page marks no network as joined last");
    CHECK(strcmp(next_ssid(&p), "a") == 0, "the first saved network goes first");
    prov_on_join_result(&p, NET_JOIN_NOT_FOUND);
    CHECK(strcmp(next_ssid(&p), "b") == 0, "then the others in saved order");
    prov_on_join_result(&p, NET_JOIN_NOT_FOUND);
    CHECK(strcmp(next_ssid(&p), "c") == 0, "...");
    prov_on_join_result(&p, NET_JOIN_NOT_FOUND);
    CHECK(strcmp(next_ssid(&p), "a") == 0, "and the next round starts over");
    CHECK_EQ_INT(p.assoc_failures, 1);
}

// The existing rule, per round: the portal opens after three whole rounds,
// never after three attempts that did not cover every network.
static void test_portal_opens_after_three_failed_rounds(void) {
    seed_three();
    provisioning_t p;
    prov_init(&p);
    for (int i = 0; i < 3 * 3 - 1; i++)
        CHECK_EQ_INT(prov_on_join_result(&p, NET_JOIN_NOT_FOUND), PROV_RUNNING);
    CHECK_EQ_INT(prov_on_join_result(&p, NET_JOIN_NOT_FOUND), PROV_PORTAL);
}

static void test_a_success_anywhere_ends_the_run_and_goes_first_this_session(void) {
    seed_three();
    provisioning_t p;
    prov_init(&p);
    for (int i = 0; i < 3 * 2; i++) prov_on_join_result(&p, NET_JOIN_NOT_FOUND);   // two rounds
    prov_on_join_result(&p, NET_JOIN_NOT_FOUND);   // a
    prov_on_join_result(&p, NET_JOIN_NOT_FOUND);   // b
    CHECK_EQ_INT(prov_on_join_result(&p, NET_JOIN_OK), PROV_RUNNING);   // c
    CHECK_EQ_INT(p.assoc_failures, 0);
    CHECK_EQ_INT(p.round_pos, 0);
    CHECK(strcmp(next_ssid(&p), "c") == 0, "the network that worked is tried first now");
    CHECK(p.joined, "and it counts as joined this session");
    prov_on_join_result(&p, NET_JOIN_NOT_FOUND);
    CHECK(strcmp(next_ssid(&p), "a") == 0, "then the others, in saved order");
}

// Review I2: joining never writes flash -- a cut during the sector erase would
// lose every network, and the board's Amiga is switched off often.
static void test_joining_never_writes_flash(void) {
    seed_three();
    CHECK(token_store_save("tok-paired"), "a paired board");
    provisioning_t p;
    prov_init(&p);
    unsigned char before[CONFIG_STORE_RECORD_BYTES];
    memcpy(before, config_store_test_raw(), sizeof before);
    prov_on_join_result(&p, NET_JOIN_NOT_FOUND);   // a, absent
    prov_on_join_result(&p, NET_JOIN_OK);          // b
    CHECK(memcmp(before, config_store_test_raw(), sizeof before) == 0,
          "joining another network wrote nothing");
    provisioning_t q;
    prov_init(&q);   // the next power-on
    CHECK(strcmp(next_ssid(&q), "a") == 0, "and the next boot starts with the saved order");
    char tok[64];
    CHECK(token_store_load(tok, sizeof tok), "the token is untouched");
}

static void test_a_submit_without_a_code_adds_a_network_and_keeps_the_pairing(void) {
    config_store_erase();
    device_config_t c = mk("home");
    CHECK(config_store_save(&c), "seed");
    CHECK(token_store_save("tok-paired"), "paired");
    provisioning_t p;
    prov_init(&p);
    for (int i = 0; i < PROV_MAX_ASSOC_FAILURES; i++) prov_on_join_result(&p, NET_JOIN_NOT_FOUND);
    CHECK_EQ_INT(p.state, PROV_PORTAL);
    setup_form_t f = form("hotspot", "hotspot-pw", "");
    CHECK(prov_on_verified_submit(&p, &f), "added");
    CHECK_EQ_INT(p.state, PROV_RUNNING);
    device_config_t stored;
    CHECK(config_store_load(&stored), "stored");
    CHECK_EQ_INT(stored.n_nets, 2);
    CHECK(strcmp(stored.net[0].ssid, "home") == 0, "appended after the existing one");
    CHECK(strcmp(stored.net[1].ssid, "hotspot") == 0, "the new one");
    CHECK_EQ_INT(stored.last, 1);   // page 0: the network just verified
    CHECK(strcmp(stored.code, "ABC123") == 0, "the stored code is kept");
    char tok[64];
    CHECK(token_store_load(tok, sizeof tok) && strcmp(tok, "tok-paired") == 0,
          "adding a network is not a re-pair: the token stays");
    CHECK(strcmp(next_ssid(&p), "hotspot") == 0, "the verified network is tried first this session");
}

// The erase window (config_store.c): a cut during the sector erase loses the
// record, but the token survives in its own sector. The board is still paired,
// so a network alone -- no code -- brings it back.
static void test_a_lost_record_with_a_live_token_needs_no_new_code(void) {
    config_store_erase();
    CHECK(token_store_save("tok-survivor"), "the token outlived the record");
    provisioning_t p;
    prov_init(&p);
    CHECK_EQ_INT(p.state, PROV_PORTAL);
    CHECK(prov_paired(&p), "still paired");
    setup_form_t f = form("home", "password", "");
    CHECK(prov_on_verified_submit(&p, &f), "a network alone is enough");
    char tok[64];
    CHECK(token_store_load(tok, sizeof tok) && strcmp(tok, "tok-survivor") == 0, "the token is kept");
    device_config_t stored;
    CHECK(config_store_load(&stored) && strcmp(stored.net[0].ssid, "home") == 0, "and the network saved");
}

static void test_a_submit_with_a_code_is_a_new_pairing(void) {
    config_store_erase();
    device_config_t c = mk("home");
    CHECK(config_store_save(&c), "seed");
    CHECK(token_store_save("tok-old"), "paired");
    provisioning_t p;
    prov_init(&p);
    setup_form_t f = form("home", "new-password", "NEW999");
    CHECK(prov_on_verified_submit(&p, &f), "committed");
    device_config_t stored;
    CHECK(config_store_load(&stored), "stored");
    CHECK_EQ_INT(stored.n_nets, 1);
    CHECK(strcmp(stored.net[0].pass, "new-password") == 0, "a saved SSID gets its new password in place");
    CHECK(strcmp(stored.code, "NEW999") == 0, "the new code");
    char tok[64];
    CHECK(!token_store_load(tok, sizeof tok), "a new code erases the token, as every submit did before");
}

static void test_a_submit_without_any_pairing_is_refused(void) {
    config_store_erase();   // erases the token too
    provisioning_t p;
    prov_init(&p);
    CHECK(!prov_paired(&p), "not paired");
    setup_form_t f = form("home", "password", "");
    CHECK(!prov_on_verified_submit(&p, &f), "nothing to pair with");
    CHECK_EQ_INT(p.state, PROV_PORTAL);
    device_config_t stored;
    CHECK(!config_store_load(&stored), "nothing was written");
}

static void test_a_fifth_network_is_refused_and_nothing_is_lost(void) {
    config_store_erase();
    device_config_t c = mk("n0");
    for (int i = 1; i < CONFIG_NETS_MAX; i++) {
        snprintf(c.net[i].ssid, sizeof c.net[i].ssid, "n%d", i);
        snprintf(c.net[i].pass, sizeof c.net[i].pass, "password");
    }
    c.n_nets = CONFIG_NETS_MAX;
    CHECK(config_store_save(&c), "four saved");
    provisioning_t p;
    prov_init(&p);
    setup_form_t f = form("fifth", "password", "");
    CHECK(!prov_on_verified_submit(&p, &f), "full: refused, not a silent replacement");
    device_config_t stored;
    CHECK(config_store_load(&stored), "stored");
    CHECK_EQ_INT(stored.n_nets, CONFIG_NETS_MAX);
    CHECK_EQ_INT(config_find_net(&stored, "fifth"), -1);
    CHECK_EQ_INT(p.cfg.n_nets, CONFIG_NETS_MAX);
    // An SSID already saved still updates in place when full.
    setup_form_t g = form("n2", "changed-pw", "");
    CHECK(prov_on_verified_submit(&p, &g), "a saved network's password can change when full");
    CHECK(config_store_load(&stored) && strcmp(stored.net[2].pass, "changed-pw") == 0, "in place");
}

static void test_remove_a_network(void) {
    seed_three();
    CHECK(token_store_save("tok-paired"), "paired");
    provisioning_t p;
    prov_init(&p);
    prov_on_join_result(&p, NET_JOIN_NOT_FOUND);   // a
    prov_on_join_result(&p, NET_JOIN_NOT_FOUND);   // b
    prov_on_join_result(&p, NET_JOIN_OK);          // c: joined this session
    CHECK_EQ_INT(prov_forget_network(&p, "a"), PROV_FORGOT);
    device_config_t stored;
    CHECK(config_store_load(&stored), "stored");
    CHECK_EQ_INT(stored.n_nets, 2);
    CHECK(strcmp(stored.net[0].ssid, "b") == 0 && strcmp(stored.net[1].ssid, "c") == 0, "order kept");
    CHECK(strcmp(stored.net[stored.last].ssid, "c") == 0,
          "a user save puts the network joined this session in page 0");
    CHECK(strcmp(next_ssid(&p), "c") == 0, "first still follows c");
    char tok[64];
    CHECK(token_store_load(tok, sizeof tok), "removing a network is not a re-pair");

    CHECK_EQ_INT(prov_forget_network(&p, "c"), PROV_FORGOT);   // the one joined goes too
    CHECK(config_store_load(&stored) && stored.n_nets == 1 && strcmp(stored.net[0].ssid, "b") == 0,
          "one left");
    CHECK(strcmp(next_ssid(&p), "b") == 0, "first falls back to the saved order");
    CHECK_EQ_INT(prov_forget_network(&p, "b"), PROV_FORGET_ONLY_ONE);
    CHECK_EQ_INT(prov_forget_network(&p, "zzz"), PROV_FORGET_NOT_SAVED);
}

// Review M6: the page must say WHY -- config_store's guard is a mounted disk.
static void test_remove_refused_while_a_disk_is_mounted_says_so(void) {
    seed_three();
    provisioning_t p;
    prov_init(&p);
    unsigned char before[CONFIG_STORE_RECORD_BYTES];
    memcpy(before, config_store_test_raw(), sizeof before);
    psram_publish_slot(0);
    CHECK_EQ_INT(prov_forget_network(&p, "a"), PROV_FORGET_DISK_MOUNTED);
    psram_publish_slot(SLOT_NONE);
    CHECK_EQ_INT(p.cfg.n_nets, 3);
    CHECK(config_find_net(&p.cfg, "a") >= 0, "RAM unchanged");
    CHECK(memcmp(before, config_store_test_raw(), sizeof before) == 0, "flash unchanged");
}

static void test_idle_timeout_starts_a_fresh_round(void) {
    seed_three();
    provisioning_t p;
    prov_init(&p);
    for (int i = 0; i < 3 * 3; i++) prov_on_join_result(&p, NET_JOIN_NOT_FOUND);
    CHECK_EQ_INT(p.state, PROV_PORTAL);
    CHECK(prov_on_portal_idle_timeout(&p), "retry");
    CHECK_EQ_INT(p.round_pos, 0);
    CHECK(strcmp(next_ssid(&p), "a") == 0, "from the start of the order again");
    CHECK_EQ_INT(p.result[0], NET_JOIN_OK);   // this round's results start empty
}

static void test_secure_zero_clears_every_byte(void) {
    char secret[64];
    memset(secret, 'x', sizeof secret);
    secure_zero(secret, sizeof secret);
    int nonzero = 0;
    for (unsigned i = 0; i < sizeof secret; i++) nonzero += secret[i] != 0;
    CHECK_EQ_INT(nonzero, 0);
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
    RUN(test_at_power_on_a_round_goes_in_saved_order);
    RUN(test_portal_opens_after_three_failed_rounds);
    RUN(test_a_success_anywhere_ends_the_run_and_goes_first_this_session);
    RUN(test_joining_never_writes_flash);
    RUN(test_a_submit_without_a_code_adds_a_network_and_keeps_the_pairing);
    RUN(test_a_lost_record_with_a_live_token_needs_no_new_code);
    RUN(test_a_submit_with_a_code_is_a_new_pairing);
    RUN(test_a_submit_without_any_pairing_is_refused);
    RUN(test_a_fifth_network_is_refused_and_nothing_is_lost);
    RUN(test_remove_a_network);
    RUN(test_remove_refused_while_a_disk_is_mounted_says_so);
    RUN(test_idle_timeout_starts_a_fresh_round);
    RUN(test_secure_zero_clears_every_byte);
    free(mem);
    return REPORT();
}
