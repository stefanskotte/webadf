#include "harness.h"
#include "../src/drive_store.h"
#include "../src/psram_image.h"
#include <string.h>

static void nothing_stored_boots_with_the_compiled_default(void) {
    drive_store_erase();
    drive_record_t r;
    CHECK(!drive_store_load(&r), "erased: nothing");
    CHECK_EQ_INT(drive_boot_mode(false, NULL), WF_DF1_DEFAULT);
}

static void a_stored_mode_round_trips_and_wins_over_the_default(void) {
    drive_store_erase();
    drive_record_t a = { 7, DF1_MODE_NEXT }, b;
    CHECK(drive_store_save(&a), "saved");
    CHECK(drive_store_load(&b), "loaded");
    CHECK_EQ_INT(b.version, 7);
    CHECK_EQ_INT(drive_boot_mode(true, &b), DF1_MODE_NEXT);
}

static void an_out_of_range_mode_boots_off(void) {
    drive_record_t r = { 3, 9 };
    CHECK_EQ_INT(drive_boot_mode(true, &r), DF1_MODE_OFF);   // never guess "on"
}

static void a_corrupt_record_does_not_load(void) {
    drive_store_erase();
    drive_record_t a = { 5, DF1_MODE_NEXT }, b;
    drive_store_save(&a);
    drive_store_corrupt_for_test();
    CHECK(!drive_store_load(&b), "a bit flip fails the CRC");
}

static void writes_wait_for_an_empty_drive(void) {
    CHECK(drive_store_should_write(true, true), "pending + empty: write");
    CHECK(!drive_store_should_write(true, false), "a disk is in: wait");
    CHECK(!drive_store_should_write(false, true), "nothing pending");
}

int main(void) {
    static uint8_t backing[2 * 160 * 14336];
    psram_image_set_backing(backing, sizeof backing);
    psram_image_init();
    RUN(nothing_stored_boots_with_the_compiled_default);
    RUN(a_stored_mode_round_trips_and_wins_over_the_default);
    RUN(an_out_of_range_mode_boots_off);
    RUN(a_corrupt_record_does_not_load);
    RUN(writes_wait_for_an_empty_drive);
    return REPORT();
}
