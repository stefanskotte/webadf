#include "harness.h"
#include "../src/psram_image.h"
#include <stdlib.h>

static void test_written_track_reads_back(void) {
    uint8_t src[64];
    for (int i = 0; i < 64; i++) src[i] = (uint8_t)i;
    psram_image_write_at(0, 5, 0, src, 64);
    psram_image_commit(0, 5, 512);

    CHECK(psram_image_have(0, 5), "track 5 should be present after commit");
    CHECK_EQ_INT(psram_image_bits(0, 5), 512);

    uint8_t dst[64] = {0};
    uint32_t bits = 0;
    CHECK(psram_image_read(0, 5, dst, &bits), "read should succeed");
    CHECK_EQ_INT(bits, 512);
    CHECK(memcmp(src, dst, 64) == 0, "bytes should round-trip");

    CHECK(!psram_image_have(0, 6), "an uncommitted track must not read as present");
}

// Task 8: fetching always targets the slot that is NOT currently active, so
// a fetch never touches the disk the Amiga is playing.
static void test_fetch_targets_the_inactive_slot(void) {
    psram_publish_slot(0);
    CHECK_EQ_INT(psram_inactive_slot(), 1);
    psram_publish_slot(1);
    CHECK_EQ_INT(psram_inactive_slot(), 0);
}

static void test_publish_is_all_or_nothing(void) {
    // Core0 must never see a half-filled slot. Writing tracks into the
    // inactive slot must not change what active reads.
    psram_publish_slot(0);
    psram_image_reset_slot(1);
    uint8_t src[64] = {7};
    psram_image_write_at(1, 3, 0, src, 64);
    psram_image_commit(1, 3, 512);
    CHECK_EQ_INT(psram_active_slot(), 0);
    CHECK(!psram_image_have(psram_active_slot(), 3),
          "the active slot must be unaffected by a fetch into the other");
}

static void test_eject_publishes_slot_none(void) {
    psram_publish_slot(0);
    psram_publish_slot(SLOT_NONE);
    CHECK_EQ_INT(psram_active_slot(), SLOT_NONE);
}

int main(void) {
    size_t len = (size_t)TRACK_MAX_BYTES * NUM_TRACKS * SLOT_COUNT;
    void *mem = malloc(len);
    psram_image_set_backing(mem, len);
    RUN(test_written_track_reads_back);
    RUN(test_fetch_targets_the_inactive_slot);
    RUN(test_publish_is_all_or_nothing);
    RUN(test_eject_publishes_slot_none);
    free(mem);
    return REPORT();
}
