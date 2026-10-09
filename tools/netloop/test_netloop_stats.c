/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
#include "../../wifi-floppy/firmware/test/harness.h"
#include "netloop_stats.h"
#include <string.h>

static void sizes_split_into_ethernet_frames(void) {
    uint16_t l[20]; unsigned n = 0;
    nl_split(64, l, &n);
    CHECK(n == 1 && l[0] == 64, "64");
    nl_split(1500, l, &n);
    CHECK(n == 1 && l[0] == 1500, "1500");
    nl_split(8000, l, &n);
    CHECK(n == 6 && l[0] == 1500 && l[4] == 1500 && l[5] == 500, "8000 = 5 x 1500 + 500");
    nl_split(12000, l, &n);
    CHECK(n == 8 && l[7] == 1500, "12000 = 8 x 1500");
}

static void the_payload_is_repeatable_and_never_stuck(void) {
    uint8_t a[64], b[64];
    nl_fill(42, a, sizeof a);
    nl_fill(42, b, sizeof b);
    CHECK(memcmp(a, b, sizeof a) == 0, "same seed, same bytes");
    nl_fill(0, a, sizeof a);
    int nonzero = 0;
    for (unsigned i = 0; i < sizeof a; i++) nonzero |= a[i];
    CHECK(nonzero, "seed 0 does not give zeros");
}

/* Review Focus 2: an echo the board built before it decoded this round's write is stale. */
static void only_this_rounds_echo_answers(void) {
    CHECK(nl_echo_answers(5, 0x81, 5, 0x80), "acks 5, a new batch");
    CHECK(!nl_echo_answers(4, 0x80, 5, 0x80), "still the previous round's echo");
    CHECK(!nl_echo_answers(5, 0x80, 5, 0x80), "acks 5 but a batch we already had");
}

/* Review Focus 3: a restart resumes after the board's counter, never on it. */
static void a_restart_resyncs_from_the_boards_counter(void) {
    CHECK_EQ_INT(nl_start_ctr(false, 0x00), 0xFF);
    const uint8_t c = nl_start_ctr(true, 0x00);
    CHECK((uint8_t)(c + 1) != 0x00, "the next batch is new to a board that last took 0x00");
    CHECK_EQ_INT((uint8_t)(nl_start_ctr(true, 0xFF) + 1), 0x00);
    /* The board still holds the previous run's non-empty echo: it acks 0x00 and carries pico 0x81.
     * A restart that began from 0xFF/0xFF would judge its first batch (ctr 0x00) against that
     * stale echo and pass it. Resynced from the header, the same echo answers nothing. */
    const uint8_t board_amiga = 0x00, board_pico = 0x81;
    CHECK(nl_echo_answers(board_amiga, board_pico, (uint8_t)(nl_start_ctr(false, 0) + 1), 0xFF),
          "without a resync the stale echo would pass (the defect)");
    CHECK(!nl_echo_answers(board_amiga, board_pico, (uint8_t)(nl_start_ctr(true, board_amiga) + 1), board_pico),
          "after a resync the stale echo answers nothing");
}

static void percentiles_are_nearest_rank(void) {
    uint32_t v[10] = {10, 1, 9, 2, 8, 3, 7, 4, 6, 5};
    CHECK_EQ_INT(nl_percentile(v, 10, 50), 5);
    CHECK_EQ_INT(nl_percentile(v, 10, 95), 10);
    CHECK_EQ_INT(v[0], 1);
    CHECK_EQ_INT(nl_percentile(v, 0, 50), 0);
    uint32_t one[1] = {7};
    CHECK_EQ_INT(nl_percentile(one, 1, 95), 7);
}

static void tenths_round(void) {
    CHECK_EQ_INT(nl_tenths(1, 3), 3);          /* 0.33 -> 0.3 */
    CHECK_EQ_INT(nl_tenths(2, 3), 7);          /* 0.67 -> 0.7 */
    CHECK_EQ_INT(nl_tenths(5, 0), 0);
    /* 8,000 B x 100 rounds in 709,379 E-clock ticks (1 s on a PAL A500) = 781.3 KB/s */
    CHECK_EQ_INT(nl_tenths(8000ull * 100u * 709379u, 709379ull * 1024u), 7813);
}

int main(void) {
    RUN(sizes_split_into_ethernet_frames);
    RUN(the_payload_is_repeatable_and_never_stuck);
    RUN(only_this_rounds_echo_answers);
    RUN(a_restart_resyncs_from_the_boards_counter);
    RUN(percentiles_are_nearest_rank);
    RUN(tenths_round);
    return REPORT();
}
