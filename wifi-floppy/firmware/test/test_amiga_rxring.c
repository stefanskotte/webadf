// amiga_rxring.c: the line ring between lwIP and amiga_send.c, and its TCP ack accounting (fw 1.23.0, spec
// 2026-10-31 section 3: the deferred minor of 1.22's final review). A line byte is acknowledged only when taken, an
// upload's raw byte at once (its credit paces it), and a close acknowledges whatever was not read.
#include <stdio.h>
#include <string.h>
#include "harness.h"
#include "../src/amiga_rxring.h"

static uint8_t BUF[49152];
static rr_ring_t R;
static uint32_t ack;
static as_raw_t *raw;

static int feed(const char *s) { ack = 0; return rr_feed(&R, &raw, (const uint8_t *)s, (int)strlen(s), &ack); }

static void line_bytes_are_acked_when_taken(void) {
    rr_init(&R, BUF, sizeof BUF); raw = NULL;
    CHECK_EQ_INT(feed("PONG\nDONE a 1\n"), 0);
    CHECK_EQ_INT(ack, 0);
    CHECK_EQ_INT(rr_used(&R), 14);
    char out[64]; int a = -1;
    CHECK_EQ_INT(rr_take_line(&R, out, sizeof out, &a), 1);
    CHECK(strcmp(out, "PONG") == 0, out); CHECK_EQ_INT(a, 5);
    CHECK_EQ_INT(rr_take_line(&R, out, sizeof out, &a), 1);
    CHECK(strcmp(out, "DONE a 1") == 0, out); CHECK_EQ_INT(a, 9);
    a = -1;
    CHECK_EQ_INT(rr_take_line(&R, out, sizeof out, &a), 0);
    CHECK_EQ_INT(a, 0);
    CHECK_EQ_INT(rr_used(&R), 0);
}

static void a_partial_line_waits_unacked(void) {
    rr_init(&R, BUF, sizeof BUF); raw = NULL;
    feed("ENT d f 1"); char out[64]; int a = -1;
    CHECK_EQ_INT(rr_take_line(&R, out, sizeof out, &a), 0); CHECK_EQ_INT(a, 0);
    feed(" 0 1.0.0 1:a 0:\n");
    CHECK_EQ_INT(rr_take_line(&R, out, sizeof out, &a), 1); CHECK_EQ_INT(a, 25);
    CHECK(strcmp(out, "ENT d f 1 0 1.0.0 1:a 0:") == 0, out);
}

static void raw_bytes_are_acked_on_arrival(void) {
    static uint8_t ring[AS_UP_RING_BYTES];
    as_raw_t w = { ring, 4, 4, 0, false };
    rr_init(&R, BUF, sizeof BUF); raw = &w;
    CHECK_EQ_INT(feed("abcdLINE\n"), 0);
    CHECK_EQ_INT(ack, 4);                                // the raw section's bytes, now
    CHECK(raw == NULL, "the section is over: lines again");
    CHECK(memcmp(ring, "abcd", 4) == 0, "raw bytes in the upload ring");
    CHECK_EQ_INT(rr_used(&R), 5);                        // the line waits, unacked
    char out[16]; int a;
    CHECK_EQ_INT(rr_take_line(&R, out, sizeof out, &a), 1); CHECK_EQ_INT(a, 5);
}

static void past_the_credit_is_an_error(void) {
    static uint8_t ring[AS_UP_RING_BYTES];
    as_raw_t w = { ring, 10, 4, 0, false };
    rr_init(&R, BUF, sizeof BUF); raw = &w;
    CHECK_EQ_INT(feed("abcdefgh"), -1);
    CHECK(w.broken, "broken");
}

// lwIP's TCP_WND on the board is 32 * 1460 = 46,720: the ring (AMIGA_TCP_RING_BYTES) holds a whole window unread.
static void a_whole_window_fits(void) {
    static uint8_t seg[1460];
    memset(seg, 'x', sizeof seg);
    rr_init(&R, BUF, sizeof BUF); raw = NULL;
    for (int i = 0; i < 32; i++) { ack = 0; CHECK_EQ_INT(rr_feed(&R, &raw, seg, sizeof seg, &ack), 0); }
    CHECK_EQ_INT(rr_used(&R), 46720);
    CHECK_EQ_INT(ack, 0);
}

static void a_full_ring_is_an_error(void) {
    static uint8_t small[8];
    rr_init(&R, small, sizeof small); raw = NULL;
    CHECK_EQ_INT(feed("1234567"), 0);                    // size - 1 bytes fit
    CHECK_EQ_INT(feed("8"), -1);
}

static void crs_dropped_long_lines_cut_but_fully_acked(void) {
    rr_init(&R, BUF, sizeof BUF); raw = NULL;
    feed("AB\r\nxxxxxxxxxx\n");
    char out[4]; int a;
    CHECK_EQ_INT(rr_take_line(&R, out, sizeof out, &a), 1);
    CHECK(strcmp(out, "AB") == 0, out); CHECK_EQ_INT(a, 4);
    CHECK_EQ_INT(rr_take_line(&R, out, sizeof out, &a), 1);
    CHECK(strcmp(out, "xxx") == 0, out); CHECK_EQ_INT(a, 11);
    CHECK_EQ_INT(rr_used(&R), 0);
}

static void wraps_around(void) {
    static uint8_t small[16];
    rr_init(&R, small, sizeof small); raw = NULL;
    char out[16]; int a;
    for (int i = 0; i < 20; i++) {
        char l[16]; snprintf(l, sizeof l, "L%03d\n", i);
        CHECK_EQ_INT(feed(l), 0);
        CHECK_EQ_INT(rr_take_line(&R, out, sizeof out, &a), 1);
        CHECK(strncmp(out, l, 4) == 0 && strlen(out) == 4, out);
        CHECK_EQ_INT(a, 5);
    }
}

static void drain_acks_unread(void) {
    rr_init(&R, BUF, sizeof BUF); raw = NULL;
    feed("abc\nde");
    CHECK_EQ_INT(rr_drain(&R), 6);
    CHECK_EQ_INT(rr_used(&R), 0);
    CHECK_EQ_INT(rr_drain(&R), 0);
}

static void no_buffer_is_an_error(void) {
    rr_init(&R, NULL, 0); raw = NULL;
    CHECK_EQ_INT(feed("x"), -1);
    char out[4]; int a = -1;
    CHECK_EQ_INT(rr_take_line(&R, out, sizeof out, &a), 0);
}

int main(void) {
    RUN(line_bytes_are_acked_when_taken);
    RUN(a_partial_line_waits_unacked);
    RUN(raw_bytes_are_acked_on_arrival);
    RUN(past_the_credit_is_an_error);
    RUN(a_whole_window_fits);
    RUN(a_full_ring_is_an_error);
    RUN(crs_dropped_long_lines_cut_but_fully_acked);
    RUN(wraps_around);
    RUN(drain_acks_unread);
    RUN(no_buffer_is_an_error);
    return REPORT();
}
