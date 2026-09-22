#include "harness.h"
#include "../src/fw_state.h"
#include "../src/psram_image.h"
#include <string.h>
#include <stdlib.h>

static fw_state_t sample(void) {
    fw_state_t s;
    memset(&s, 0, sizeof s);
    s.installed_sequence = 3;
    s.pending = true;
    s.pending_sequence = 4;
    snprintf(s.pending_version, sizeof s.pending_version, "%s", "1.1.0+gabc1234");
    snprintf(s.failure, sizeof s.failure, "%s", "no heartbeat within 5 minutes");
    return s;
}

static void test_round_trip(void) {
    fw_state_test_erase();
    fw_state_t in = sample(), out;
    CHECK(fw_state_save(&in), "save");
    CHECK(fw_state_load(&out), "load");
    CHECK_EQ_INT(out.installed_sequence, 3);
    CHECK(out.pending, "pending survives");
    CHECK_EQ_INT(out.pending_sequence, 4);
    CHECK(strcmp(out.pending_version, "1.1.0+gabc1234") == 0, "version survives");
    CHECK(strcmp(out.failure, "no heartbeat within 5 minutes") == 0, "failure survives");
}

// An erased sector is the state of every board before its first update: it must read as
// "nothing recorded" (all zero), never as garbage a caller could act on.
static void test_erased_sector_reads_as_zero(void) {
    fw_state_test_erase();
    fw_state_t out;
    memset(&out, 0x5a, sizeof out);
    CHECK(!fw_state_load(&out), "an erased sector holds no record");
    CHECK_EQ_INT(out.installed_sequence, 0);
    CHECK(!out.pending, "and nothing pending");
    CHECK(out.pending_version[0] == '\0', "and no version");
}

static void test_one_flipped_byte_is_rejected(void) {
    fw_state_test_erase();
    fw_state_t in = sample(), out;
    CHECK(fw_state_save(&in), "save");
    fw_state_test_raw()[20] ^= 0x01;           // inside pending_version
    CHECK(!fw_state_load(&out), "the CRC must catch a flipped payload byte");
    CHECK_EQ_INT(out.installed_sequence, 0);
}

static void test_bad_magic_is_rejected(void) {
    fw_state_test_erase();
    fw_state_t in = sample(), out;
    CHECK(fw_state_save(&in), "save");
    fw_state_test_raw()[0] ^= 0xff;
    CHECK(!fw_state_load(&out), "a wrong magic is not a record");
}

// Anti-rollback rests on installed_sequence. A version string with no terminator must be
// refused at encode time rather than written as a record that decodes to something else.
static void test_unterminated_version_is_refused(void) {
    fw_state_t s = sample();
    memset(s.pending_version, 'v', sizeof s.pending_version);   // no NUL anywhere
    uint8_t rec[FW_STATE_RECORD_BYTES];
    CHECK(!fw_state_encode(&s, rec), "an unterminated version must not encode");
}

// Same guard as config_store/token_store: a flash write parks core0, which the Amiga would
// see as a drive that stops answering mid-read.
static void test_save_refuses_while_a_disk_is_mounted(void) {
    fw_state_test_erase();
    psram_publish_slot(0);
    fw_state_t in = sample();
    CHECK(!fw_state_save(&in), "no flash write with a disk mounted");
    psram_publish_slot(SLOT_NONE);
}

int main(void) {
    psram_image_init();
    size_t len = (size_t)TRACK_MAX_BYTES * NUM_TRACKS * SLOT_COUNT;
    void *mem = malloc(len);
    psram_image_set_backing(mem, len);

    RUN(test_round_trip);
    RUN(test_erased_sector_reads_as_zero);
    RUN(test_one_flipped_byte_is_rejected);
    RUN(test_bad_magic_is_rejected);
    RUN(test_unterminated_version_is_refused);
    RUN(test_save_refuses_while_a_disk_is_mounted);
    return REPORT();
}
