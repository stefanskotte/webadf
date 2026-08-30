#include "harness.h"
#include "../src/config_store.h"
#include "../src/psram_image.h"
#include "../src/token_store.h"
#include <stdlib.h>
#include <string.h>

static device_config_t mk(const char *s, const char *p, const char *c) {
    device_config_t cfg;
    memset(&cfg, 0, sizeof cfg);
    snprintf(cfg.ssid, sizeof cfg.ssid, "%s", s);
    snprintf(cfg.pass, sizeof cfg.pass, "%s", p);
    snprintf(cfg.code, sizeof cfg.code, "%s", c);
    return cfg;
}

static void test_round_trips(void) {
    config_store_erase();
    device_config_t out;
    CHECK(!config_store_load(&out), "nothing stored initially");

    device_config_t in = mk("my-network", "hunter2hunter2", "ABC123");
    CHECK(config_store_save(&in), "save");
    CHECK(config_store_load(&out), "load");
    CHECK(strcmp(out.ssid, "my-network") == 0, "ssid");
    CHECK(strcmp(out.pass, "hunter2hunter2") == 0, "pass");
    CHECK(strcmp(out.code, "ABC123") == 0, "code");
}

// Task 1 review round 1 (Important): a torn write isn't one failure shape.
// Flash programs a page front-to-back, so what's left over when power is
// lost depends on how far the write got. These two tests pin the two
// shapes that matter, each isolating a different defence -- see
// config_store.h's comments on the two simulate_torn_write_* helpers.

static void test_torn_write_during_magic_is_rejected(void) {
    // Only the first two of the magic word's four bytes made it out; the
    // rest of the page, including the whole payload, is still erased.
    // Must be rejected by the MAGIC check, before the CRC is ever
    // consulted (the CRC's own field is itself still 0xFF here).
    config_store_erase();
    config_store_test_simulate_torn_write_during_magic();
    device_config_t out;
    CHECK(!config_store_load(&out),
          "a magic word interrupted mid-write must be rejected by the magic check");
}

static void test_torn_write_after_magic_is_rejected(void) {
    // The magic word (and the header behind it) finished landing intact,
    // but the payload that follows did not. The magic and length checks
    // all pass here -- only the CRC can catch this.
    config_store_erase();
    device_config_t in = mk("net", "password", "ABC123");
    CHECK(config_store_save(&in), "save");
    config_store_test_simulate_torn_write_after_magic();
    device_config_t out;
    CHECK(!config_store_load(&out),
          "an incomplete payload behind a valid magic must be rejected by the CRC");
}

static void test_crc_mismatch_is_rejected(void) {
    // The whole reason config_store carries a CRC that token_store does not:
    // a write that completed the magic but corrupted the payload.
    config_store_erase();
    device_config_t in = mk("net", "password", "ABC123");
    CHECK(config_store_save(&in), "save");
    config_store_test_corrupt_payload_byte();
    device_config_t out;
    CHECK(!config_store_load(&out), "a payload corruption must be caught by the CRC");
}

static void test_max_length_ssid_is_accepted(void) {
    // Named for what it actually asserts. Rejecting an OVER-length field is
    // portal_http's job (Task 5) -- by the time a device_config_t exists the
    // fields are fixed arrays and cannot be over-length. What this pins is
    // the boundary: exactly CONFIG_SSID_MAX must still round-trip.
    config_store_erase();
    device_config_t in;
    memset(&in, 0, sizeof in);
    memset(in.ssid, 'x', CONFIG_SSID_MAX);
    snprintf(in.pass, sizeof in.pass, "password");
    snprintf(in.code, sizeof in.code, "ABC123");
    CHECK(config_store_save(&in), "a max-length ssid is acceptable");
    device_config_t out;
    CHECK(config_store_load(&out), "and loads back");
    CHECK_EQ_INT((int)strlen(out.ssid), CONFIG_SSID_MAX);
}

static void test_save_refuses_while_a_disk_is_mounted(void) {
    config_store_erase();
    psram_publish_slot(0);
    device_config_t in = mk("net", "password", "ABC123");
    CHECK(!config_store_save(&in), "no flash write while a disk is streaming");
    psram_publish_slot(SLOT_NONE);
}

static void test_erase_also_erases_the_token(void) {
    // Re-pairing issues a new device row and a new token; keeping the old
    // one would leave the board authenticating as a device the server no
    // longer associates with these credentials.
    CHECK(token_store_save("tok-old"), "seed a token");
    config_store_erase();
    char buf[128];
    CHECK(!token_store_load(buf, sizeof buf), "token must be gone after config erase");
}

int main(void) {
    size_t len = (size_t)TRACK_MAX_BYTES * NUM_TRACKS * SLOT_COUNT;
    void *mem = malloc(len);
    psram_image_set_backing(mem, len);
    RUN(test_round_trips);
    RUN(test_torn_write_during_magic_is_rejected);
    RUN(test_torn_write_after_magic_is_rejected);
    RUN(test_crc_mismatch_is_rejected);
    RUN(test_max_length_ssid_is_accepted);
    RUN(test_save_refuses_while_a_disk_is_mounted);
    RUN(test_erase_also_erases_the_token);
    free(mem);
    return REPORT();
}
