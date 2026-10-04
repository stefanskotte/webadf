#include "harness.h"
#include "../src/poll_wake.h"

/*
 * A save that lands while core1 waits in the server's long poll must not wait
 * for the poll to come back (up to ~25 s; 20 s seen on 2026-10-04, HANDOFF
 * 3av). The poll yields when a tap is waiting OR the write cursor moved since
 * the poll began. A cursor, not a flag: the mark is retaken before every poll,
 * so a write that has already been seen can never cut a later poll short
 * (which would loop polls as fast as the server answers).
 */

static void nothing_new_keeps_the_poll(void) {
    CHECK(!poll_should_yield(false, 5000, 5000), "no tap, no write since the mark: keep waiting");
}

static void a_write_since_the_mark_yields(void) {
    CHECK(poll_should_yield(false, 5013, 5000), "a write landed during the poll: give core1 back");
}

static void a_waiting_tap_yields(void) {
    CHECK(poll_should_yield(true, 5000, 5000), "a tap is waiting: give core1 back (as before)");
}

static void a_seen_write_does_not_yield_the_next_poll(void) {
    // The loop retakes the mark (= the write's stamp) before the next poll.
    uint32_t write_ms = 5013;
    uint32_t mark = write_ms;
    CHECK(!poll_should_yield(false, write_ms, mark), "already uploaded: the next poll is not cut short");
}

static void the_cursor_survives_the_wrap(void) {
    CHECK(poll_should_yield(false, 3u, 0xfffffff0u), "a write after the 49-day wrap still yields");
    CHECK(!poll_should_yield(false, 0xfffffff0u, 0xfffffff0u), "no write across the wrap: keep waiting");
}

int main(void) {
    RUN(nothing_new_keeps_the_poll);
    RUN(a_write_since_the_mark_yields);
    RUN(a_waiting_tap_yields);
    RUN(a_seen_write_does_not_yield_the_next_poll);
    RUN(the_cursor_survives_the_wrap);
    return REPORT();
}
