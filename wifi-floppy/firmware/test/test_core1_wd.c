#include "harness.h"
#include "../src/core1_wd.h"
#include <stdint.h>

// core1 supervision (fw 1.21.0): core0 watches core1's boot-trail heartbeat (bt_hw_tick(1), at least once a second
// in core1's poll loop), keeps the longest gap it has seen, and lets the 8 s hardware watchdog reset the board when
// the gap passes C1WD_LIMIT_MS. Every decision is here; main.c only reads the tick and acts on the answer.

#define FEEDS(r)  (((r) & C1WD_FEED) != 0)
#define NEWMAX(r) (((r) & C1WD_NEW_MAX) != 0)
#define STALL(r)  (((r) & C1WD_STALL) != 0)
#define RPT(r)    (((r) & C1WD_REPORT) != 0)

static void before_the_loop_nothing_is_supervised(void) {
    c1wd_t w;
    c1wd_init(&w);
    // core1 still joining Wi-Fi, in the portal, or in an update trial: its last mark may be minutes old.
    unsigned r = c1wd_step(&w, 10u * 60u * 1000u, 0, false);
    CHECK(FEEDS(r), "fed before the loop, however old the tick");
    CHECK(!STALL(r), "no stall before the loop");
    CHECK(!NEWMAX(r), "no maximum before the loop");
    CHECK_EQ_INT(w.max_gap, 0);
    r = c1wd_step(&w, 20u * 60u * 1000u, 0, false);
    CHECK(!RPT(r), "no periodic report before supervision starts");
}

static void a_new_maximum_is_kept_and_logged_rate_limited(void) {
    c1wd_t w;
    c1wd_init(&w);
    const uint32_t t0 = 100000;
    unsigned r = c1wd_step(&w, t0 + 300, t0, true);
    CHECK(FEEDS(r), "a young tick feeds");
    CHECK_EQ_INT(w.max_gap, 300);
    CHECK(!NEWMAX(r), "300 ms is under the first 1 s step: not logged");
    r = c1wd_step(&w, t0 + 1100, t0, true);
    CHECK_EQ_INT(w.max_gap, 1100);
    CHECK(NEWMAX(r), "the first max past 1 s is logged");
    CHECK_EQ_INT(w.logged_max, 1100);
    // Growth under max(1 s, 25%) of the last logged value: kept, not logged.
    r = c1wd_step(&w, t0 + 2000, t0, true);
    CHECK_EQ_INT(w.max_gap, 2000);
    CHECK(!NEWMAX(r), "+900 ms is under the 1 s step");
    r = c1wd_step(&w, t0 + 2100, t0, true);
    CHECK(NEWMAX(r), "+1000 ms over the last logged 1100 is logged");
    CHECK_EQ_INT(w.logged_max, 2100);
    // At 8 s the 25% step (2 s) is the larger one.
    c1wd_t v;
    c1wd_init(&v);
    c1wd_step(&v, t0 + 8000, t0, true);
    CHECK_EQ_INT(v.logged_max, 8000);
    r = c1wd_step(&v, t0 + 9500, t0, true);
    CHECK(!NEWMAX(r), "+1.5 s on 8 s is under 25%");
    CHECK_EQ_INT(v.max_gap, 9500);
    r = c1wd_step(&v, t0 + 10000, t0, true);
    CHECK(NEWMAX(r), "+2 s on 8 s is 25%");
    // A smaller gap never lowers the maximum, and is not logged.
    r = c1wd_step(&v, t0 + 20500, t0 + 20000, true);
    CHECK(!NEWMAX(r), "a short gap is no news");
    CHECK_EQ_INT(v.max_gap, 10000);
}

static void the_stall_is_strictly_past_the_limit(void) {
    c1wd_t w;
    c1wd_init(&w);
    const uint32_t t0 = 5000;
    unsigned r = c1wd_step(&w, t0 + C1WD_LIMIT_MS, t0, true);
    CHECK(FEEDS(r), "exactly the limit still feeds");
    CHECK(!STALL(r), "exactly the limit is no stall");
    r = c1wd_step(&w, t0 + C1WD_LIMIT_MS + 1, t0, true);
    CHECK(STALL(r), "one ms past the limit is a stall");
    CHECK(!FEEDS(r), "and the watchdog is no longer fed");
    CHECK_EQ_INT(w.gap, C1WD_LIMIT_MS + 1);
    CHECK_EQ_INT(w.max_gap, C1WD_LIMIT_MS + 1);
    // Latched: the board is resetting. A tick that arrives in the watchdog's last 8 s does not undo it, and the
    // stall is reported once.
    r = c1wd_step(&w, t0 + C1WD_LIMIT_MS + 100, t0 + C1WD_LIMIT_MS + 50, true);
    CHECK(!FEEDS(r), "still not fed after a late tick");
    CHECK(!STALL(r), "the stall is reported once");
    r = c1wd_step(&w, t0 + C1WD_LIMIT_MS + 200, t0, false);
    CHECK(!FEEDS(r), "not fed even if core1 now looks out of its loop");
}

static void a_tick_before_the_limit_clears_it(void) {
    c1wd_t w;
    c1wd_init(&w);
    const uint32_t t0 = 5000;
    unsigned r = c1wd_step(&w, t0 + C1WD_LIMIT_MS - 1, t0, true);
    CHECK(FEEDS(r) && !STALL(r), "just under the limit");
    const uint32_t t1 = t0 + C1WD_LIMIT_MS;     // core1 came back
    r = c1wd_step(&w, t1 + 200, t1, true);
    CHECK(FEEDS(r) && !STALL(r), "a fresh tick: fed");
    CHECK_EQ_INT(w.gap, 200);
    CHECK_EQ_INT(w.max_gap, C1WD_LIMIT_MS - 1);   // the maximum survives the recovery
    r = c1wd_step(&w, t1 + C1WD_LIMIT_MS, t1, true);
    CHECK(FEEDS(r) && !STALL(r), "the next long gap is judged on its own, from the new tick");
}

static void the_maximum_survives_leaving_the_loop(void) {
    c1wd_t w;
    c1wd_init(&w);
    c1wd_step(&w, 50000 + 7000, 50000, true);
    CHECK_EQ_INT(w.max_gap, 7000);
    // core1 leaves its loop (a revoked token: back to registration and the portal) -- unsupervised, but what was
    // measured is kept, and reported with the next periodic line.
    unsigned r = c1wd_step(&w, 900000, 50000, false);
    CHECK(FEEDS(r) && !STALL(r), "out of the loop: fed, however old the tick");
    CHECK_EQ_INT(w.max_gap, 7000);
    CHECK_EQ_INT(w.gap, 0);
    c1wd_step(&w, 1000000 + 500, 1000000, true);
    CHECK_EQ_INT(w.max_gap, 7000);
}

static void the_ms_clock_wraps(void) {
    c1wd_t w;
    c1wd_init(&w);
    // ~49.7 days: the tick just before the wrap, now just after.
    const uint32_t tick = 0xFFFFFF00u;
    unsigned r = c1wd_step(&w, 0x00000100u, tick, true);   // 512 ms later
    CHECK(FEEDS(r) && !STALL(r), "a wrap is not a 49-day gap");
    CHECK_EQ_INT(w.gap, 512);
    r = c1wd_step(&w, tick + C1WD_LIMIT_MS + 1, tick, true);   // wraps too
    CHECK(STALL(r), "a real stall across the wrap is still seen");
    // A tick written after core0 read its clock (core1 is ahead by a moment): no gap, never a huge one.
    c1wd_t v;
    c1wd_init(&v);
    r = c1wd_step(&v, 1000, 1003, true);
    CHECK(FEEDS(r) && !STALL(r), "a tick newer than now");
    CHECK_EQ_INT(v.gap, 0);
    CHECK_EQ_INT(v.max_gap, 0);
}

static void the_maximum_is_reported_every_ten_minutes(void) {
    c1wd_t w;
    c1wd_init(&w);
    const uint32_t t0 = 30000;
    unsigned r = c1wd_step(&w, t0, t0, true);          // supervision starts: the clock for the report starts
    CHECK(!RPT(r), "not at the start");
    r = c1wd_step(&w, t0 + C1WD_REPORT_MS - 1, t0 + C1WD_REPORT_MS - 400, true);
    CHECK(!RPT(r), "not before ten minutes");
    r = c1wd_step(&w, t0 + C1WD_REPORT_MS, t0 + C1WD_REPORT_MS - 300, true);
    CHECK(RPT(r), "at ten minutes");
    r = c1wd_step(&w, t0 + C1WD_REPORT_MS + 10, t0 + C1WD_REPORT_MS, true);
    CHECK(!RPT(r), "once");
    r = c1wd_step(&w, t0 + 2 * C1WD_REPORT_MS, t0 + 2 * C1WD_REPORT_MS, false);
    CHECK(RPT(r), "and again ten minutes later, in the loop or not");
    // Across the wrap.
    c1wd_t v;
    c1wd_init(&v);
    c1wd_step(&v, 0xFFFFF000u, 0xFFFFF000u, true);
    r = c1wd_step(&v, 0xFFFFF000u + C1WD_REPORT_MS, 0xFFFFF000u + C1WD_REPORT_MS, true);
    CHECK(RPT(r), "the report clock wraps too");
}

static void the_limit_is_sane(void) {
    // Never below 3x the longest gap measured on the bench (core1_wd.h); the poll loop's own waits reach 60 s with
    // ticks inside them, so anything under 10 s would be a guess, not a limit.
    CHECK(C1WD_LIMIT_MS >= 10000u, "limit at least 10 s");
    CHECK(C1WD_LIMIT_MS < 0x7FFFFFFFu, "limit fits a signed ms difference");
}

static void the_limit_covers_what_the_bench_measured(void) {
    // The rule in core1_wd.h: never below 3x the longest gap the bench measured, and never below one request's
    // worst sum of timeouts (with its one retry on a new connection) -- a bad network makes that wait, not a hang.
    CHECK(C1WD_LIMIT_MS >= 3u * C1WD_BENCH_LONGEST_MS, "at least 3x the bench's longest gap");
    CHECK(C1WD_LIMIT_MS >= C1WD_WORST_REQUEST_MS, "above one request's worst sum of timeouts");
}

int main(void) {
    RUN(before_the_loop_nothing_is_supervised);
    RUN(a_new_maximum_is_kept_and_logged_rate_limited);
    RUN(the_stall_is_strictly_past_the_limit);
    RUN(a_tick_before_the_limit_clears_it);
    RUN(the_maximum_survives_leaving_the_loop);
    RUN(the_ms_clock_wraps);
    RUN(the_maximum_is_reported_every_ten_minutes);
    RUN(the_limit_is_sane);
    RUN(the_limit_covers_what_the_bench_measured);
    return REPORT();
}
