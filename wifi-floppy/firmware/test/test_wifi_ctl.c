// Wi-Fi networks from the web app (2026-11-15): wifi_ctl.c's wire and decisions, and the two provisioning
// functions the board uses while online (prov_add_network, prov_forget_other_network). The radio is a fake:
// `join` answers from a table of which networks are "there" -- the board's real join is net_join.c, tested in
// test_net_join.c.
#include "harness.h"
#include "../src/wifi_ctl.h"
#include "../src/provisioning.h"
#include "../src/config_store.h"
#include "../src/psram_image.h"
#include "../src/token_store.h"
#include "../src/net_radio.h"
#include "../src/yield_gate.h"
#include <stdio.h>
#include <string.h>

// --- the instruction -------------------------------------------------------------------------------------------

static void parses_each_op(void) {
    wifi_cmd_t c;
    CHECK(wifi_cmd_parse("{\"seq\":4,\"op\":\"open\"}", &c), "open");
    CHECK_EQ_INT(c.seq, 4); CHECK_EQ_INT(c.op, WIFI_OP_OPEN);
    CHECK(wifi_cmd_parse("{\"seq\":5,\"op\":\"close\"}", &c), "close");
    CHECK_EQ_INT(c.op, WIFI_OP_CLOSE);
    CHECK(wifi_cmd_parse("{\"seq\":6,\"op\":\"none\"}", &c), "none");
    CHECK_EQ_INT(c.op, WIFI_OP_NONE);
    CHECK(wifi_cmd_parse("{\"seq\":7,\"op\":\"remove\",\"ssid\":\"486f6d65204e6574\"}", &c), "remove");
    CHECK_EQ_INT(c.op, WIFI_OP_REMOVE);
    CHECK(strcmp(c.ssid, "Home Net") == 0, c.ssid);
    CHECK(wifi_cmd_parse("{\"seq\":8,\"op\":\"rename\"}", &c), "a newer op is still a seq to ack");
    CHECK_EQ_INT(c.op, WIFI_OP_UNKNOWN);
    CHECK(wifi_cmd_parse("{\"seq\":9}", &c), "no op reads as none");
    CHECK_EQ_INT(c.op, WIFI_OP_NONE);
}

static void refuses_what_is_not_an_instruction(void) {
    wifi_cmd_t c;
    CHECK(!wifi_cmd_parse("{\"op\":\"open\"}", &c), "no seq");
    CHECK(!wifi_cmd_parse("{\"seq\":-1,\"op\":\"open\"}", &c), "not a u32");
    CHECK(!wifi_cmd_parse(NULL, &c), "nothing");
    CHECK(!wifi_cmd_parse("{\"seq\":3,\"op\":\"remove\"}", &c), "remove with no name");
    CHECK(!wifi_cmd_parse("{\"seq\":3,\"op\":\"remove\",\"ssid\":\"abc\"}", &c), "odd hex");
    CHECK(!wifi_cmd_parse("{\"seq\":3,\"op\":\"remove\",\"ssid\":\"zz\"}", &c), "not hex");
    CHECK(!wifi_cmd_parse("{\"seq\":3,\"op\":\"remove\",\"ssid\":\"6100\"}", &c), "a NUL inside a name");
    char json[200];
    char hex[80];
    memset(hex, '6', 66); hex[66] = '\0';   // 33 octets: one too many
    snprintf(json, sizeof json, "{\"seq\":3,\"op\":\"remove\",\"ssid\":\"%s\"}", hex);
    CHECK(!wifi_cmd_parse(json, &c), "33 octets");
    hex[64] = '\0';                          // 32 octets: the most
    snprintf(json, sizeof json, "{\"seq\":3,\"op\":\"remove\",\"ssid\":\"%s\"}", hex);
    CHECK(wifi_cmd_parse(json, &c), "32 octets");
    CHECK_EQ_INT((int)strlen(c.ssid), 32);
}

static void hex_round_trips_any_octets(void) {
    char hex[80], back[40];
    const char name[] = "Caf\xc3\xa9 \"5G\"\x01";
    CHECK_EQ_INT(wifi_hex_encode(name, hex, sizeof hex), 2 * (int)strlen(name));
    CHECK(strcmp(hex, "436166c3a92022354722" "01") == 0, hex);
    CHECK(wifi_hex_decode(hex, back, sizeof back), "decodes");
    CHECK(strcmp(back, name) == 0, "the same octets");
    CHECK(wifi_hex_decode("4A4b", back, sizeof back) && strcmp(back, "JK") == 0, "either case");
    CHECK_EQ_INT(wifi_hex_encode("abc", hex, 6), -1);   // 7 needed
    CHECK(!wifi_hex_decode("", back, sizeof back), "empty");
    CHECK(!wifi_hex_decode("414243", back, 3), "too long for the buffer");
}

// --- the status tail -------------------------------------------------------------------------------------------

static void the_tail_names_the_networks_in_hex_and_both_values(void) {
    device_config_t cfg;
    memset(&cfg, 0, sizeof cfg);
    snprintf(cfg.net[0].ssid, sizeof cfg.net[0].ssid, "home");
    snprintf(cfg.net[0].pass, sizeof cfg.net[0].pass, "SECRETPASS");
    snprintf(cfg.net[1].ssid, sizeof cfg.net[1].ssid, "phone");
    cfg.n_nets = 2;
    char out[WIFI_REPORT_MAX + 1];
    wifi_report_t r = { &cfg, 0, 0, WIFI_RES_NONE, 0 };
    int n = wifi_report_json(&r, out, sizeof out);
    CHECK(strcmp(out, ",\"wifi\":{\"nets\":[\"686f6d65\",\"70686f6e65\"],\"cur\":0,\"ack\":0,\"res\":null,\"setup\":0}") == 0, out);
    CHECK_EQ_INT(n, (int)strlen(out));
    CHECK(strstr(out, "SECRET") == NULL && strstr(out, "5345435245") == NULL, "never a password, in any form");
    wifi_report_t r2 = { &cfg, 1, 12, WIFI_RES_DISK, 540 };
    wifi_report_json(&r2, out, sizeof out);
    CHECK(strstr(out, "\"cur\":1,\"ack\":12,\"res\":\"disk\",\"setup\":540}") != NULL, out);
    wifi_report_t r3 = { &cfg, 7, 1, WIFI_RES_OK, 99999 };
    wifi_report_json(&r3, out, sizeof out);
    CHECK(strstr(out, "\"cur\":-1,") != NULL, "an index past the list reads as none");
    CHECK(strstr(out, "\"setup\":3600}") != NULL, "setup is capped");
    wifi_report_t none = { NULL, -1, 0, WIFI_RES_NONE, 0 };
    wifi_report_json(&none, out, sizeof out);
    CHECK(strstr(out, "\"nets\":[],\"cur\":-1") != NULL, out);
}

static void a_tail_that_does_not_fit_is_refused_whole(void) {
    device_config_t cfg;
    memset(&cfg, 0, sizeof cfg);
    cfg.n_nets = 4;
    for (int i = 0; i < 4; i++) memset(cfg.net[i].ssid, 'a' + i, 32);
    char out[WIFI_REPORT_MAX + 1];
    wifi_report_t r = { &cfg, 3, 4294967295u, WIFI_RES_WRITE_FAILED, 3600 };
    CHECK_EQ_INT(wifi_report_json(&r, out, sizeof out), WIFI_REPORT_MAX);   // the documented worst case
    CHECK_EQ_INT(wifi_report_json(&r, out, WIFI_REPORT_MAX), -1);
    CHECK_EQ_INT(out[0], '\0');
    for (int cap = 0; cap < WIFI_REPORT_MAX; cap += 7) {
        char small[WIFI_REPORT_MAX + 1];
        memset(small, 'x', sizeof small);
        CHECK_EQ_INT(wifi_report_json(&r, small, cap), -1);
        if (cap > 0) CHECK_EQ_INT(small[0], '\0');
    }
}

static void every_result_has_its_wire_word(void) {
    CHECK(strcmp(wifi_res_wire(WIFI_RES_NONE), "") == 0, "none handled");
    const char *want[] = { "", "ok", "none", "unknown", "disk", "only_one", "in_use", "not_saved", "write_failed", "subnet" };
    for (int r = WIFI_RES_NONE; r <= WIFI_RES_SUBNET; r++) CHECK(strcmp(wifi_res_wire((wifi_res_t)r), want[r]) == 0, want[r]);
    CHECK_EQ_INT(wifi_res_from_forget(PROV_FORGOT), WIFI_RES_OK);
    CHECK_EQ_INT(wifi_res_from_forget(PROV_FORGET_NOT_SAVED), WIFI_RES_NOT_SAVED);
    CHECK_EQ_INT(wifi_res_from_forget(PROV_FORGET_ONLY_ONE), WIFI_RES_ONLY_ONE);
    CHECK_EQ_INT(wifi_res_from_forget(PROV_FORGET_DISK_MOUNTED), WIFI_RES_DISK);
    CHECK_EQ_INT(wifi_res_from_forget(PROV_FORGET_IN_USE), WIFI_RES_IN_USE);
    CHECK_EQ_INT(wifi_res_from_forget(PROV_FORGET_WRITE_FAILED), WIFI_RES_WRITE_FAILED);
    CHECK_EQ_INT(wifi_open_check(false, false), WIFI_RES_OK);
    CHECK_EQ_INT(wifi_open_check(true, false), WIFI_RES_DISK);
    CHECK_EQ_INT(wifi_open_check(true, true), WIFI_RES_DISK);
    CHECK_EQ_INT(wifi_open_check(false, true), WIFI_RES_SUBNET);
}

// --- the window ------------------------------------------------------------------------------------------------

static void the_window_opens_restarts_and_closes(void) {
    wifi_window_t w = { 0 };
    CHECK(!wifi_window_due(&w, 0), "closed is never due");
    CHECK_EQ_INT(wifi_window_left_ms(&w, 0), 0);
    wifi_window_open(&w, 1000, WIFI_SETUP_MS);
    CHECK_EQ_INT(wifi_window_left_ms(&w, 1000), WIFI_SETUP_MS);
    CHECK_EQ_INT(wifi_window_left_min(&w, 1000), 10);
    CHECK_EQ_INT(wifi_window_left_min(&w, 1000 + WIFI_SETUP_MS - 1), 1);   // rounded up
    CHECK(!wifi_window_due(&w, 1000 + WIFI_SETUP_MS - 1), "not yet");
    CHECK(wifi_window_due(&w, 1000 + WIFI_SETUP_MS), "now");
    wifi_window_open(&w, 300000, WIFI_SETUP_MS);   // a re-request starts the ten minutes again
    CHECK_EQ_INT(wifi_window_left_ms(&w, 300000), WIFI_SETUP_MS);
    wifi_window_at_least(&w, 300000 + WIFI_SETUP_MS - 1000, WIFI_SETUP_AFTER_CHECK_MS);
    CHECK_EQ_INT(wifi_window_left_ms(&w, 300000 + WIFI_SETUP_MS - 1000), WIFI_SETUP_AFTER_CHECK_MS);
    wifi_window_at_least(&w, 300000, WIFI_SETUP_AFTER_CHECK_MS);   // already more: unchanged
    CHECK_EQ_INT(wifi_window_left_ms(&w, 300000), WIFI_SETUP_MS - 1000 + WIFI_SETUP_AFTER_CHECK_MS);
    wifi_window_close(&w);
    CHECK(!w.open && !wifi_window_due(&w, 0), "closed");
    wifi_window_at_least(&w, 5, 100);
    CHECK(!w.open, "at_least never opens a closed window");
    // Across the 49-day wrap of the ms clock.
    wifi_window_open(&w, 0xFFFFF000u, 10000);
    CHECK_EQ_INT(wifi_window_left_ms(&w, 0xFFFFF000u), 10000);
    CHECK(!wifi_window_due(&w, 0x00000100u), "past the wrap, still open");
    CHECK(wifi_window_due(&w, 0x00002000u), "and then due");
}

// --- adding and removing while online --------------------------------------------------------------------------

// Saved: home, office; the board joined home this session (it is on it now). Paired by a token.
static void seed_online(provisioning_t *p) {
    psram_publish_slot(SLOT_NONE);
    config_store_erase();
    device_config_t c;
    memset(&c, 0, sizeof c);
    snprintf(c.net[0].ssid, sizeof c.net[0].ssid, "home");
    snprintf(c.net[0].pass, sizeof c.net[0].pass, "home-pass");
    snprintf(c.net[1].ssid, sizeof c.net[1].ssid, "office");
    snprintf(c.net[1].pass, sizeof c.net[1].pass, "office-pass");
    c.n_nets = 2;
    CHECK(config_store_update(&c), "seed");
    CHECK(token_store_save("tok-paired"), "paired");
    prov_init(p);
    prov_on_join_result(p, NET_JOIN_OK);   // home
}

static void add_appends_keeps_the_token_and_the_network_in_use(void) {
    provisioning_t p;
    seed_online(&p);
    CHECK_EQ_INT(prov_add_network(&p, "phone", "phone-pass"), PROV_ADDED);
    device_config_t s;
    CHECK(config_store_load(&s), "stored");
    CHECK_EQ_INT(s.n_nets, 3);
    CHECK(strcmp(s.net[2].ssid, "phone") == 0 && strcmp(s.net[2].pass, "phone-pass") == 0, "appended");
    CHECK_EQ_INT(s.last, 0);   // page 0: the network the board is on
    CHECK_EQ_INT(p.first, 0);
    CHECK(p.joined, "still on home");
    char tok[64];
    CHECK(token_store_load(tok, sizeof tok), "not a re-pair");
    // The same name again: its password is replaced in place.
    CHECK_EQ_INT(prov_add_network(&p, "office", "new-office-pass"), PROV_ADDED);
    CHECK(config_store_load(&s) && s.n_nets == 3 && strcmp(s.net[1].pass, "new-office-pass") == 0, "in place");
}

static void add_refuses_and_changes_nothing(void) {
    provisioning_t p;
    seed_online(&p);
    prov_add_network(&p, "c", "password-c");
    prov_add_network(&p, "d", "password-d");
    unsigned char before[CONFIG_STORE_RECORD_BYTES];
    memcpy(before, config_store_test_raw(), sizeof before);
    CHECK_EQ_INT(prov_add_network(&p, "e", "password-e"), PROV_ADD_FULL);
    CHECK_EQ_INT(prov_add_network(&p, "d", "password-d2"), PROV_ADDED);   // full, but a name already saved
    memcpy(before, config_store_test_raw(), sizeof before);
    psram_publish_slot(0);
    CHECK_EQ_INT(prov_add_network(&p, "d", "password-d3"), PROV_ADD_DISK_MOUNTED);
    psram_publish_slot(SLOT_NONE);
    CHECK(memcmp(before, config_store_test_raw(), sizeof before) == 0, "flash unchanged");
    CHECK(strcmp(p.cfg.net[3].pass, "password-d2") == 0, "RAM unchanged");
    provisioning_t q;
    memset(&q, 0, sizeof q);
    CHECK_EQ_INT(prov_add_network(&q, "x", "password-x"), PROV_ADD_NO_CONFIG);
}

static void the_network_in_use_cannot_be_removed_online(void) {
    provisioning_t p;
    seed_online(&p);
    CHECK_EQ_INT(prov_forget_other_network(&p, "home"), PROV_FORGET_IN_USE);
    CHECK_EQ_INT(p.cfg.n_nets, 2);
    CHECK_EQ_INT(prov_forget_other_network(&p, "nope"), PROV_FORGET_NOT_SAVED);
    CHECK_EQ_INT(prov_forget_other_network(&p, "office"), PROV_FORGOT);
    CHECK_EQ_INT(p.cfg.n_nets, 1);
    CHECK_EQ_INT(prov_forget_other_network(&p, "home"), PROV_FORGET_IN_USE);   // in use wins over "only one"
    // Not joined (power-on default only): the plain rules apply.
    seed_online(&p);
    p.joined = false;
    CHECK_EQ_INT(prov_forget_other_network(&p, "home"), PROV_FORGOT);
}

// --- check, save, go back --------------------------------------------------------------------------------------

typedef struct {
    const char *there[4];      // networks that answer, with the password each needs
    const char *pass[4];
    char        log[8][40];    // the joins made, in order
    int         n;
} radio_t;

static net_join_t fake_join(void *ctx, const char *ssid, const char *pass) {
    radio_t *r = ctx;
    if (r->n < 8) snprintf(r->log[r->n], sizeof r->log[0], "%s", ssid);
    r->n++;
    for (int i = 0; i < 4 && r->there[i]; i++)
        if (strcmp(r->there[i], ssid) == 0) return strcmp(r->pass[i], pass) == 0 ? NET_JOIN_OK : NET_JOIN_BAD_AUTH;
    return NET_JOIN_NOT_FOUND;
}

static void a_good_network_is_saved_and_the_board_goes_back(void) {
    provisioning_t p;
    seed_online(&p);
    radio_t r = { { "home", "phone" }, { "home-pass", "phone-pass" }, { { 0 } }, 0 };
    wifi_check_ops_t ops = { fake_join, &r };
    wifi_check_t out;
    wifi_check_run(&p, "phone", "phone-pass", &ops, &out);
    CHECK_EQ_INT(out.join, NET_JOIN_OK);
    CHECK(out.tried_save, "tried");
    CHECK_EQ_INT(out.saved, PROV_ADDED);
    CHECK_EQ_INT(out.back_on, 0);
    CHECK_EQ_INT(r.n, 2);
    CHECK(strcmp(r.log[0], "phone") == 0 && strcmp(r.log[1], "home") == 0, "checked, then straight back");
    CHECK_EQ_INT(p.first, 0);
    CHECK(p.joined, "on home");
    CHECK_EQ_INT(p.state, PROV_RUNNING);
    CHECK_EQ_INT(p.cfg.n_nets, 3);
}

static void a_bad_network_is_not_saved_and_the_board_goes_back(void) {
    provisioning_t p;
    seed_online(&p);
    unsigned char before[CONFIG_STORE_RECORD_BYTES];
    memcpy(before, config_store_test_raw(), sizeof before);
    radio_t r = { { "home", "phone" }, { "home-pass", "phone-pass" }, { { 0 } }, 0 };
    wifi_check_ops_t ops = { fake_join, &r };
    wifi_check_t out;
    wifi_check_run(&p, "phone", "wrong-pass", &ops, &out);
    CHECK_EQ_INT(out.join, NET_JOIN_BAD_AUTH);
    CHECK(!out.tried_save, "nothing saved");
    CHECK(memcmp(before, config_store_test_raw(), sizeof before) == 0, "flash unchanged");
    CHECK_EQ_INT(out.back_on, 0);
    CHECK_EQ_INT(p.cfg.n_nets, 2);
}

// The network it was on is gone meanwhile: the others are tried, the new one included.
static void when_the_old_network_is_gone_the_board_ends_on_another(void) {
    provisioning_t p;
    seed_online(&p);
    radio_t r = { { "phone" }, { "phone-pass" }, { { 0 } }, 0 };
    wifi_check_ops_t ops = { fake_join, &r };
    wifi_check_t out;
    wifi_check_run(&p, "phone", "phone-pass", &ops, &out);
    CHECK_EQ_INT(out.saved, PROV_ADDED);
    CHECK_EQ_INT(out.back_on, 2);   // phone
    CHECK(strcmp(r.log[1], "home") == 0 && strcmp(r.log[2], "office") == 0 && strcmp(r.log[3], "phone") == 0,
          "home first, then the saved order");
    CHECK_EQ_INT(p.first, 2);
    CHECK(p.joined, "joined phone");
}

// Nothing answers: three whole rounds, then it says so (main.c restarts the board into its normal start).
static void when_nothing_answers_it_says_so_after_three_rounds(void) {
    provisioning_t p;
    seed_online(&p);
    radio_t r = { { NULL }, { NULL }, { { 0 } }, 0 };
    wifi_check_ops_t ops = { fake_join, &r };
    wifi_check_t out;
    wifi_check_run(&p, "phone", "phone-pass", &ops, &out);
    CHECK_EQ_INT(out.join, NET_JOIN_NOT_FOUND);
    CHECK_EQ_INT(out.back_on, -1);
    CHECK_EQ_INT(out.attempts, PROV_MAX_ASSOC_FAILURES * 2);
    CHECK(!p.joined, "on nothing");
    CHECK_EQ_INT(p.state, PROV_RUNNING);
}

// Saving refused (a disk went in meanwhile): still back on the old network, and the reason is kept.
static void a_refused_save_still_goes_back(void) {
    provisioning_t p;
    seed_online(&p);
    radio_t r = { { "home", "phone" }, { "home-pass", "phone-pass" }, { { 0 } }, 0 };
    wifi_check_ops_t ops = { fake_join, &r };
    wifi_check_t out;
    psram_publish_slot(0);
    wifi_check_run(&p, "phone", "phone-pass", &ops, &out);
    psram_publish_slot(SLOT_NONE);
    CHECK(out.tried_save, "tried");
    CHECK_EQ_INT(out.saved, PROV_ADD_DISK_MOUNTED);
    CHECK_EQ_INT(out.back_on, 0);
    CHECK_EQ_INT(p.cfg.n_nets, 2);
}

// A new password for the network in use: checked with it, saved in place, and the board goes back with it.
static void a_new_password_for_the_network_in_use(void) {
    provisioning_t p;
    seed_online(&p);
    radio_t r = { { "home" }, { "new-home-pass" }, { { 0 } }, 0 };
    wifi_check_ops_t ops = { fake_join, &r };
    wifi_check_t out;
    wifi_check_run(&p, "home", "new-home-pass", &ops, &out);
    CHECK_EQ_INT(out.saved, PROV_ADDED);
    CHECK_EQ_INT(out.back_on, 0);
    CHECK_EQ_INT(r.n, 2);
    CHECK(strcmp(p.cfg.net[0].pass, "new-home-pass") == 0, "in place");
}

// Review of 3bf330b2, M7: the overlap with the setup network's 192.168.4.0/24, by the station's netmask.
static void subnets_overlap_by_the_shorter_prefix(void) {
    const uint32_t ap = 0xC0A80401u, m24 = 0xFFFFFF00u;   // 192.168.4.1/24
    CHECK(net_subnets_overlap(0xC0A80417u, m24, ap, m24), "192.168.4.23/24: the same network");
    CHECK(net_subnets_overlap(0xC0A80117u, 0xFFFF0000u, ap, m24), "192.168.1.23/16 contains it");
    CHECK(net_subnets_overlap(0xC0A80517u, 0xFFFFF800u, ap, m24), "192.168.5.23/21 (192.168.0-7) contains it");
    CHECK(!net_subnets_overlap(0xC0A80117u, m24, ap, m24), "192.168.1.23/24 does not");
    CHECK(!net_subnets_overlap(0x0A000005u, 0xFF000000u, ap, m24), "10.0.0.5/8 does not");
    CHECK(!net_subnets_overlap(0, 0, ap, m24), "no address: nothing to clash with");
}

// Review of 7f3de257: a request gives way once, then not again for the quiet period -- never a hot spin of
// connect-and-close while an event waits.
static void a_request_gives_way_once_then_stays_quiet(void) {
    yield_gate_t g = { 0 };
    CHECK(!yield_gate_try(&g, 1000, false, 200), "nothing pending");
    CHECK(yield_gate_try(&g, 1000, true, 200), "gives way");
    CHECK(!yield_gate_try(&g, 1001, true, 200), "quiet just after");
    CHECK(!yield_gate_try(&g, 1199, true, 200), "quiet for 200 ms");
    CHECK(yield_gate_try(&g, 1200, true, 200), "then may again");
    CHECK(!yield_gate_try(&g, 1500, false, 200), "nothing pending");
    CHECK(yield_gate_try(&g, 1501, true, 200), "and at once once the quiet ended");
    yield_gate_t w = { 0 };
    CHECK(yield_gate_try(&w, 0xFFFFFFC0u, true, 200), "near the wrap");
    CHECK(!yield_gate_try(&w, 0x00000010u, true, 200), "quiet across it");
    CHECK(yield_gate_try(&w, 0x00000100u, true, 200), "and open after");
}

int main(void) {
    RUN(a_request_gives_way_once_then_stays_quiet);
    RUN(subnets_overlap_by_the_shorter_prefix);
    RUN(parses_each_op);
    RUN(refuses_what_is_not_an_instruction);
    RUN(hex_round_trips_any_octets);
    RUN(the_tail_names_the_networks_in_hex_and_both_values);
    RUN(a_tail_that_does_not_fit_is_refused_whole);
    RUN(every_result_has_its_wire_word);
    RUN(the_window_opens_restarts_and_closes);
    RUN(add_appends_keeps_the_token_and_the_network_in_use);
    RUN(add_refuses_and_changes_nothing);
    RUN(the_network_in_use_cannot_be_removed_online);
    RUN(a_good_network_is_saved_and_the_board_goes_back);
    RUN(a_bad_network_is_not_saved_and_the_board_goes_back);
    RUN(when_the_old_network_is_gone_the_board_ends_on_another);
    RUN(when_nothing_answers_it_says_so_after_three_rounds);
    RUN(a_refused_save_still_goes_back);
    RUN(a_new_password_for_the_network_in_use);
    return REPORT();
}
