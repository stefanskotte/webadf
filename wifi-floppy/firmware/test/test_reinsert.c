#include "harness.h"
#include "../src/reinsert.h"

/*
 * AmigaDOS reads a disk's write-protect state only when it believes a disk
 * was inserted. So a flip of the flag on the SAME mounted disk must be
 * announced as a disk change; a flip that comes with a different disk (or
 * none) must not -- the mount/eject path already announces those.
 */

static void first_sight_never_requests(void) {
    reinsert_t r; reinsert_init(&r);
    CHECK(!reinsert_on_wprot(&r, true, "disk-1", false), "the first mount is announced by the mount path");
}

static void a_flip_on_the_same_disk_requests_once(void) {
    reinsert_t r; reinsert_init(&r);
    reinsert_on_wprot(&r, true, "disk-1", true);
    CHECK(!reinsert_on_wprot(&r, true, "disk-1", true), "no change, no request");
    CHECK(reinsert_on_wprot(&r, true, "disk-1", false), "writable now: announce it");
    CHECK(!reinsert_on_wprot(&r, true, "disk-1", false), "once, not every pass");
    CHECK(reinsert_on_wprot(&r, true, "disk-1", true), "and back to protected");
}

static void a_flip_that_comes_with_another_disk_does_not(void) {
    reinsert_t r; reinsert_init(&r);
    reinsert_on_wprot(&r, true, "disk-1", true);
    CHECK(!reinsert_on_wprot(&r, true, "disk-2", false), "another disk is announced by the mount path");
    CHECK(reinsert_on_wprot(&r, true, "disk-2", true), "but a later flip on it is");
}

static void eject_and_remount_do_not(void) {
    reinsert_t r; reinsert_init(&r);
    reinsert_on_wprot(&r, true, "disk-1", false);
    CHECK(!reinsert_on_wprot(&r, false, "", true), "an eject is announced by the eject path");
    CHECK(!reinsert_on_wprot(&r, true, "disk-1", false), "a remount of the same disk is announced by the mount path");
}

// The poll reads diskId best-effort. Without one, two different disks would
// look identical, and a swap between them would be announced twice.
static void an_empty_disk_id_is_never_the_same_disk(void) {
    reinsert_t r; reinsert_init(&r);
    reinsert_on_wprot(&r, true, "", true);
    CHECK(!reinsert_on_wprot(&r, true, "", false), "no id, no claim that it is the same disk");
}

// A poll that omits diskId must not overwrite the identity remembered from
// an earlier one -- otherwise the NEXT flip that arrives with the real id
// again looks like a different disk and is swallowed.
static void an_empty_poll_does_not_erase_the_remembered_id(void) {
    reinsert_t r; reinsert_init(&r);
    reinsert_on_wprot(&r, true, "disk-1", true);
    CHECK(!reinsert_on_wprot(&r, true, "", true), "no id this pass: no claim either way");
    CHECK(reinsert_on_wprot(&r, true, "disk-1", false), "id back, and it flipped: announce it");
}

/*
 * reinsert_may_announce: the pure "may we act on a pending request now?"
 * gate. now/raised_ms/last_activity_ms are plain millisecond clocks, so
 * every test uses the same (int32_t)(now - x) idiom the uploader uses
 * rather than assuming `now` never wraps.
 */

static void idle_and_quiet_announces(void) {
    bool forced = true;
    // now=10000, raised long ago but well inside the deadline, no recent
    // write activity, motor off, WGATE clear.
    CHECK(reinsert_may_announce(10000, 9000, false, false, 0, &forced),
          "idle, motor off, WGATE clear: announce");
    CHECK(!forced, "not the forced case");
}

static void motor_on_waits(void) {
    bool forced = true;
    CHECK(!reinsert_may_announce(10000, 9000, true, false, 0, &forced),
          "motor on: wait, it may be mid-seek");
    CHECK(!forced, "waiting is not forcing");
}

static void wgate_asserted_waits(void) {
    bool forced = true;
    CHECK(!reinsert_may_announce(10000, 9000, false, true, 0, &forced),
          "WGATE asserted: wait, a write may be under way");
}

static void within_the_idle_window_of_an_applied_write_waits(void) {
    // last_activity_ms 500 ms before now, well inside REINSERT_IDLE_MS.
    CHECK(!reinsert_may_announce(10000, 9000, false, false, 9500, NULL),
          "a write applied just now: wait out REINSERT_IDLE_MS");
}

static void within_the_idle_window_of_a_merely_attempted_write_waits(void) {
    // Same shape, but this models g_wgate_last_ms (a rejected capture) --
    // the caller picks whichever of the two timestamps is later before
    // calling in, so from this function's point of view it is simply
    // "recent activity", applied or not.
    CHECK(!reinsert_may_announce(10000, 9000, false, false, 9999, NULL),
          "a write merely attempted (torn/bad checksum/wrong track/overflow) "
          "still starts the idle window");
}

static void past_the_idle_window_announces(void) {
    CHECK(reinsert_may_announce(13000, 9000, false, false, 9000, NULL),
          "REINSERT_IDLE_MS (3000) has fully elapsed since the last activity");
}

static void pending_past_the_deadline_announces_forced(void) {
    bool forced = false;
    // Motor still on AND WGATE still asserted -- would wait forever without
    // the deadline. raised_ms 15000 ms ago (REINSERT_FORCE_MS).
    CHECK(reinsert_may_announce(15000, 0, true, true, 0, &forced),
          "past the 15 s deadline: announce anyway");
    CHECK(forced, "and say it was forced");
}

static void just_under_the_deadline_still_waits(void) {
    bool forced = true;
    CHECK(!reinsert_may_announce(14999, 0, true, true, 0, &forced),
          "1 ms short of the deadline: still wait");
    CHECK(!forced, "not forced");
}

static void wraparound_is_not_a_special_case(void) {
    // now has wrapped past 0; raised_ms is still the pre-wrap value. The
    // (int32_t) subtraction idiom must see this the same as any other
    // 15000 ms-old request.
    const uint32_t raised = 0xFFFFFFFFu - 6000u;   // 6 s before the wrap
    const uint32_t now    = 9000u;                 // 15 s after `raised`, wrapped
    bool forced = false;
    CHECK(reinsert_may_announce(now, raised, true, true, 0, &forced),
          "15 s elapsed across the wrap: still forces");
    CHECK(forced, "still reported as forced");
}

int main(void) {
    RUN(first_sight_never_requests);
    RUN(a_flip_on_the_same_disk_requests_once);
    RUN(a_flip_that_comes_with_another_disk_does_not);
    RUN(eject_and_remount_do_not);
    RUN(an_empty_disk_id_is_never_the_same_disk);
    RUN(an_empty_poll_does_not_erase_the_remembered_id);
    RUN(idle_and_quiet_announces);
    RUN(motor_on_waits);
    RUN(wgate_asserted_waits);
    RUN(within_the_idle_window_of_an_applied_write_waits);
    RUN(within_the_idle_window_of_a_merely_attempted_write_waits);
    RUN(past_the_idle_window_announces);
    RUN(pending_past_the_deadline_announces_forced);
    RUN(just_under_the_deadline_still_waits);
    RUN(wraparound_is_not_a_special_case);
    return REPORT();
}
