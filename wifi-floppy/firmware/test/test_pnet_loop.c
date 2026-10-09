/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
#include "harness.h"
#include "../src/pnet_loop.h"
#include <stdint.h>
#include <string.h>

/* The cylinder-77 loopback's decisions. */

static void df1_streams_disk_silence_or_echo(void) {
    CHECK_EQ_INT(pnet_df1_for_track(154), PNET_DF1_SILENT);
    CHECK_EQ_INT(pnet_df1_for_track(155), PNET_DF1_ECHO);
    CHECK_EQ_INT(pnet_df1_for_track(0), PNET_DF1_DISK);
    CHECK_EQ_INT(pnet_df1_for_track(153), PNET_DF1_DISK);
    CHECK_EQ_INT(pnet_df1_for_track(156), PNET_DF1_DISK);
    CHECK_EQ_INT(pnet_df1_for_track(-1), PNET_DF1_DISK);
}

static void wprot_is_released_only_on_cylinder_77(void) {
    CHECK(!pnet_df1_wprot(77), "77 writable");
    CHECK(pnet_df1_wprot(76) && pnet_df1_wprot(78) && pnet_df1_wprot(0) && pnet_df1_wprot(40),
          "everywhere else protected");
}

static void only_df1_on_77_side_0_is_a_batch(void) {
    CHECK(pnet_capture_ours(true, false, true, 77, 0), "DF1, 77, side 0");
    CHECK(!pnet_capture_ours(true, false, true, 77, 1), "side 1 is the Amiga reading");
    CHECK(!pnet_capture_ours(true, false, true, 76, 0), "another cylinder");
    CHECK(!pnet_capture_ours(false, false, true, 77, 0), "DF1 not serving a disk");
    CHECK(!pnet_capture_ours(true, false, false, 77, 0), "SEL1 not asserted");
    /* DF0's writes stay DF0's, whatever DF1's head is doing */
    CHECK(!pnet_capture_ours(true, true, false, 77, 0), "SEL0: a DF0 write");
    CHECK(!pnet_capture_ours(true, true, true, 77, 0), "both selects: never ours");
}

static pnet_hdr_t hdr(uint8_t amiga, uint8_t pico) {
    pnet_hdr_t h;
    memset(&h, 0, sizeof h);
    h.mode = PNET_MODE_ETHERNET;
    h.amiga_ctr = amiga;
    h.pico_ctr = pico;
    return h;
}

static void counters_follow_paulanet(void) {
    pnet_loop_t s;
    pnet_loop_init(&s);
    CHECK_EQ_INT(s.last_amiga, 0xFF);
    CHECK_EQ_INT(s.pico, 0x7F);
    const uint16_t two[2] = {64, 1500}, one[1] = {9};
    pnet_hdr_t h = hdr(0x00, 0xFF);                      /* the Amiga's first batch */
    CHECK(pnet_loop_is_new(&s, &h), "new");
    pnet_loop_commit(&s, &h, 2, two);
    CHECK_EQ_INT(s.pico, 0x80);
    CHECK_EQ_INT(s.nframes, 2);
    CHECK_EQ_INT(s.last_amiga, 0x00);
    CHECK(!pnet_loop_is_new(&s, &h), "the same counter again is a resend");
    pnet_loop_commit(&s, &h, 0, NULL);
    CHECK_EQ_INT(s.dup, 1);
    CHECK_EQ_INT(s.nframes, 2);                          /* a resend keeps the echo */
    h = hdr(0x01, 0x80);                                 /* next batch, acknowledging ours */
    pnet_loop_commit(&s, &h, 1, one);
    CHECK_EQ_INT(s.nframes, 1);
    CHECK_EQ_INT(s.len[0], 9);
    CHECK_EQ_INT(s.pico, 0x81);
    h = hdr(0x02, 0x81);                                 /* an empty batch that acknowledges */
    pnet_loop_commit(&s, &h, 0, NULL);
    CHECK_EQ_INT(s.nframes, 0);
    CHECK_EQ_INT(s.pico, 0x81);
    CHECK_EQ_INT(s.fresh, 3);
}

static void counters_wrap(void) {
    pnet_loop_t s;
    pnet_loop_init(&s);
    const uint16_t one[1] = {1};
    for (unsigned i = 0; i < 300; i++) {
        pnet_hdr_t h = hdr((uint8_t)i, s.pico);
        CHECK(pnet_loop_is_new(&s, &h), "every next counter is new");
        pnet_loop_commit(&s, &h, 1, one);
    }
    CHECK_EQ_INT(s.fresh, 300);
    CHECK_EQ_INT(s.dup, 0);
    CHECK_EQ_INT(s.pico, (uint8_t)(0x7F + 300));
}

int main(void) {
    RUN(df1_streams_disk_silence_or_echo);
    RUN(wprot_is_released_only_on_cylinder_77);
    RUN(only_df1_on_77_side_0_is_a_batch);
    RUN(counters_follow_paulanet);
    RUN(counters_wrap);
    return REPORT();
}
