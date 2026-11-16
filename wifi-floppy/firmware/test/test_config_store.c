#include "harness.h"
#include "../src/config_store.h"
#include "../src/psram_image.h"
#include "../src/token_store.h"
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static device_config_t mk(const char *s, const char *p, const char *c) {
    device_config_t cfg;
    memset(&cfg, 0, sizeof cfg);
    snprintf(cfg.net[0].ssid, sizeof cfg.net[0].ssid, "%s", s);
    snprintf(cfg.net[0].pass, sizeof cfg.net[0].pass, "%s", p);
    cfg.n_nets = 1;
    cfg.last = 0;
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
    CHECK(strcmp(out.net[0].ssid, "my-network") == 0, "ssid");
    CHECK(strcmp(out.net[0].pass, "hunter2hunter2") == 0, "pass");
    CHECK(strcmp(out.code, "ABC123") == 0, "code");
}

// Task 1 review round 1 (Important): a torn write isn't one failure shape.
// Flash programs a page front-to-back, so what's left over when power is
// lost depends on how far the write got. These two tests model the two
// shapes that matter -- see config_store.h's comments on the two
// simulate_torn_write_* helpers.
//
// Review round 2: "during magic" below is a real interrupted write and is
// correctly rejected, but NOT solely by the magic check -- the version
// byte is also 0xFF there, so the version check independently rejects it
// too (proven by mutation: deleting only the magic comparison still left
// this test passing, because the version check caught it instead). That
// is correct defence-in-depth for an actual torn write, not a bug, but it
// means this test does not pin the magic check in isolation.
// test_corrupt_magic_is_rejected below is the one that does.

static void test_torn_write_during_magic_is_rejected(void) {
    // Only the first two of the magic word's four bytes made it out; the
    // rest of the page -- including the version byte, the whole payload,
    // and the crc field -- is still erased. Rejected by the magic check
    // in the current code (it runs first); the version check would also
    // reject it if the magic check were ever removed, since the version
    // byte is 0xFF here too. Several gates independently catching an
    // interrupted write is the intended defence-in-depth, not a weakness
    // -- see test_corrupt_magic_is_rejected for the test that isolates
    // the magic check specifically.
    config_store_erase();
    config_store_test_simulate_torn_write_during_magic();
    device_config_t out;
    CHECK(!config_store_load(&out),
          "a magic word interrupted mid-write must be rejected");
}

static void test_torn_write_after_magic_is_rejected(void) {
    // The magic word (and the header behind it) finished landing intact,
    // but the payload that follows did not. The magic and length checks
    // all pass here -- only the CRC can catch this. (Mutation-verified:
    // deleting the CRC comparison alone makes this fail.)
    config_store_erase();
    device_config_t in = mk("net", "password", "ABC123");
    CHECK(config_store_save(&in), "save");
    config_store_test_simulate_torn_write_after_magic();
    device_config_t out;
    CHECK(!config_store_load(&out),
          "an incomplete payload behind a valid magic must be rejected by the CRC");
}

static void test_corrupt_magic_is_rejected(void) {
    // Task 1 review round 2 (Important): a fully valid, self-consistent
    // record -- version, lengths, payload, and CRC all correct and
    // mutually consistent -- with ONLY the magic word wrong. Unlike the
    // torn-write-during-magic case above, nothing else here is amiss, so
    // this is the test that isolates the magic comparison: it must fail
    // if-and-only-if the magic comparison itself is deleted, since every
    // other gate (version, length bounds, CRC) would pass this record.
    config_store_erase();
    device_config_t in = mk("net", "password", "ABC123");
    CHECK(config_store_save(&in), "save");
    config_store_test_corrupt_magic();
    device_config_t out;
    CHECK(!config_store_load(&out),
          "a corrupted magic word must be rejected by the magic check, "
          "even when everything else about the record is valid");
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
    device_config_t in = mk("", "password", "ABC123");
    memset(in.net[0].ssid, 'x', CONFIG_SSID_MAX);
    CHECK(config_store_save(&in), "a max-length ssid is acceptable");
    device_config_t out;
    CHECK(config_store_load(&out), "and loads back");
    CHECK_EQ_INT((int)strlen(out.net[0].ssid), CONFIG_SSID_MAX);
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

// --- Several networks (2026-11-15) ---
//
// The single-network record every board in the field holds, built here byte
// for byte from the layout the older firmware wrote (config_store.c before
// 2026-11-15) with this file's own CRC -- not through config_store.c, so a
// change to the store's encoder cannot make this test agree with itself.
static uint32_t ref_crc32(const unsigned char *d, size_t n) {
    uint32_t c = 0xFFFFFFFFu;
    for (size_t i = 0; i < n; i++) {
        c ^= d[i];
        for (int k = 0; k < 8; k++) c = (c >> 1) ^ (0xEDB88320u & (0u - (c & 1u)));
    }
    return ~c;
}

static int old_layout(unsigned char *page, const char *ssid, const char *pass, const char *code) {
    memset(page, 0xFF, 256);
    size_t sl = strlen(ssid), pl = strlen(pass), cl = strlen(code);
    page[0] = 'G'; page[1] = 'C'; page[2] = 'F'; page[3] = 'W';   // 0x57464347 little-endian
    page[4] = 1;                                                 // version 1
    page[5] = (unsigned char)sl; page[6] = (unsigned char)pl; page[7] = (unsigned char)cl;
    memcpy(page + 8, ssid, sl);
    memcpy(page + 8 + sl, pass, pl);
    memcpy(page + 8 + sl + pl, code, cl);
    uint32_t crc = ref_crc32(page + 4, 4 + sl + pl + cl);
    unsigned char *c = page + 8 + sl + pl + cl;
    c[0] = (unsigned char)crc; c[1] = (unsigned char)(crc >> 8);
    c[2] = (unsigned char)(crc >> 16); c[3] = (unsigned char)(crc >> 24);
    return 256;
}

// What an older firmware reads: page 0 only, by the old rules. Returns false
// if it would find nothing (and so open setup and, on submit, re-pair).
static bool old_reader(const unsigned char *page, char *ssid, char *pass, char *code) {
    if (!(page[0] == 'G' && page[1] == 'C' && page[2] == 'F' && page[3] == 'W' && page[4] == 1)) return false;
    size_t sl = page[5], pl = page[6], cl = page[7];
    if (sl > 32 || pl > 63 || cl > 16) return false;
    const unsigned char *c = page + 8 + sl + pl + cl;
    uint32_t want = (uint32_t)c[0] | (uint32_t)c[1] << 8 | (uint32_t)c[2] << 16 | (uint32_t)c[3] << 24;
    if (ref_crc32(page + 4, 4 + sl + pl + cl) != want) return false;
    memcpy(ssid, page + 8, sl); ssid[sl] = '\0';
    memcpy(pass, page + 8 + sl, pl); pass[pl] = '\0';
    memcpy(code, page + 8 + sl + pl, cl); code[cl] = '\0';
    return true;
}

static void test_an_old_single_network_record_loads_unchanged(void) {
    unsigned char page[256];
    old_layout(page, "HomeNet", "hunter2hunter2", "ABC123");
    config_store_test_write_raw(page, sizeof page);
    CHECK(token_store_save("tok-field"), "the board's token, in its own sector");
    device_config_t out;
    CHECK(config_store_load(&out), "the field layout still loads after the update");
    CHECK_EQ_INT(out.n_nets, 1);
    CHECK_EQ_INT(out.last, 0);
    CHECK(strcmp(out.net[0].ssid, "HomeNet") == 0, "its network");
    CHECK(strcmp(out.net[0].pass, "hunter2hunter2") == 0, "its password");
    CHECK(strcmp(out.code, "ABC123") == 0, "its pairing code");
    char tok[64];
    CHECK(token_store_load(tok, sizeof tok) && strcmp(tok, "tok-field") == 0, "the token is untouched");
    CHECK(memcmp(config_store_test_raw(), page, sizeof page) == 0,
          "loading writes nothing: no conversion at boot");
}

static void test_adding_to_an_old_record_keeps_it_readable_by_old_firmware(void) {
    unsigned char page[256];
    old_layout(page, "HomeNet", "hunter2hunter2", "ABC123");
    config_store_test_write_raw(page, sizeof page);
    CHECK(token_store_save("tok-field"), "paired");
    device_config_t cfg;
    CHECK(config_store_load(&cfg), "loaded");
    CHECK(config_add_net(&cfg, "Hotspot", "phone-pass") == 1, "appended");
    CHECK(config_add_net(&cfg, "Club", "club-pass-1") == 2, "appended");
    cfg.last = 0;
    CHECK(config_store_update(&cfg), "saved");
    char tok[64];
    CHECK(token_store_load(tok, sizeof tok), "update keeps the token");

    char s[40], p[80], c[20];
    CHECK(old_reader(config_store_test_raw(), s, p, c), "an older firmware still finds a record");
    CHECK(strcmp(s, "HomeNet") == 0 && strcmp(p, "hunter2hunter2") == 0 && strcmp(c, "ABC123") == 0,
          "the last-joined network and the code, after a rollback");

    // Joined the hotspot since: page 0 follows the last-joined network.
    cfg.last = 1;
    CHECK(config_store_update(&cfg), "saved");
    CHECK(old_reader(config_store_test_raw(), s, p, c) && strcmp(s, "Hotspot") == 0,
          "page 0 always holds the network last joined");
    device_config_t back;
    CHECK(config_store_load(&back), "and this firmware reads all three");
    CHECK_EQ_INT(back.n_nets, 3);
    CHECK(strcmp(back.net[0].ssid, "HomeNet") == 0 && strcmp(back.net[1].ssid, "Hotspot") == 0 &&
          strcmp(back.net[2].ssid, "Club") == 0, "in saved order");
    CHECK_EQ_INT(back.last, 1);
    CHECK(strcmp(back.net[2].pass, "club-pass-1") == 0, "with their passwords");
}

static void test_four_networks_round_trip(void) {
    config_store_erase();
    device_config_t in;
    memset(&in, 0, sizeof in);
    for (int i = 0; i < CONFIG_NETS_MAX; i++) {
        memset(in.net[i].ssid, 'a' + i, CONFIG_SSID_MAX);      // longest names
        memset(in.net[i].pass, 'A' + i, CONFIG_PASS_MAX);      // and passwords
    }
    in.n_nets = CONFIG_NETS_MAX;
    in.last = 2;
    memset(in.code, '7', CONFIG_CODE_MAX);
    CHECK(config_store_save(&in), "the largest record fits");
    device_config_t out;
    memset(&out, 0, sizeof out);   // padding included: the memcmp below is byte-wise
    CHECK(config_store_load(&out), "loads");
    CHECK(memcmp(&in, &out, sizeof in) == 0, "every byte back");
    // Written one 256 B page at a time (review I3): this record's extension
    // (306 B) runs into page 2, so the streamed CRC crossed a page boundary.
    const unsigned char *raw = config_store_test_raw();
    CHECK(raw[2 * CONFIG_STORE_PAGE_BYTES] != 0xFF, "the extension reaches page 2");
}

static void test_a_write_torn_after_page_0_keeps_the_last_joined_network(void) {
    config_store_erase();
    device_config_t in = mk("home", "home-pass", "ABC123");
    CHECK(config_add_net(&in, "hotspot", "hot-pass") == 1, "two");
    in.last = 1;
    CHECK(config_store_save(&in), "save");
    unsigned char rec[CONFIG_STORE_RECORD_BYTES];
    memcpy(rec, config_store_test_raw(), sizeof rec);
    config_store_test_write_raw(rec, CONFIG_STORE_PAGE_BYTES);   // pages 1-2 never landed
    device_config_t out;
    CHECK(config_store_load(&out), "page 0 alone is a record");
    CHECK_EQ_INT(out.n_nets, 1);
    CHECK(strcmp(out.net[0].ssid, "hotspot") == 0, "the network last joined");
    CHECK(strcmp(out.code, "ABC123") == 0, "and the code");
}

static void test_a_damaged_extension_degrades_to_one_network(void) {
    config_store_erase();
    device_config_t in = mk("home", "home-pass", "ABC123");
    config_add_net(&in, "hotspot", "hot-pass");
    CHECK(config_store_save(&in), "save");
    unsigned char rec[CONFIG_STORE_RECORD_BYTES];
    memcpy(rec, config_store_test_raw(), sizeof rec);
    rec[CONFIG_STORE_PAGE_BYTES + 14] ^= 0x01;   // a byte of the second network
    config_store_test_write_raw(rec, sizeof rec);
    device_config_t out;
    CHECK(config_store_load(&out), "still loads");
    CHECK_EQ_INT(out.n_nets, 1);
    CHECK(strcmp(out.net[0].ssid, "home") == 0, "page 0's network");
}

static void test_an_extension_from_another_page_0_is_ignored(void) {
    // An older firmware rewrote page 0 (it erases the whole sector, so this
    // cannot happen through it -- but a stale extension must never be paired
    // with a page 0 it was not written with).
    config_store_erase();
    device_config_t in = mk("home", "home-pass", "ABC123");
    config_add_net(&in, "hotspot", "hot-pass");
    CHECK(config_store_save(&in), "save");
    unsigned char rec[CONFIG_STORE_RECORD_BYTES];
    memcpy(rec, config_store_test_raw(), sizeof rec);
    old_layout(rec, "other", "other-pass", "ZZZ999");
    config_store_test_write_raw(rec, sizeof rec);
    device_config_t out;
    CHECK(config_store_load(&out), "loads");
    CHECK_EQ_INT(out.n_nets, 1);
    CHECK(strcmp(out.net[0].ssid, "other") == 0, "page 0 only");
}

static void test_present_says_whether_a_record_is_stored(void) {
    config_store_erase();
    CHECK(!config_store_present(), "erased: nothing");
    device_config_t in = mk("home", "home-pass", "ABC123");
    CHECK(config_store_save(&in), "save");
    CHECK(config_store_present(), "saved: present");
    config_store_test_corrupt_payload_byte();
    CHECK(!config_store_present(), "a bad CRC is not a record");
}

static void test_save_erases_the_token_and_update_keeps_it(void) {
    config_store_erase();
    device_config_t in = mk("home", "home-pass", "ABC123");
    CHECK(token_store_save("tok"), "token");
    CHECK(config_store_update(&in), "update");
    char tok[64];
    CHECK(token_store_load(tok, sizeof tok), "update: kept");
    CHECK(config_store_save(&in), "save");
    CHECK(!token_store_load(tok, sizeof tok), "save (a new pairing code): erased");
    psram_publish_slot(0);
    CHECK(!config_store_update(&in), "update obeys the mounted-disk guard too");
    psram_publish_slot(SLOT_NONE);
}

static void test_a_config_with_no_network_is_not_saved(void) {
    config_store_erase();
    device_config_t in;
    memset(&in, 0, sizeof in);
    snprintf(in.code, sizeof in.code, "ABC123");
    CHECK(!config_store_save(&in), "no network: refused");
    in = mk("home", "home-pass", "ABC123");
    in.last = 3;
    CHECK(!config_store_save(&in), "last out of range: refused");
    device_config_t out;
    CHECK(!config_store_load(&out), "and nothing was written");
}

static void test_the_list_operations(void) {
    device_config_t c;
    memset(&c, 0, sizeof c);
    CHECK_EQ_INT(config_add_net(&c, "a", "pa"), 0);
    CHECK_EQ_INT(config_add_net(&c, "b", "pb"), 1);
    CHECK_EQ_INT(config_add_net(&c, "c", "pc"), 2);
    CHECK_EQ_INT(config_add_net(&c, "b", "pb2"), 1);   // same SSID: in place
    CHECK(strcmp(c.net[1].pass, "pb2") == 0, "password replaced");
    CHECK_EQ_INT(c.n_nets, 3);
    CHECK_EQ_INT(config_add_net(&c, "d", "pd"), 3);
    CHECK_EQ_INT(config_add_net(&c, "e", "pe"), -1);   // full and new
    CHECK_EQ_INT(config_add_net(&c, "", "x"), -1);     // no name
    CHECK_EQ_INT(config_find_net(&c, "B"), -1);        // SSIDs are case-sensitive
    c.last = 2;
    CHECK(config_remove_net(&c, 0), "remove the first");
    CHECK_EQ_INT(c.last, 1);   // still "c"
    CHECK(strcmp(c.net[c.last].ssid, "c") == 0, "last follows its network");
    CHECK(config_remove_net(&c, 1), "remove the last-joined");
    CHECK_EQ_INT(c.last, 0);
    CHECK_EQ_INT(c.n_nets, 2);
    CHECK(!config_remove_net(&c, 5), "out of range");
}

int main(void) {
    size_t len = (size_t)TRACK_MAX_BYTES * NUM_TRACKS * SLOT_COUNT;
    void *mem = malloc(len);
    psram_image_set_backing(mem, len);
    RUN(test_round_trips);
    RUN(test_torn_write_during_magic_is_rejected);
    RUN(test_torn_write_after_magic_is_rejected);
    RUN(test_corrupt_magic_is_rejected);
    RUN(test_crc_mismatch_is_rejected);
    RUN(test_max_length_ssid_is_accepted);
    RUN(test_save_refuses_while_a_disk_is_mounted);
    RUN(test_erase_also_erases_the_token);
    RUN(test_an_old_single_network_record_loads_unchanged);
    RUN(test_adding_to_an_old_record_keeps_it_readable_by_old_firmware);
    RUN(test_four_networks_round_trip);
    RUN(test_a_write_torn_after_page_0_keeps_the_last_joined_network);
    RUN(test_a_damaged_extension_degrades_to_one_network);
    RUN(test_an_extension_from_another_page_0_is_ignored);
    RUN(test_present_says_whether_a_record_is_stored);
    RUN(test_save_erases_the_token_and_update_keeps_it);
    RUN(test_a_config_with_no_network_is_not_saved);
    RUN(test_the_list_operations);
    free(mem);
    return REPORT();
}
