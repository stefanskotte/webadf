#include "harness.h"
#include "../src/psram_image.h"
#include <stdlib.h>
#include <string.h>

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

    // Review round 1, Minor 2: the checks above only exercise per-slot
    // METADATA (have/active-slot) -- they would still pass even if
    // track_ptr() ignored `slot` and both slots physically aliased the
    // same PSRAM bytes. Prove the two slots are backed by genuinely
    // separate storage: write and commit DIFFERENT bytes to the SAME
    // track number in each slot and confirm they read back different.
    uint8_t a[64], b[64];
    memset(a, 0xAA, sizeof a);
    memset(b, 0x55, sizeof b);
    psram_image_write_at(0, 3, 0, a, 64);
    psram_image_commit(0, 3, 512);
    psram_image_write_at(1, 3, 0, b, 64);
    psram_image_commit(1, 3, 512);

    uint8_t ra[64], rb[64];
    uint32_t bits;
    CHECK(psram_image_read(0, 3, ra, &bits), "slot 0 track 3 should read back");
    CHECK(psram_image_read(1, 3, rb, &bits), "slot 1 track 3 should read back");
    CHECK(memcmp(ra, rb, 64) != 0,
          "slot 0 and slot 1 must be backed by separate storage, not aliases");
}

static void test_eject_publishes_slot_none(void) {
    psram_publish_slot(0);
    psram_publish_slot(SLOT_NONE);
    CHECK_EQ_INT(psram_active_slot(), SLOT_NONE);
}

static void set_dirty_and_discard(void) {
    psram_image_reset_slot(0);
    uint8_t buf[16] = {1, 2, 3};
    psram_image_write_at(0, 5, 0, buf, sizeof buf);
    psram_image_commit(0, 5, 128);
    psram_image_set_dirty(0, 7);                          // ABSENT: refused
    CHECK_EQ_INT(psram_image_state(0, 7), TRK_ABSENT);
    psram_image_set_dirty(0, 5);
    CHECK_EQ_INT(psram_image_state(0, 5), TRK_DIRTY);
    CHECK_EQ_INT(psram_image_dirty_count(0), 1);
    uint8_t got[16]; uint32_t bits = 0;
    CHECK(psram_image_read(0, 5, got, &bits), "payload still there");
    CHECK(memcmp(got, buf, sizeof buf) == 0, "set_dirty never touches the payload");
    psram_image_discard_dirty(0);
    CHECK_EQ_INT(psram_image_state(0, 5), TRK_PRESENT);
    CHECK_EQ_INT(psram_image_dirty_count(0), 0);
}

static void df1_never_shares_a_slot_with_df0(void) {
    psram_publish_slot(0);
    CHECK(!psram_publish_df1(0), "DF0's slot is refused");
    CHECK(psram_publish_df1(1), "the idle slot is fine");
    CHECK_EQ_INT(psram_df1_slot(), 1);
    psram_publish_slot(1);   // "Next disk": DF0 takes the preloaded slot
    CHECK_EQ_INT(psram_df1_slot(), SLOT_NONE);   // ejected in the same publish
}

static void df1_holds_a_disk_only_while_df0_does(void) {
    psram_publish_slot(0);
    psram_publish_df1(1);
    psram_publish_slot(SLOT_NONE);
    CHECK_EQ_INT(psram_df1_slot(), SLOT_NONE);
    CHECK(!psram_publish_df1(1), "DF0 empty: DF1 may not hold an A/B slot (Next disk's rule)");
}

// Review Focus 1: core1 writes into a slot only once core0 has stopped reading it.
static void the_writer_waits_for_core0_to_acknowledge_df1s_eject(void) {
    psram_publish_slot(0);
    psram_publish_df1(1);
    psram_df1_reader_ack(psram_df1_token());
    CHECK(psram_df1_quiescent(), "acked");
    psram_publish_df1(SLOT_NONE);
    CHECK(!psram_df1_quiescent(), "the eject is not yet seen by core0");
    psram_df1_reader_ack(psram_df1_token());
    CHECK(psram_df1_quiescent(), "now it is");
}

static void df1_tokens_never_repeat_a_df0_token(void) {
    psram_publish_slot(0);
    int32_t a = psram_active_token();
    psram_publish_df1(1);
    CHECK(psram_df1_token() != a, "one generation counter for both words");
}

static void an_empty_df1_is_untouched_by_df0_publishes(void) {
    psram_publish_slot(0);
    psram_publish_df1(SLOT_NONE);
    int32_t w = psram_df1_token();
    psram_publish_slot(1);
    psram_publish_slot(SLOT_NONE);
    CHECK(psram_df1_token() == w, "no DF1 word change when DF1 is empty");
}

// Phase 3 (plan 2026-10-12 ruling 6): Network mode's DF1 slot needs no DF0 disk and no DF0 slot.
static void the_net_slot_is_df1s_whatever_df0_holds(void) {
    psram_publish_slot(SLOT_NONE);
    CHECK(psram_publish_df1(SLOT_NET), "DF0 empty: DF1 may hold the driver disk");
    CHECK_EQ_INT(psram_df1_slot(), SLOT_NET);
    psram_publish_slot(0);
    CHECK_EQ_INT(psram_df1_slot(), SLOT_NET);   // a DF0 mount leaves it
    psram_publish_slot(1);
    CHECK_EQ_INT(psram_df1_slot(), SLOT_NET);   // and a DF0 swap
    psram_publish_slot(SLOT_NONE);
    CHECK_EQ_INT(psram_df1_slot(), SLOT_NET);   // and a DF0 eject (pre-flight B1)
    CHECK(psram_inactive_slot() == 0 || psram_inactive_slot() == 1, "DF0's fetch target is never SLOT_NET");
    psram_publish_slot(SLOT_NET);
    CHECK(psram_active_slot() != SLOT_NET, "DF0 can never publish SLOT_NET");
    psram_publish_df1(SLOT_NONE);
}

static void tokens_name_all_three_slots_apart(void) {
    psram_publish_slot(0);  const int32_t a = psram_active_token();
    psram_publish_slot(1);  const int32_t b = psram_active_token();
    psram_publish_df1(SLOT_NET); const int32_t n = psram_df1_token();
    CHECK_EQ_INT(psram_token_slot(a), 0);
    CHECK_EQ_INT(psram_token_slot(b), 1);
    CHECK_EQ_INT(psram_token_slot(n), SLOT_NET);
    CHECK(a != b && b != n && a != n, "distinct");
    psram_publish_df1(SLOT_NONE);
    CHECK_EQ_INT(psram_token_slot(psram_df1_token()), SLOT_NONE);
}

static void the_net_slot_holds_dd_sectors_only(void) {
    psram_image_reset_slot(SLOT_NET);
    psram_image_set_slot_kind(SLOT_NET, SLOT_KIND_ADF_DD);
    static uint8_t sec[NET_TRACK_BYTES];
    for (unsigned i = 0; i < sizeof sec; i++) sec[i] = (uint8_t)(i * 13u);
    CHECK(psram_image_store_adf(SLOT_NET, 155, sec), "a DD track of sectors is stored");
    CHECK(memcmp(psram_image_track_data(SLOT_NET, 155), sec, sizeof sec) == 0, "read back");
    CHECK_EQ_INT(psram_image_bits(SLOT_NET, 155), NET_TRACK_BYTES * 8u);
    static uint8_t mfm[16] = {0};
    psram_image_mark_dirty(SLOT_NET, 3, mfm, 128);
    CHECK(!psram_image_have(SLOT_NET, 3), "MFM never goes into a sector slot");
}

int main(void) {
    size_t len = (size_t)TRACK_MAX_BYTES * NUM_TRACKS * SLOT_COUNT;
    void *mem = malloc(len);
    psram_image_set_backing(mem, len);
    psram_image_init();     // pre-flight I1: SLOT_NET's storage is set up here
    RUN(test_written_track_reads_back);
    RUN(test_fetch_targets_the_inactive_slot);
    RUN(test_publish_is_all_or_nothing);
    RUN(test_eject_publishes_slot_none);
    RUN(set_dirty_and_discard);
    RUN(df1_never_shares_a_slot_with_df0);
    RUN(df1_holds_a_disk_only_while_df0_does);
    RUN(the_writer_waits_for_core0_to_acknowledge_df1s_eject);
    RUN(df1_tokens_never_repeat_a_df0_token);
    RUN(an_empty_df1_is_untouched_by_df0_publishes);
    RUN(the_net_slot_is_df1s_whatever_df0_holds);
    RUN(tokens_name_all_three_slots_apart);
    RUN(the_net_slot_holds_dd_sectors_only);
    free(mem);
    return REPORT();
}
