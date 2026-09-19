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

// Keyed on the disk's ID, not its digest: a close gives the same disk a new
// digest (write-back), and a flip landing in that same pass must still be
// announced -- to the Amiga it is the disk it has been writing to.
static void a_flip_together_with_a_new_digest_is_still_the_same_disk(void) {
    reinsert_t r; reinsert_init(&r);
    reinsert_on_wprot(&r, true, "disk-1", false);
    CHECK(reinsert_on_wprot(&r, true, "disk-1", true), "same disk id: announced, whatever the digest did");
}

int main(void) {
    RUN(first_sight_never_requests);
    RUN(a_flip_on_the_same_disk_requests_once);
    RUN(a_flip_that_comes_with_another_disk_does_not);
    RUN(eject_and_remount_do_not);
    RUN(a_flip_together_with_a_new_digest_is_still_the_same_disk);
    return REPORT();
}
