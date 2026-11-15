#include "harness.h"
#include "../src/provisioning.h"
#include "../src/config_store.h"
#include "../src/psram_image.h"
#include "../src/token_store.h"
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


// Three saved networks, "b" joined last.
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

static void test_a_round_tries_the_last_joined_first_then_saved_order(void) {
    seed_three();
    provisioning_t p;
    prov_init(&p);
    CHECK(strcmp(next_ssid(&p), "b") == 0, "the network joined last goes first");
    prov_on_join_result(&p, NET_JOIN_NOT_FOUND);
    CHECK(strcmp(next_ssid(&p), "a") == 0, "then the others in saved order");
    prov_on_join_result(&p, NET_JOIN_NOT_FOUND);
    CHECK(strcmp(next_ssid(&p), "c") == 0, "...skipping the one already tried");
    prov_on_join_result(&p, NET_JOIN_NOT_FOUND);
    CHECK(strcmp(next_ssid(&p), "b") == 0, "and the next round starts over");
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

static void test_a_success_anywhere_ends_the_run_of_failed_rounds(void) {
    seed_three();
    provisioning_t p;
    prov_init(&p);
    for (int i = 0; i < 3 * 2; i++) prov_on_join_result(&p, NET_JOIN_NOT_FOUND);   // two rounds
    prov_on_join_result(&p, NET_JOIN_NOT_FOUND);   // b
    CHECK_EQ_INT(prov_on_join_result(&p, NET_JOIN_OK), PROV_RUNNING);   // a
    CHECK_EQ_INT(p.assoc_failures, 0);
    CHECK_EQ_INT(p.round_pos, 0);
    CHECK(strcmp(next_ssid(&p), "a") == 0, "the network that worked is tried first now");
}

static void test_joining_another_network_makes_it_last_joined_and_keeps_the_token(void) {
    seed_three();
    CHECK(token_store_save("tok-paired"), "a paired board");
    provisioning_t p;
    prov_init(&p);
    prov_on_join_result(&p, NET_JOIN_NOT_FOUND);   // b, absent
    prov_on_join_result(&p, NET_JOIN_OK);          // a
    device_config_t stored;
    CHECK(config_store_load(&stored), "stored");
    CHECK(strcmp(stored.net[stored.last].ssid, "a") == 0, "persisted, so the next boot tries it first");
    CHECK(strcmp(stored.net[0].ssid, "a") == 0 && strcmp(stored.net[1].ssid, "b") == 0 &&
          strcmp(stored.net[2].ssid, "c") == 0, "the saved order itself is unchanged");
    char tok[64];
    CHECK(token_store_load(tok, sizeof tok) && strcmp(tok, "tok-paired") == 0,
          "joining a different network is not a re-pair: the token stays");
}

static void test_joining_the_same_network_writes_nothing(void) {
    seed_three();
    provisioning_t p;
    prov_init(&p);
    unsigned char before[CONFIG_STORE_RECORD_BYTES];
    memcpy(before, config_store_test_raw(), sizeof before);
    prov_on_join_result(&p, NET_JOIN_OK);   // b, already last
    CHECK(memcmp(before, config_store_test_raw(), sizeof before) == 0,
          "no flash write when the last-joined network did not change");
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
    CHECK_EQ_INT(stored.last, 1);
    CHECK(strcmp(stored.code, "ABC123") == 0, "the stored code is kept");
    char tok[64];
    CHECK(token_store_load(tok, sizeof tok) && strcmp(tok, "tok-paired") == 0,
          "adding a network is not a re-pair: the token stays");
    CHECK(strcmp(next_ssid(&p), "hotspot") == 0, "the verified network is tried first");
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

static void test_a_submit_without_any_code_is_refused(void) {
    config_store_erase();
    provisioning_t p;
    prov_init(&p);
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
    char msg[PROV_MSG_MAX];
    CHECK(prov_forget_network(&p, "a", msg, sizeof msg), "removed");
    device_config_t stored;
    CHECK(config_store_load(&stored), "stored");
    CHECK_EQ_INT(stored.n_nets, 2);
    CHECK(strcmp(stored.net[0].ssid, "b") == 0 && strcmp(stored.net[1].ssid, "c") == 0, "order kept");
    CHECK(strcmp(stored.net[stored.last].ssid, "b") == 0, "last joined still points at b");
    char tok[64];
    CHECK(token_store_load(tok, sizeof tok), "removing a network is not a re-pair");

    CHECK(prov_forget_network(&p, "b", msg, sizeof msg), "the last-joined one can go too");
    CHECK(config_store_load(&stored) && stored.n_nets == 1 && strcmp(stored.net[0].ssid, "c") == 0,
          "one left");
    CHECK(!prov_forget_network(&p, "c", msg, sizeof msg), "the only network stays");
    CHECK(strstr(msg, "only saved network") != NULL, "and says why");
    CHECK(!prov_forget_network(&p, "zzz", msg, sizeof msg), "unknown");
    CHECK(strstr(msg, "not saved") != NULL, "says so");
}

static void test_remove_refused_while_a_disk_is_mounted(void) {
    seed_three();
    provisioning_t p;
    prov_init(&p);
    psram_publish_slot(0);
    char msg[PROV_MSG_MAX];
    CHECK(!prov_forget_network(&p, "a", msg, sizeof msg), "no flash write under a disk");
    psram_publish_slot(SLOT_NONE);
    CHECK(strstr(msg, "not saved. Try again.") != NULL, "says it did not happen");
    CHECK_EQ_INT(p.cfg.n_nets, 3);
    CHECK(config_find_net(&p.cfg, "a") >= 0, "RAM unchanged too");
}

// The texts the setup page shows, verbatim (the operator reviews these).
static void test_the_join_messages_name_the_network_and_the_reason(void) {
    char m[PROV_MSG_MAX];
    CHECK(prov_join_message(m, sizeof m, "VenueWiFi", NET_JOIN_NOT_FOUND) > 0, "fits");
    CHECK(strcmp(m, "Could not join \xe2\x80\x9cVenueWiFi\xe2\x80\x9d: not found.\n"
                    "The board only sees 2.4 GHz networks, and cannot join one that is WPA3-only. "
                    "Phone hotspots often need \xe2\x80\x9cMaximise compatibility\xe2\x80\x9d (iPhone) "
                    "or a 2.4 GHz band (Android) turned on.") == 0, "not found");
    printf("  NOT_FOUND: %s\n", m);
    prov_join_message(m, sizeof m, "Home", NET_JOIN_BAD_AUTH);
    CHECK(strcmp(m, "Could not join \xe2\x80\x9cHome\xe2\x80\x9d: wrong password.\n"
                    "Check the password; it is case-sensitive. If it is right, the network may be "
                    "WPA3-only: the board needs WPA2.") == 0, "wrong password");
    printf("  BAD_AUTH: %s\n", m);
    // Spec §6's two-message requirement, kept: the two are told apart.
    char nf[PROV_MSG_MAX];
    prov_join_message(nf, sizeof nf, "Home", NET_JOIN_NOT_FOUND);
    CHECK(strcmp(m, nf) != 0 && strstr(nf, "wrong password") == NULL &&
          strstr(m, "not found") == NULL, "wrong password and not found read differently");
    const net_join_t others[] = { NET_JOIN_FAILED, NET_JOIN_NO_ADDRESS, NET_JOIN_TIMEOUT, NET_JOIN_ERROR };
    for (unsigned i = 0; i < sizeof others / sizeof others[0]; i++) {
        prov_join_message(m, sizeof m, "Home", others[i]);
        const char *pre = "Could not join \xe2\x80\x9cHome\xe2\x80\x9d: ";
        CHECK(strncmp(m, pre, strlen(pre)) == 0, "names the network");
        printf("  %d: %s\n", (int)others[i], m);
    }
    CHECK(strstr(m, "Try again.") != NULL, "ERROR says to try again");
    CHECK_EQ_INT(prov_join_message(m, 20, "Home", NET_JOIN_NOT_FOUND), -1);
    CHECK(m[0] == '\0', "refused, not truncated");
}

static void test_the_round_message_names_every_network(void) {
    seed_three();
    provisioning_t p;
    prov_init(&p);
    prov_on_join_result(&p, NET_JOIN_NOT_FOUND);   // b
    prov_on_join_result(&p, NET_JOIN_BAD_AUTH);    // a
    prov_on_join_result(&p, NET_JOIN_NOT_FOUND);   // c
    char m[PROV_MSG_MAX];
    CHECK(prov_round_message(&p, m, sizeof m) > 0, "fits");
    printf("  round: %s\n", m);
    const char *want = "Could not join any saved network:\n"
                       "\xe2\x80\x9c" "b\xe2\x80\x9d: not found.\n"
                       "\xe2\x80\x9c" "a\xe2\x80\x9d: wrong password.\n"
                       "\xe2\x80\x9c" "c\xe2\x80\x9d: not found.\n"
                       "The board only sees 2.4 GHz";
    CHECK(strncmp(m, want, strlen(want)) == 0, "each network, in the order tried");
    const char *h = strstr(m, "The board only sees 2.4 GHz");
    CHECK(h && strstr(h + 1, "The board only sees 2.4 GHz") == NULL, "each hint once");
    CHECK(strstr(m, "Check the password") != NULL, "and the password hint");

    // One network reads exactly as a single join message.
    config_store_erase();
    device_config_t c = mk("home");
    config_store_save(&c);
    prov_init(&p);
    for (int i = 0; i < PROV_MAX_ASSOC_FAILURES; i++) prov_on_join_result(&p, NET_JOIN_BAD_AUTH);
    char one[PROV_MSG_MAX];
    prov_round_message(&p, m, sizeof m);
    prov_join_message(one, sizeof one, "home", NET_JOIN_BAD_AUTH);
    CHECK(strcmp(m, one) == 0, "one network: the single message");
}

static void test_the_longest_round_message_fits(void) {
    config_store_erase();
    device_config_t c;
    memset(&c, 0, sizeof c);
    for (int i = 0; i < CONFIG_NETS_MAX; i++) {
        memset(c.net[i].ssid, 'A' + i, CONFIG_SSID_MAX);
        snprintf(c.net[i].pass, sizeof c.net[i].pass, "password");
    }
    c.n_nets = CONFIG_NETS_MAX;
    snprintf(c.code, sizeof c.code, "ABC123");
    CHECK(config_store_save(&c), "four long names");
    provisioning_t p;
    prov_init(&p);
    // Every combination of outcomes over four longest names (6^4).
    const net_join_t k[] = { NET_JOIN_NOT_FOUND, NET_JOIN_BAD_AUTH, NET_JOIN_FAILED,
                             NET_JOIN_NO_ADDRESS, NET_JOIN_TIMEOUT, NET_JOIN_ERROR };
    int longest = 0, refused = 0;
    char m[PROV_MSG_MAX];
    for (int combo = 0; combo < 6 * 6 * 6 * 6; combo++) {
        for (int i = 0, c = combo; i < CONFIG_NETS_MAX; i++, c /= 6) p.result[i] = k[c % 6];
        int n = prov_round_message(&p, m, sizeof m);
        if (n < 0) refused++;
        if (n > longest) longest = n;
    }
    CHECK_EQ_INT(refused, 0);
    CHECK(longest < PROV_MSG_MAX, "every combination fits PROV_MSG_MAX");
    printf("  (longest round message: %d bytes of %d)\n", longest, PROV_MSG_MAX);
}

static void test_idle_timeout_starts_a_fresh_round(void) {
    seed_three();
    provisioning_t p;
    prov_init(&p);
    for (int i = 0; i < 3 * 3; i++) prov_on_join_result(&p, NET_JOIN_NOT_FOUND);
    CHECK_EQ_INT(p.state, PROV_PORTAL);
    CHECK(prov_on_portal_idle_timeout(&p), "retry");
    CHECK_EQ_INT(p.round_pos, 0);
    CHECK(strcmp(next_ssid(&p), "b") == 0, "from the last-joined network again");
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
    RUN(test_a_round_tries_the_last_joined_first_then_saved_order);
    RUN(test_portal_opens_after_three_failed_rounds);
    RUN(test_a_success_anywhere_ends_the_run_of_failed_rounds);
    RUN(test_joining_another_network_makes_it_last_joined_and_keeps_the_token);
    RUN(test_joining_the_same_network_writes_nothing);
    RUN(test_a_submit_without_a_code_adds_a_network_and_keeps_the_pairing);
    RUN(test_a_submit_with_a_code_is_a_new_pairing);
    RUN(test_a_submit_without_any_code_is_refused);
    RUN(test_a_fifth_network_is_refused_and_nothing_is_lost);
    RUN(test_remove_a_network);
    RUN(test_remove_refused_while_a_disk_is_mounted);
    RUN(test_the_join_messages_name_the_network_and_the_reason);
    RUN(test_the_round_message_names_every_network);
    RUN(test_the_longest_round_message_fits);
    RUN(test_idle_timeout_starts_a_fresh_round);
    free(mem);
    return REPORT();
}
