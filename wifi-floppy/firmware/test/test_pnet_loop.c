/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
#include "harness.h"
#include "../src/pnet_loop.h"
#include "../src/drive_store.h"
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

/* The pre-arm (pnet_loop.h): the loop arms the raw capture ahead of a DF1 batch, and lets go of it
 * when the batch can no longer come. The WGATE ISR's claim and DF0 cancel are main.c's. */
static pnet_prearm_in_t ready(void) {
    pnet_prearm_in_t in;
    memset(&in, 0, sizeof in);
    in.df1_serving = true;
    in.cyl1 = 77;
    in.side = 0;
    in.idle = true;
    return in;
}

static void prearms_only_where_a_df1_batch_is_next(void) {
    pnet_prearm_in_t in = ready();
    CHECK_EQ_INT(pnet_prearm_decide(&in), PNET_PREARM_ARM);
    in = ready(); in.df1_serving = false;
    CHECK_EQ_INT(pnet_prearm_decide(&in), PNET_PREARM_NONE);     /* DF1 off or empty */
    in = ready(); in.cyl1 = 76;
    CHECK_EQ_INT(pnet_prearm_decide(&in), PNET_PREARM_NONE);
    in = ready(); in.cyl1 = 78;
    CHECK_EQ_INT(pnet_prearm_decide(&in), PNET_PREARM_NONE);
    in = ready(); in.side = 1;
    CHECK_EQ_INT(pnet_prearm_decide(&in), PNET_PREARM_NONE);     /* the Amiga reads the echo */
    in = ready(); in.sel0 = true;
    CHECK_EQ_INT(pnet_prearm_decide(&in), PNET_PREARM_NONE);     /* DF0 in use */
    in = ready(); in.wgate = true;
    CHECK_EQ_INT(pnet_prearm_decide(&in), PNET_PREARM_NONE);     /* a write is on: the ISR's */
    in = ready(); in.unpowered = true;
    CHECK_EQ_INT(pnet_prearm_decide(&in), PNET_PREARM_NONE);
}

/* Task 7's hazards: an arm over a DF0 capture that is armed, ended and untaken, or taken and still
 * being decoded destroys a DF0 write-back. All three read as !idle, and none is ever armed over. */
static void never_prearms_over_a_capture(void) {
    pnet_prearm_in_t in = ready();
    in.idle = false;
    CHECK_EQ_INT(pnet_prearm_decide(&in), PNET_PREARM_NONE);
}

static void a_standing_prearm_goes_when_the_batch_cannot_come(void) {
    pnet_prearm_in_t in = ready();
    in.idle = false;                                     /* a pre-arm is an armed capture */
    in.prearmed = true;
    CHECK_EQ_INT(pnet_prearm_decide(&in), PNET_PREARM_NONE);     /* kept */
    in.sel0 = true;
    CHECK_EQ_INT(pnet_prearm_decide(&in), PNET_PREARM_NONE);     /* DF0 selected: its WGATE cancels */
    in.sel0 = false;
    in.side = 1;
    CHECK_EQ_INT(pnet_prearm_decide(&in), PNET_PREARM_CANCEL);
    in.side = 0; in.cyl1 = 76;
    CHECK_EQ_INT(pnet_prearm_decide(&in), PNET_PREARM_CANCEL);
    in.cyl1 = 77; in.df1_serving = false;
    CHECK_EQ_INT(pnet_prearm_decide(&in), PNET_PREARM_CANCEL);   /* DF1 off or ejected */
    in.df1_serving = true; in.unpowered = true;
    CHECK_EQ_INT(pnet_prearm_decide(&in), PNET_PREARM_CANCEL);
    in.wgate = true;                                     /* a floating WGATE reads asserted */
    CHECK_EQ_INT(pnet_prearm_decide(&in), PNET_PREARM_CANCEL);
}

static void stray_edges_are_discarded_but_a_write_is_the_isrs(void) {
    pnet_prearm_in_t in = ready();
    in.idle = false;
    in.prearmed = true;
    in.edges = true;
    CHECK_EQ_INT(pnet_prearm_decide(&in), PNET_PREARM_STRAY);
    in.side = 1;
    CHECK_EQ_INT(pnet_prearm_decide(&in), PNET_PREARM_STRAY);    /* counted as stray either way */
    in.side = 0;
    in.wgate = true;                                     /* the write's own edges: the ISR's */
    CHECK_EQ_INT(pnet_prearm_decide(&in), PNET_PREARM_NONE);
    in.side = 1; in.cyl1 = 3;
    CHECK_EQ_INT(pnet_prearm_decide(&in), PNET_PREARM_NONE);     /* under WGATE, never the loop */
}

/* Every input: ARM only when the next WGATE on SEL1 would be a batch (pnet_capture_ours) and the
 * capture is idle; CANCEL and STRAY only with a pre-arm standing; nothing at all under WGATE but
 * an unpowered bus's cancel. */
static void the_decision_holds_for_every_input(void) {
    const int cyls[] = {0, 1, 76, 77, 78, 79};
    unsigned n = 0, arms = 0;
    for (unsigned bits = 0; bits < 128u; bits++)
        for (unsigned c = 0; c < 6; c++)
            for (int side = 0; side < 2; side++) {
                pnet_prearm_in_t in;
                memset(&in, 0, sizeof in);
                in.df1_serving = bits & 1u; in.sel0 = bits & 2u; in.wgate = bits & 4u;
                in.unpowered = bits & 8u; in.idle = bits & 16u; in.prearmed = bits & 32u;
                in.edges = bits & 64u;
                in.cyl1 = cyls[c]; in.side = side;
                const pnet_prearm_t a = pnet_prearm_decide(&in);
                n++;
                if (a == PNET_PREARM_ARM) {
                    arms++;
                    CHECK(in.idle && !in.prearmed && !in.wgate && !in.sel0 && !in.unpowered &&
                          pnet_capture_ours(in.df1_serving, false, true, in.cyl1, in.side),
                          "ARM only ahead of a DF1 batch, over nothing");
                }
                if (a == PNET_PREARM_CANCEL || a == PNET_PREARM_STRAY)
                    CHECK(in.prearmed, "only a standing pre-arm is let go");
                if (in.wgate && a != PNET_PREARM_NONE)
                    CHECK(in.unpowered && a == PNET_PREARM_CANCEL, "under WGATE: the ISR's");
            }
    CHECK_EQ_INT(n, 128 * 6 * 2);
    CHECK_EQ_INT(arms, 2);                               /* edges set or not; nothing else */
}

static void a_start_is_classified_by_its_wait(void) {
    CHECK_EQ_INT(pnet_go_kind(2325u, 20u), PNET_GO_ALARM);
    CHECK_EQ_INT(pnet_go_kind(21u, 20u), PNET_GO_ALARM);
    CHECK_EQ_INT(pnet_go_kind(20u, 20u), PNET_GO_SHORT);
    CHECK_EQ_INT(pnet_go_kind(1u, 20u), PNET_GO_SHORT);
    CHECK_EQ_INT(pnet_go_kind(0u, 20u), PNET_GO_LATE);
    CHECK_EQ_INT(pnet_go_still_wanted(PNET_TRACK_OUT), 1);
    CHECK_EQ_INT(pnet_go_still_wanted(PNET_TRACK_IN), 0);
    CHECK_EQ_INT(pnet_go_still_wanted(0), 0);
}

/* Phase 2 (§3.4): how long a side-1 start still waits for the SIDE edge + the delay. */
static void a_side_one_start_waits_from_the_side_edge(void) {
    CHECK_EQ_INT(pnet_go_wait_us(1000u, 2360u, 1035u), 2325);             /* the loop saw it at once */
    CHECK_EQ_INT(pnet_go_wait_us(1000u, 2360u, 3360u), 0);                /* due now */
    CHECK_EQ_INT(pnet_go_wait_us(1000u, 2360u, 4000u), 0);                /* the loop came late: at once */
    CHECK_EQ_INT(pnet_go_wait_us(0xFFFFFF00u, 2360u, 0x10u), 2088);       /* across time_us_32's wrap */
    CHECK_EQ_INT(pnet_go_wait_us(5000u, 2360u, 4990u), 0);                /* a stamp a hair ahead of now */
    CHECK_EQ_INT(pnet_go_wait_us(0u, 2360u, 0x90000000u), 0);             /* a stale stamp: never far ahead */
}

// Phase 3 (plan 2026-10-12 ruling 2): one predicate decides whether the PaulaNET path runs.
static void the_network_path_runs_only_in_network_mode(void) {
    CHECK(!pnet_mode_on(DF1_MODE_OFF, false), "release, off: never");
    CHECK(!pnet_mode_on(DF1_MODE_NEXT, false), "release, next disk: never -- cylinders 76/77 are disk data");
    CHECK(pnet_mode_on(DF1_MODE_NET, false), "release, network: yes");
    CHECK(!pnet_mode_on(DF1_MODE_OFF, true), "echo build, off: never");
    CHECK(pnet_mode_on(DF1_MODE_NEXT, true), "echo build, next disk: yes, as its bench always ran it");
    CHECK(pnet_mode_on(DF1_MODE_NET, true), "echo build, network: yes");
    CHECK(!pnet_mode_on(7u, false) && !pnet_mode_on(7u, true), "an unknown mode: never");
}

// Review Focus 4: when Network mode ends, the loop's pre-arm step sees DF1 not serving and lets a
// standing pre-arm go -- wherever the head is, cylinder 77 side 0 included.
static void leaving_network_mode_cancels_a_standing_prearm(void) {
    pnet_prearm_in_t in = { .df1_serving = false, .sel0 = false, .wgate = false, .unpowered = false,
                            .cyl1 = 77, .side = 0, .idle = false, .prearmed = true, .edges = false };
    CHECK_EQ_INT(pnet_prearm_decide(&in), PNET_PREARM_CANCEL);
    in.prearmed = false; in.idle = true;
    CHECK_EQ_INT(pnet_prearm_decide(&in), PNET_PREARM_NONE);   // and never arms again
}

// Review Focus 4 through the gate itself (pre-flight I11): main.c's loop runs pnet_prearm_gated with
// pnet_mode_on's answer. DF1 still holds a disk -- Next disk, or Network's driver disk left mounted
// after a switch -- with the head on cylinder 77 side 0, exactly where Network mode arms. Off the
// gate, a standing pre-arm goes and nothing is armed; on it, the decision is pnet_prearm_decide's.
static void the_gate_lets_a_prearm_go_and_never_arms_outside_network_mode(void) {
    pnet_prearm_in_t in = { .df1_serving = true, .sel0 = false, .wgate = false, .unpowered = false,
                            .cyl1 = 77, .side = 0, .idle = false, .prearmed = true, .edges = false };
    const bool next_release = pnet_mode_on(DF1_MODE_NEXT, false);
    const bool net_release = pnet_mode_on(DF1_MODE_NET, false);
    CHECK_EQ_INT(pnet_prearm_gated(net_release, &in), PNET_PREARM_NONE);      // Network: it stands
    CHECK_EQ_INT(pnet_prearm_gated(next_release, &in), PNET_PREARM_CANCEL);   // switched to Next: it goes
    CHECK_EQ_INT(pnet_prearm_gated(pnet_mode_on(DF1_MODE_OFF, false), &in), PNET_PREARM_CANCEL);
    in.prearmed = false; in.idle = true;
    CHECK_EQ_INT(pnet_prearm_gated(net_release, &in), PNET_PREARM_ARM);       // Network arms here
    CHECK_EQ_INT(pnet_prearm_gated(next_release, &in), PNET_PREARM_NONE);     // Next never does
    CHECK_EQ_INT(pnet_prearm_gated(pnet_mode_on(DF1_MODE_OFF, false), &in), PNET_PREARM_NONE);
    // The echo TEST build runs Next disk's bench as it always has.
    CHECK_EQ_INT(pnet_prearm_gated(pnet_mode_on(DF1_MODE_NEXT, true), &in), PNET_PREARM_ARM);
    // Off the gate, every other input: never ARM, and a standing pre-arm never survives.
    for (unsigned bits = 0; bits < 256u; bits++) {
        pnet_prearm_in_t x = { .df1_serving = bits & 1u, .sel0 = bits & 2u, .wgate = bits & 4u,
                               .unpowered = bits & 8u, .cyl1 = (bits & 16u) ? 77 : 40, .side = (bits & 32u) ? 1 : 0,
                               .idle = bits & 64u, .prearmed = bits & 128u, .edges = false };
        const pnet_prearm_t r = pnet_prearm_gated(false, &x);
        CHECK(r != PNET_PREARM_ARM, "off the gate: never armed");
        if (x.prearmed && !x.wgate) CHECK(r == PNET_PREARM_CANCEL, "off the gate: a standing pre-arm goes");
        if (!x.prearmed) CHECK(r == PNET_PREARM_NONE, "off the gate, nothing standing: nothing to do");
        CHECK_EQ_INT(pnet_prearm_gated(true, &x), pnet_prearm_decide(&x));
    }
}

int main(void) {
    RUN(df1_streams_disk_silence_or_echo);
    RUN(wprot_is_released_only_on_cylinder_77);
    RUN(only_df1_on_77_side_0_is_a_batch);
    RUN(counters_follow_paulanet);
    RUN(counters_wrap);
    RUN(prearms_only_where_a_df1_batch_is_next);
    RUN(never_prearms_over_a_capture);
    RUN(a_standing_prearm_goes_when_the_batch_cannot_come);
    RUN(stray_edges_are_discarded_but_a_write_is_the_isrs);
    RUN(the_decision_holds_for_every_input);
    RUN(a_side_one_start_waits_from_the_side_edge);
    RUN(a_start_is_classified_by_its_wait);
    RUN(the_network_path_runs_only_in_network_mode);
    RUN(leaving_network_mode_cancels_a_standing_prearm);
    RUN(the_gate_lets_a_prearm_go_and_never_arms_outside_network_mode);
    return REPORT();
}
