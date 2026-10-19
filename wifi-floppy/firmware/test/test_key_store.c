// key_store.c (plan 2026-10-19 Task 8, ruling P2): the board key survives everything config_store loses.
#include <string.h>
#include "harness.h"
#include "../src/key_store.h"
#include "../src/config_store.h"

static const uint8_t K[KEY_STORE_BYTES] = { 0xab, 0x12, 0xcd, 0x34, 0xef, 0x56, 0xab, 0x12, 0xcd, 0x34, 0xef, 0x56, 0xab, 0x12, 0xcd, 0x34 };

static void nothing_stored_loads_false(void) {
    uint8_t k[KEY_STORE_BYTES];
    key_store_erase_for_test();
    CHECK(!key_store_load(k), "erased: no key");
}
static void a_saved_key_loads_back(void) {
    uint8_t k[KEY_STORE_BYTES];
    key_store_erase_for_test();
    CHECK(key_store_save(K), "saved");
    CHECK(key_store_load(k), "loaded");
    CHECK(memcmp(k, K, sizeof k) == 0, "the same bytes");
}
static void a_damaged_record_is_no_key(void) {
    uint8_t k[KEY_STORE_BYTES];
    key_store_erase_for_test(); key_store_save(K); key_store_corrupt_for_test();
    CHECK(!key_store_load(k), "a flipped byte fails the CRC");
}
static void re_pairing_keeps_the_key(void) {
    uint8_t k[KEY_STORE_BYTES];
    key_store_erase_for_test(); key_store_save(K);
    config_store_erase();                       // what a re-pair and a server change do
    CHECK(key_store_load(k) && memcmp(k, K, sizeof k) == 0, "still there");
}
static void hex_is_lower_case_32_digits(void) {
    char h[2 * KEY_STORE_BYTES + 1];
    key_store_hex(K, h);
    CHECK(strcmp(h, "ab12cd34ef56ab12cd34ef56ab12cd34") == 0, "hex");
}
int main(void) {
    RUN(nothing_stored_loads_false); RUN(a_saved_key_loads_back); RUN(a_damaged_record_is_no_key);
    RUN(re_pairing_keeps_the_key); RUN(hex_is_lower_case_32_digits);
    return REPORT();
}
