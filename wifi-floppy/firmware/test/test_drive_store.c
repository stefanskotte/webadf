#include "harness.h"
#include "../src/drive_store.h"
#include "../src/psram_image.h"
#include "../src/swap_gate.h"
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
    CHECK(drive_store_should_write(true, true, false), "pending + empty: write");
    CHECK(!drive_store_should_write(true, false, false), "a disk is in and the Amiga is busy: wait");
    CHECK(!drive_store_should_write(false, true, false), "nothing pending");
}

// R17 / final review C1: a board powered by the Amiga always holds a disk, so
// the record must also be written while the Amiga is idle with a disk mounted.
static void writes_while_idle_with_a_disk_mounted(void) {
    const uint32_t now = 100000u, quiet = now - SWAP_IDLE_MS, busy = now - SWAP_IDLE_MS + 1u;
    const bool idle = drive_store_idle(now, false, false, quiet, false);
    CHECK(idle, "motor off, WGATE clear, quiet for SWAP_IDLE_MS, nothing unsent: idle");
    CHECK(drive_store_should_write(true, false, idle), "pending + idle with a disk mounted: write");
    CHECK(!drive_store_should_write(false, false, idle), "nothing pending: no write");
    CHECK(!drive_store_should_write(false, true, true), "nothing pending, empty and idle: no write");

    // pending + motor on -> wait, however long it has been on (no forced store).
    CHECK(!drive_store_should_write(true, false, drive_store_idle(now, true, false, quiet, false)),
          "pending + motor on: wait");
    CHECK(!drive_store_idle(now, true, false, now - 10u * SWAP_FORCE_MS, false),
          "a motor on all session (trackloader) is never forced past");
    // pending + unsent writes -> wait.
    CHECK(!drive_store_should_write(true, false, drive_store_idle(now, false, false, quiet, true)),
          "pending + unsent captured writes: wait");
    // activity inside the settle window -> wait.
    CHECK(!drive_store_idle(now, false, false, busy, false), "a write/WGATE edge/motor 2999 ms ago: wait");
    CHECK(!drive_store_idle(now, false, true, quiet, false), "WGATE asserted: wait");
    CHECK(drive_store_idle(now, false, true, now - SWAP_FORCE_MS, false),
          "WGATE stuck asserted with the motor off for SWAP_FORCE_MS (a powered-off Amiga): idle");
    // wraparound.
    CHECK(drive_store_idle(5u, false, false, 0xFFFFFFFFu - SWAP_IDLE_MS + 6u, false), "wraparound");
}

static void the_save_itself_does_not_refuse_a_mounted_disk(void) {
    drive_store_erase();
    psram_publish_slot(0);
    drive_record_t a = { 9, DF1_MODE_OFF }, b;
    CHECK(drive_store_save(&a), "saved with DF0 mounted (the caller decides when)");
    CHECK(drive_store_load(&b), "loaded");
    CHECK_EQ_INT(b.version, 9);
    CHECK_EQ_INT(drive_boot_mode(true, &b), DF1_MODE_OFF);
    psram_publish_slot(SLOT_NONE);
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
    RUN(writes_while_idle_with_a_disk_mounted);
    RUN(the_save_itself_does_not_refuse_a_mounted_disk);
    return REPORT();
}
