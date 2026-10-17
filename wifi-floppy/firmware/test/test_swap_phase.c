#include "harness.h"
#include "../src/swap_phase.h"

/*
 * A disk replaced by another disk must look, to the Amiga, like a human swap:
 * the drive EMPTY for a while, then the new disk. Field report 2026-10-17:
 * Workbench 3.2's "Please insert volume Locale" requester did not close by
 * itself after a web mount, because the board went from one disk straight to
 * the next and Kickstart's trackdisk saw removal and insertion ~100 us apart,
 * in one change poll -- the insertion was swallowed.
 */

static void first_mount_into_an_empty_drive_inserts_at_once(void) {
    swap_phase_t p;
    swap_phase_init(&p);
    CHECK(swap_phase_on_change(&p, 1000, false, true) == SWAP_PHASE_INSERT_NOW,
          "nothing was in the drive: insert now, as before");
    CHECK(!swap_phase_empty(&p), "no empty phase");
    CHECK(!swap_phase_insert_due(&p, 1000 + SWAP_EMPTY_MS), "nothing pending");
}

static void eject_ejects(void) {
    swap_phase_t p;
    swap_phase_init(&p);
    CHECK(swap_phase_on_change(&p, 1000, true, false) == SWAP_PHASE_EJECT, "disk removed: eject");
    CHECK(!swap_phase_empty(&p), "an eject is not a swap phase");
}

static void disk_over_disk_goes_empty_first(void) {
    swap_phase_t p;
    swap_phase_init(&p);
    CHECK(swap_phase_on_change(&p, 5000, true, true) == SWAP_PHASE_GO_EMPTY,
          "one disk replaced by another: present the drive empty first");
    CHECK(swap_phase_empty(&p), "empty now");
    CHECK(!swap_phase_insert_due(&p, 5000), "not at once");
    CHECK(!swap_phase_insert_due(&p, 5000 + SWAP_EMPTY_MS - 1), "not a millisecond early");
    CHECK(swap_phase_empty(&p), "still empty just before the deadline");
    CHECK(swap_phase_insert_due(&p, 5000 + SWAP_EMPTY_MS), "at the deadline: insert");
    CHECK(!swap_phase_empty(&p), "and the phase is over");
    CHECK(!swap_phase_insert_due(&p, 5000 + SWAP_EMPTY_MS + 1), "once only");
}

static void late_check_still_inserts(void) {
    swap_phase_t p;
    swap_phase_init(&p);
    swap_phase_on_change(&p, 5000, true, true);
    CHECK(swap_phase_insert_due(&p, 5000 + SWAP_EMPTY_MS + 700), "a loop pass that came late still inserts");
}

// The empty interval must cover at least two of trackdisk's 0.5 s with-a-disk
// change polls, so one of them is sure to see the drive empty.
static void the_interval_spans_two_change_polls(void) {
    CHECK(SWAP_EMPTY_MS >= 2u * SWAP_TD_POLL_MS, "two polls fit in the empty phase");
    CHECK(SWAP_EMPTY_MS < SWAP_TD_EMPTY_POLL_MS, "and the insert lands before the next empty-drive poll");
}

// Two mounts in quick succession (a double Next tap, a web mount over a Next):
// the drive stays empty, the timer restarts, and the newest disk goes in.
static void a_second_swap_during_the_empty_phase_restarts_the_timer(void) {
    swap_phase_t p;
    swap_phase_init(&p);
    swap_phase_on_change(&p, 5000, true, true);
    CHECK(swap_phase_on_change(&p, 5600, true, true) == SWAP_PHASE_GO_EMPTY,
          "another disk while empty: empty again");
    CHECK(!swap_phase_insert_due(&p, 5000 + SWAP_EMPTY_MS), "the first deadline no longer counts");
    CHECK(swap_phase_insert_due(&p, 5600 + SWAP_EMPTY_MS), "the restarted deadline does");
}

static void an_eject_during_the_empty_phase_cancels_the_insert(void) {
    swap_phase_t p;
    swap_phase_init(&p);
    swap_phase_on_change(&p, 5000, true, true);
    CHECK(swap_phase_on_change(&p, 5300, true, false) == SWAP_PHASE_EJECT, "ejected meanwhile");
    CHECK(!swap_phase_empty(&p), "no phase");
    CHECK(!swap_phase_insert_due(&p, 5000 + SWAP_EMPTY_MS), "and nothing is inserted");
}

static void cancel_drops_a_pending_insert(void) {
    swap_phase_t p;
    swap_phase_init(&p);
    swap_phase_on_change(&p, 5000, true, true);
    swap_phase_cancel(&p);
    CHECK(!swap_phase_empty(&p), "cancelled");
    CHECK(!swap_phase_insert_due(&p, 5000 + SWAP_EMPTY_MS), "nothing to insert");
}

static void wraparound_is_not_a_special_case(void) {
    swap_phase_t p;
    swap_phase_init(&p);
    const uint32_t start = 0xFFFFFFFFu - 300u;   // the deadline lands past the wrap
    swap_phase_on_change(&p, start, true, true);
    CHECK(!swap_phase_insert_due(&p, start + 200u), "before the wrap: not due");
    CHECK(!swap_phase_insert_due(&p, start + SWAP_EMPTY_MS - 1u), "after the wrap, a ms early: not due");
    CHECK(swap_phase_insert_due(&p, start + SWAP_EMPTY_MS), "after the wrap, at the deadline: due");
}

int main(void) {
    RUN(first_mount_into_an_empty_drive_inserts_at_once);
    RUN(eject_ejects);
    RUN(disk_over_disk_goes_empty_first);
    RUN(late_check_still_inserts);
    RUN(the_interval_spans_two_change_polls);
    RUN(a_second_swap_during_the_empty_phase_restarts_the_timer);
    RUN(an_eject_during_the_empty_phase_cancels_the_insert);
    RUN(cancel_drops_a_pending_insert);
    RUN(wraparound_is_not_a_special_case);
    return REPORT();
}
