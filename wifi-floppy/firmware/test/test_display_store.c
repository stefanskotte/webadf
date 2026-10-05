#include "harness.h"
#include "../src/display_store.h"
#include "../src/psram_image.h"
#include <stdlib.h>
#include <string.h>

// The host buffer persists across tests in this process, so every test that
// needs a known store state sets it up itself (erase first); none relies on
// the order the others ran in.

static display_record_t rec(uint32_t v) {
    display_record_t r; memset(&r, 0, sizeof r);
    r.version = v; r.panel = 1; r.has_layout = 1; r.blob_len = 4;
    r.blob[0] = 1; r.blob[1] = 1; r.blob[2] = 0; r.blob[3] = 0;
    return r;
}

static void test_nothing_stored_loads_false(void) {
    display_store_erase();
    display_record_t r; CHECK(!display_store_load(&r), "erased: nothing");
}

static void test_round_trip(void) {
    display_store_erase();
    display_record_t a = rec(7), b;
    CHECK(display_store_save(&a), "saved");
    CHECK(display_store_load(&b), "loaded");
    CHECK(memcmp(&a, &b, sizeof a) == 0, "identical");
}

static void test_max_blob_round_trips(void) {
    display_store_erase();
    display_record_t a = rec(3), b;
    a.blob_len = LAYOUT_BLOB_MAX;
    for (int i = 0; i < LAYOUT_BLOB_MAX; i++) a.blob[i] = (uint8_t)(i * 7 + 1);
    CHECK(display_store_save(&a), "max blob saved");
    CHECK(display_store_load(&b), "max blob loaded");
    CHECK(memcmp(&a, &b, sizeof a) == 0, "identical");
}

static void test_oversize_blob_refused(void) {
    display_store_erase();
    display_record_t a = rec(3), b;
    a.blob_len = LAYOUT_BLOB_MAX + 1;
    CHECK(!display_store_save(&a), "blob_len beyond the maximum: refused");
    CHECK(!display_store_load(&b), "and nothing was stored");
}

static void test_store_write_waits_for_an_empty_drive(void) {
    CHECK(!display_store_should_write(true, true), "pending but mounted: wait");
    CHECK(display_store_should_write(true, false), "pending and empty: write");
    CHECK(!display_store_should_write(false, false), "nothing pending: no write");
    CHECK(!display_store_should_write(false, true), "nothing pending, mounted: no write");
}

static void test_save_refuses_while_a_disk_is_mounted(void) {
    display_store_erase();
    psram_publish_slot(0);
    display_record_t a = rec(4), b;
    CHECK(!display_store_save(&a), "no flash write while a disk is streaming");
    psram_publish_slot(SLOT_NONE);
    CHECK(!display_store_load(&b), "nothing was stored");
}

static void test_reboot_before_write_refetches(void) {
    // v5 saved; v6 applied from RAM while mounted, never written; reboot.
    display_store_erase();
    display_record_t v5 = rec(5), after;
    CHECK(display_store_save(&v5), "v5 stored");
    CHECK(display_store_load(&after) && after.version == 5, "after reboot the ack is 5, so v6 is fetched again");
}

static void test_a_damaged_record_is_not_trusted(void) {
    display_store_erase();
    display_record_t a = rec(9), b;
    CHECK(display_store_save(&a), "saved");
    display_store_corrupt_for_test();      // flips one payload byte in the host buffer
    CHECK(!display_store_load(&b), "bad CRC: not trusted");
}

int main(void) {
    size_t len = (size_t)TRACK_MAX_BYTES * NUM_TRACKS * SLOT_COUNT;
    void *mem = malloc(len);
    psram_image_set_backing(mem, len);
    RUN(test_nothing_stored_loads_false);
    RUN(test_round_trip);
    RUN(test_max_blob_round_trips);
    RUN(test_oversize_blob_refused);
    RUN(test_store_write_waits_for_an_empty_drive);
    RUN(test_save_refuses_while_a_disk_is_mounted);
    RUN(test_reboot_before_write_refetches);
    RUN(test_a_damaged_record_is_not_trusted);
    return REPORT();
}
