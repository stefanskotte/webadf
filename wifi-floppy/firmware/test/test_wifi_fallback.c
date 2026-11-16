// Moving to another saved network while running (wifi_fallback.h): when a move is due, where the rounds start,
// when it stays, the back-offs that keep it from flapping, and the holds. The bench cases of 2026-11-16 by name:
// a hotspot switched off (A, link down) and a UniFi block (B, link up, nothing answers). The last tests run the
// rounds themselves (wifi_rejoin_run, the start-up's logic) with a fake radio, from the start this file picks.
#include "harness.h"
#include "../src/wifi_fallback.h"
#include "../src/wifi_ctl.h"
#include "../src/provisioning.h"
#include "../src/config_store.h"
#include "../src/psram_image.h"
#include "../src/token_store.h"
#include <stdio.h>
#include <string.h>

#define S(x) ((uint32_t)(x) * 1000u)

static wfb_in_t in_at(uint32_t now, bool up, uint32_t answers, int n) {
    wfb_in_t in = { now, up, answers, n, false };
    return in;
}

// --- A: the link is down ---------------------------------------------------------------------------------------

static void a_short_drop_is_left_to_recover_on_its_own(void) {
    wifi_fb_t fb;
    wfb_reset(&fb, 0, 0);
    wfb_in_t in = in_at(S(10), false, 0, 2);
    CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_NONE);
    in = in_at(S(39), false, 0, 2);
    CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_NONE);   // 29 s down
    in = in_at(S(40), true, 0, 2);                    // back by itself
    CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_NONE);
    in = in_at(S(60), false, 0, 2);                   // a new drop starts its own grace
    CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_NONE);
    in = in_at(S(89), false, 0, 2);
    CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_NONE);
    in = in_at(S(90), false, 0, 2);
    CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_DOWN);
}

// The bench: Skottens (index 1) switched off, wayfart (0) in range. The rounds start with the current one.
static void a_hotspot_switched_off_with_home_in_range_runs_the_rounds_from_it(void) {
    wifi_fb_t fb;
    wfb_reset(&fb, 0, 5);
    wfb_in_t in = in_at(S(1), false, 5, 2);
    wfb_due(&fb, &in);
    in = in_at(S(31), false, 5, 2);
    CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_DOWN);
    CHECK_EQ_INT(wfb_pick(&fb, WFB_DUE_DOWN, S(31), 1, 2, 0x1), 1);   // Skottens first, then wayfart
    wfb_ran(&fb, WFB_DUE_DOWN, S(60), 0);                              // ended on wayfart
    in = in_at(S(61), true, 5, 2);
    CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_NONE);
    CHECK(!fb.lost, "on a network");
}

// Nothing else in range: the driver keeps trying the current network; the next scan in 1, 2, 4, then 5 minutes.
static void a_drop_with_nothing_else_in_range_stays_and_looks_again_less_often(void) {
    wifi_fb_t fb;
    wfb_reset(&fb, 0, 0);
    wfb_in_t in = in_at(S(1), false, 0, 3);
    wfb_due(&fb, &in);
    uint32_t t = S(31);
    in = in_at(t, false, 0, 3);
    CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_DOWN);
    CHECK_EQ_INT(wfb_pick(&fb, WFB_DUE_DOWN, t, 0, 3, 0x1), -1);   // only the current one (still advertising)
    const uint32_t waits[] = { S(60), S(120), S(240), S(300), S(300) };
    for (int k = 0; k < 5; k++) {
        in = in_at(t + waits[k] - 1, false, 0, 3);
        CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_NONE);
        t += waits[k];
        in = in_at(t, false, 0, 3);
        CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_DOWN);
        CHECK_EQ_INT(wfb_pick(&fb, WFB_DUE_DOWN, t, 0, 3, 0), -1);   // nothing at all
    }
    // The link comes back by itself: the back-off starts over for the next drop.
    in = in_at(t + 5, true, 0, 3);
    wfb_due(&fb, &in);
    in = in_at(t + 10, false, 0, 3);
    wfb_due(&fb, &in);
    in = in_at(t + 10 + S(30), false, 0, 3);
    CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_DOWN);
}

static void a_scan_that_could_not_run_still_runs_the_rounds_when_the_link_is_down(void) {
    wifi_fb_t fb;
    wfb_reset(&fb, 0, 0);
    CHECK_EQ_INT(wfb_pick(&fb, WFB_DUE_DOWN, S(40), 1, 2, -1), 1);
}

// --- B: the link is up, nothing answers --------------------------------------------------------------------------

// The bench: blocked on wayfart (0), Skottens (1) in range. Five minutes of no answer, then the rounds from Skottens.
static void a_blocked_network_moves_to_another_in_range_after_five_minutes(void) {
    wifi_fb_t fb;
    wfb_reset(&fb, 0, 7);
    wfb_in_t in = in_at(S(100), true, 8, 2);          // the last answer
    CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_NONE);
    in = in_at(S(100) + WFB_DEAD_MS - 1, true, 8, 2);
    CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_NONE);
    in = in_at(S(100) + WFB_DEAD_MS, true, 8, 2);
    CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_DEAD);
    CHECK_EQ_INT(wfb_pick(&fb, WFB_DUE_DEAD, in.now, 0, 2, 0x3), 1);
}

static void answers_keep_the_board_where_it_is(void) {
    wifi_fb_t fb;
    wfb_reset(&fb, 0, 0);
    for (uint32_t k = 1; k <= 60; k++) {   // an answer every 25 s for 25 min
        wfb_in_t in = in_at(k * S(25), true, k, 4);
        CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_NONE);
    }
}

// Time with the link down is A's, not B's: a link back after 4 min has its full 5 to reach the server.
static void time_down_does_not_count_towards_dead(void) {
    wifi_fb_t fb;
    wfb_reset(&fb, 0, 0);
    wfb_in_t in = in_at(S(1), false, 0, 2);
    wfb_due(&fb, &in);
    in = in_at(S(31), false, 0, 2);
    CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_DOWN);
    wfb_pick(&fb, WFB_DUE_DOWN, S(31), 0, 2, 0x1);     // nothing else: stay
    in = in_at(S(240), true, 0, 2);
    CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_NONE);
    in = in_at(S(240) + WFB_DEAD_MS - 1, true, 0, 2);
    CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_NONE);
    in = in_at(S(240) + WFB_DEAD_MS, true, 0, 2);
    CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_DEAD);
}

// The flapping guard, 1: the server is down, the home network is fine, nothing else in range -- no move, ever;
// the scans come at 5, 10, 20, then every 30 minutes.
static void a_server_outage_with_nothing_else_in_range_never_moves(void) {
    wifi_fb_t fb;
    wfb_reset(&fb, 0, 0);
    uint32_t t = 0;
    const uint32_t waits[] = { S(300), S(600), S(1200), S(1800), S(1800) };
    for (int k = 0; k < 5; k++) {
        wfb_in_t in = in_at(t + waits[k] - 1, true, 0, 2);
        CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_NONE);
        t += waits[k];
        in = in_at(t, true, 0, 2);
        CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_DEAD);
        CHECK_EQ_INT(wfb_pick(&fb, WFB_DUE_DEAD, t, 0, 2, 0x1), -1);
    }
    // One answer and the five minutes are back.
    wfb_in_t in = in_at(t + 1, true, 1, 2);
    wfb_due(&fb, &in);
    in = in_at(t + 1 + WFB_DEAD_MS, true, 1, 2);
    CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_DEAD);
}

// The flapping guard, 2: the server is down and a hotspot is in range -- moves at 5, then 10, 20, 30 minutes apart.
static void a_server_outage_with_another_network_in_range_moves_ever_less_often(void) {
    wifi_fb_t fb;
    wfb_reset(&fb, 0, 0);
    uint32_t t = 0;
    int cur = 0;
    const uint32_t waits[] = { S(300), S(600), S(1200), S(1800), S(1800) };
    for (int k = 0; k < 5; k++) {
        wfb_in_t in = in_at(t + waits[k] - 1, true, 0, 2);
        CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_NONE);
        t += waits[k];
        in = in_at(t, true, 0, 2);
        CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_DEAD);
        const int from = wfb_pick(&fb, WFB_DUE_DEAD, t, cur, 2, 0x3);
        CHECK_EQ_INT(from, 1 - cur);
        wfb_ran(&fb, WFB_DUE_DEAD, t, from);   // joined it in no time (the clock is the run's end)
        cur = from;
    }
}

static void b_does_not_move_when_the_scan_could_not_run(void) {
    wifi_fb_t fb;
    wfb_reset(&fb, 0, 0);
    CHECK_EQ_INT(wfb_pick(&fb, WFB_DUE_DEAD, WFB_DEAD_MS, 0, 2, -1), -1);
    CHECK_EQ_INT(fb.dead_ms, 2 * WFB_DEAD_MS);
}

// The first other network in range, in saved order.
static void b_picks_the_first_other_network_in_saved_order(void) {
    wifi_fb_t fb;
    wfb_reset(&fb, 0, 0);
    CHECK_EQ_INT(wfb_pick(&fb, WFB_DUE_DEAD, 1, 1, 4, 0xE), 2);   // 1 is current; 2 and 3 in range
    wfb_reset(&fb, 0, 0);
    CHECK_EQ_INT(wfb_pick(&fb, WFB_DUE_DEAD, 1, 2, 4, 0xF), 0);
    wfb_reset(&fb, 0, 0);
    CHECK_EQ_INT(wfb_pick(&fb, WFB_DUE_DEAD, 1, 0, 2, 0x4), -1);  // a bit past the saved list is nothing
}

// --- one network, holds, nothing joined ---------------------------------------------------------------------------

static void one_saved_network_behaves_as_before(void) {
    wifi_fb_t fb;
    wfb_reset(&fb, 0, 0);
    wfb_in_t in = in_at(S(1), false, 0, 1);
    CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_NONE);
    in = in_at(S(3600), false, 0, 1);
    CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_NONE);   // an hour down: the driver keeps trying, as today
    in = in_at(S(3601), true, 0, 1);
    wfb_due(&fb, &in);
    in = in_at(S(3601) + S(7200), true, 0, 1);
    CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_NONE);   // two hours blocked: nowhere to go
}

static void holds_postpone_and_the_clocks_keep_running(void) {
    wifi_fb_t fb;
    wfb_reset(&fb, 0, 0);
    wfb_in_t in = in_at(S(1), false, 0, 2);
    in.hold = true;
    wfb_due(&fb, &in);
    in = in_at(S(200), false, 0, 2);
    in.hold = true;                                    // the setup page, a trial: never while held
    CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_NONE);
    in.hold = false;
    CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_DOWN);     // at once when the hold ends
    // B the same way.
    wfb_reset(&fb, 0, 0);
    in = in_at(WFB_DEAD_MS, true, 0, 2);
    in.hold = true;
    CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_NONE);
    in.hold = false;
    CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_DEAD);
}

// A run that joined nothing (the board busy, so no restart): the rounds again every 30 s, from where it was,
// no scan; held like everything else; over once a run joins.
static void a_run_that_joined_nothing_runs_again_until_one_joins(void) {
    wifi_fb_t fb;
    wfb_reset(&fb, 0, 0);
    wfb_ran(&fb, WFB_DUE_DOWN, S(100), -1);
    CHECK(fb.lost, "lost");
    wfb_in_t in = in_at(S(129), false, 0, 2);
    CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_NONE);
    in = in_at(S(130), false, 0, 2);
    CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_LOST);
    CHECK_EQ_INT(wfb_pick(&fb, WFB_DUE_LOST, S(130), 1, 2, 0), 1);
    CHECK_EQ_INT(wfb_pick(&fb, WFB_DUE_LOST, S(130), -1, 2, 0), 0);
    in.hold = true;
    CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_NONE);
    wfb_ran(&fb, WFB_DUE_LOST, S(200), -1);
    in = in_at(S(230), false, 0, 1);                   // even with one network: it was this file that left it
    CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_LOST);
    wfb_ran(&fb, WFB_DUE_LOST, S(240), 0);
    CHECK(!fb.lost, "joined");
    in = in_at(S(241), true, 0, 1);
    CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_NONE);
}

static void the_clock_may_wrap(void) {
    wifi_fb_t fb;
    const uint32_t t0 = 0xFFFFF000u;
    wfb_reset(&fb, t0, 0);
    wfb_in_t in = in_at(t0 + 10, false, 0, 2);
    wfb_due(&fb, &in);
    in = in_at(t0 + 10 + WFB_LINK_GRACE_MS, false, 0, 2);   // past zero
    CHECK_EQ_INT(wfb_due(&fb, &in), WFB_DUE_DOWN);
}

// --- the rounds the picks start ----------------------------------------------------------------------------------

typedef struct {
    const char *there[4];
    char        log[16][16];
    int         n;
} radio_t;

static net_join_t fake_join(void *ctx, const char *ssid, const char *pass) {
    (void)pass;
    radio_t *r = ctx;
    if (r->n < 16) snprintf(r->log[r->n], sizeof r->log[0], "%s", ssid);
    r->n++;
    for (int i = 0; i < 4 && r->there[i]; i++)
        if (strcmp(r->there[i], ssid) == 0) return NET_JOIN_OK;
    return NET_JOIN_NOT_FOUND;
}

// Saved: wayfart, Skottens; on `on`. Paired by a token.
static void seed(provisioning_t *p, int on) {
    psram_publish_slot(SLOT_NONE);
    config_store_erase();
    device_config_t c;
    memset(&c, 0, sizeof c);
    snprintf(c.net[0].ssid, sizeof c.net[0].ssid, "wayfart");
    snprintf(c.net[0].pass, sizeof c.net[0].pass, "pass-wayfart");
    snprintf(c.net[1].ssid, sizeof c.net[1].ssid, "Skottens");
    snprintf(c.net[1].pass, sizeof c.net[1].pass, "pass-skottens");
    c.n_nets = 2;
    CHECK(config_store_update(&c), "seed");
    CHECK(token_store_save("tok-paired"), "paired");
    prov_init(p);
    p->first = on;
    prov_on_join_result(p, NET_JOIN_OK);
}

static void a_ends_on_home_after_one_try_of_the_hotspot(void) {
    provisioning_t p;
    seed(&p, 1);
    radio_t r = { { "wayfart" }, { { 0 } }, 0 };
    const wifi_check_ops_t ops = { fake_join, &r };
    wifi_fb_t fb;
    wfb_reset(&fb, 0, 0);
    const int from = wfb_pick(&fb, WFB_DUE_DOWN, S(31), p.first, p.cfg.n_nets, 0x1);
    const int back = wifi_rejoin_run(&p, from, &ops, NULL);
    CHECK_EQ_INT(back, 0);
    CHECK_EQ_INT(r.n, 2);
    CHECK(strcmp(r.log[0], "Skottens") == 0 && strcmp(r.log[1], "wayfart") == 0, "the current one, then home");
    CHECK(p.joined && p.first == 0, "the tail's cur is wayfart now");
}

static void b_tries_the_hotspot_first_and_comes_back_when_it_does_not_answer(void) {
    provisioning_t p;
    seed(&p, 0);
    radio_t r = { { "wayfart" }, { { 0 } }, 0 };   // Skottens seen by the scan, but it refuses
    const wifi_check_ops_t ops = { fake_join, &r };
    wifi_fb_t fb;
    wfb_reset(&fb, 0, 0);
    const int from = wfb_pick(&fb, WFB_DUE_DEAD, WFB_DEAD_MS, p.first, p.cfg.n_nets, 0x3);
    CHECK_EQ_INT(from, 1);
    const int back = wifi_rejoin_run(&p, from, &ops, NULL);
    CHECK_EQ_INT(back, 0);
    CHECK(strcmp(r.log[0], "Skottens") == 0 && strcmp(r.log[1], "wayfart") == 0, "hotspot, then back home");
    wfb_ran(&fb, WFB_DUE_DEAD, WFB_DEAD_MS + S(30), back);
    CHECK_EQ_INT(fb.dead_ms, 2 * WFB_DEAD_MS);   // a fruitless move: the next waits longer
}

static void nothing_answers_three_rounds_then_lost(void) {
    provisioning_t p;
    seed(&p, 1);
    radio_t r = { { NULL }, { { 0 } }, 0 };
    const wifi_check_ops_t ops = { fake_join, &r };
    const int back = wifi_rejoin_run(&p, 1, &ops, NULL);
    CHECK_EQ_INT(back, -1);
    CHECK_EQ_INT(r.n, 3 * 2);
    CHECK(!p.joined, "the tail's cur is -1");
}

int main(void) {
    RUN(a_short_drop_is_left_to_recover_on_its_own);
    RUN(a_hotspot_switched_off_with_home_in_range_runs_the_rounds_from_it);
    RUN(a_drop_with_nothing_else_in_range_stays_and_looks_again_less_often);
    RUN(a_scan_that_could_not_run_still_runs_the_rounds_when_the_link_is_down);
    RUN(a_blocked_network_moves_to_another_in_range_after_five_minutes);
    RUN(answers_keep_the_board_where_it_is);
    RUN(time_down_does_not_count_towards_dead);
    RUN(a_server_outage_with_nothing_else_in_range_never_moves);
    RUN(a_server_outage_with_another_network_in_range_moves_ever_less_often);
    RUN(b_does_not_move_when_the_scan_could_not_run);
    RUN(b_picks_the_first_other_network_in_saved_order);
    RUN(one_saved_network_behaves_as_before);
    RUN(holds_postpone_and_the_clocks_keep_running);
    RUN(a_run_that_joined_nothing_runs_again_until_one_joins);
    RUN(the_clock_may_wrap);
    RUN(a_ends_on_home_after_one_try_of_the_hotspot);
    RUN(b_tries_the_hotspot_first_and_comes_back_when_it_does_not_answer);
    RUN(nothing_answers_three_rounds_then_lost);
    return REPORT();
}
