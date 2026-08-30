#include "harness.h"
#include "../src/track_cache.h"
#include "../src/psram_image.h"
#include <stdlib.h>
#include <string.h>

// Review round 1, Critical finding: track_cache.c used to tag its SRAM
// double-buffer entries with the bare PSRAM slot INDEX. A slot index is
// reused across disk generations (there are only SLOT_COUNT of them), so
// that tag cannot tell today's occupant of a slot apart from yesterday's --
// a cached copy from an old disk could be served for a new one that landed
// back on the same slot index. Both tests below reproduce a concrete
// realisation of that bug and must fail against the bare-slot tag, then
// pass once cache entries are tagged with the full generation-carrying
// token (psram_active_token()) instead.

static uint8_t disk1_track5[64], disk3_track5[64], disk2_track7[64];

static void write_track(int slot, int track, uint8_t fill) {
    uint8_t src[64];
    memset(src, fill, sizeof src);
    psram_image_write_at(slot, track, 0, src, sizeof src);
    psram_image_commit(slot, track, sizeof(src) * 8u);
}

// Realisation 1 (eject path): mount disk1 on slot 0, cache its track 5,
// eject (publish SLOT_NONE), then fetch disk2 into the slot the eject
// freed up -- which is slot 0 again, since psram_inactive_slot() defaults
// to 0 once nothing is mounted. A stale bare-slot tag would still say
// "slot 0, track 5" and serve disk1's bytes for disk2.
static void test_eject_then_refetch_does_not_serve_stale_track(void) {
    memset(disk1_track5, 0xAA, sizeof disk1_track5);
    memset(disk2_track7, 0x55, sizeof disk2_track7); // reused as disk2's track5 fill below

    track_cache_init();
    psram_image_reset_slot(0);
    write_track(0, 5, 0xAA);
    psram_publish_slot(0);

    uint32_t bits = 0;
    const uint8_t *got = track_cache_get(5, &bits);
    CHECK(got != NULL, "disk1's track 5 must be servable once mounted");
    CHECK(got && memcmp(got, disk1_track5, sizeof disk1_track5) == 0,
          "sanity: the cached copy must actually be disk1's bytes");

    psram_publish_slot(SLOT_NONE); // explicit eject

    // Fetch disk2 into the slot the eject freed -- slot 0 again.
    int target = psram_inactive_slot();
    CHECK_EQ_INT(target, 0);
    psram_image_reset_slot(target);
    write_track(target, 5, 0x55);
    psram_publish_slot(target);

    got = track_cache_get(5, &bits);
    CHECK(got != NULL, "disk2's track 5 must be servable once mounted");
    CHECK(got && memcmp(got, disk2_track7, sizeof disk2_track7) == 0,
          "track_cache_get must serve DISK2's bytes (0x55), not a stale "
          "SRAM copy left over from disk1's identically-numbered slot");
}

// Realisation 2 (three disks, no eject): disk1 -> slot 0 (cache its track
// 5), disk2 -> slot 1 (cache a DIFFERENT track, so the other SRAM buffer
// half also ends up holding a slot-0-tagged entry from disk1), disk3 ->
// slot 0 again (slots alternate with no eject in between). A stale
// bare-slot tag on the buffer that still says "slot 0, track 5" would
// serve disk1's bytes for disk3, even though disk3 -- not disk1 -- is what
// slot 0 now holds.
static void test_three_disks_no_eject_does_not_serve_stale_track(void) {
    memset(disk1_track5, 0x11, sizeof disk1_track5);
    memset(disk2_track7, 0x22, sizeof disk2_track7);
    memset(disk3_track5, 0x33, sizeof disk3_track5);

    track_cache_init();

    // disk1 -> slot 0
    psram_image_reset_slot(0);
    write_track(0, 5, 0x11);
    psram_publish_slot(0);
    uint32_t bits = 0;
    const uint8_t *got = track_cache_get(5, &bits); // caches {track 5, slot 0} in one buffer half
    CHECK(got && memcmp(got, disk1_track5, sizeof disk1_track5) == 0,
          "sanity: disk1's track 5 must read back as written");

    // disk2 -> slot 1 (the inactive slot while slot 0 is active)
    int target = psram_inactive_slot();
    CHECK_EQ_INT(target, 1);
    psram_image_reset_slot(target);
    write_track(target, 7, 0x22);
    psram_publish_slot(target);
    got = track_cache_get(7, &bits); // caches {track 7, slot 1} in the other buffer half
    CHECK(got && memcmp(got, disk2_track7, sizeof disk2_track7) == 0,
          "sanity: disk2's track 7 must read back as written");

    // disk3 -> slot 0 again (no eject in between)
    target = psram_inactive_slot();
    CHECK_EQ_INT(target, 0);
    psram_image_reset_slot(target);
    write_track(target, 5, 0x33);
    psram_publish_slot(target);

    got = track_cache_get(5, &bits);
    CHECK(got != NULL, "disk3's track 5 must be servable once mounted");
    CHECK(got && memcmp(got, disk3_track5, sizeof disk3_track5) == 0,
          "track_cache_get must serve DISK3's bytes (0x33), not the stale "
          "SRAM copy cached under slot 0's earlier occupant, disk1 (0x11)");
}

int main(void) {
    size_t len = (size_t)TRACK_MAX_BYTES * NUM_TRACKS * SLOT_COUNT;
    void *mem = malloc(len);
    psram_image_set_backing(mem, len);
    RUN(test_eject_then_refetch_does_not_serve_stale_track);
    RUN(test_three_disks_no_eject_does_not_serve_stale_track);
    free(mem);
    return REPORT();
}
