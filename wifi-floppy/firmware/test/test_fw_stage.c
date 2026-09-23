#include "harness.h"
#include "../src/fw_stage.h"
#include "../src/sha256.h"
#include <string.h>

static uint8_t buf[64];

static void hex_of(const uint8_t *p, uint32_t n, char out[65]) {
    sha256_t s; uint8_t d[32]; sha256_init(&s); sha256_update(&s, p, n); sha256_final(&s, d); sha256_hex(d, out);
}
static void test_whole_image_in_chunks_matches(void) {
    const char *img = "0123456789abcdefghij";
    char want[65]; hex_of((const uint8_t *)img, 20, want);
    fw_stage_t s; fw_stage_begin(&s, buf, sizeof buf);
    fw_stage_sink(&s, (const uint8_t *)img, 7);
    fw_stage_sink(&s, (const uint8_t *)img + 7, 13);
    CHECK(fw_stage_matches(&s, 20, want), "chunked arrival hashes the same as whole");
    CHECK(memcmp(buf, img, 20) == 0, "and the bytes are staged in order");
}
static void test_short_download_does_not_match(void) {
    const char *img = "0123456789";
    char want[65]; hex_of((const uint8_t *)img, 10, want);
    fw_stage_t s; fw_stage_begin(&s, buf, sizeof buf);
    fw_stage_sink(&s, (const uint8_t *)img, 9);
    CHECK(!fw_stage_matches(&s, 10, want), "a truncated download never matches");
}
static void test_overflow_is_refused_not_wrapped(void) {
    fw_stage_t s; fw_stage_begin(&s, buf, 8);
    fw_stage_sink(&s, (const uint8_t *)"0123456789", 10);
    CHECK(s.overflow, "more than the stage holds is an overflow");
    CHECK(!fw_stage_matches(&s, 10, "00"), "and never matches");
}
static void test_right_length_wrong_bytes_does_not_match(void) {
    char want[65]; hex_of((const uint8_t *)"AAAA", 4, want);
    fw_stage_t s; fw_stage_begin(&s, buf, sizeof buf);
    fw_stage_sink(&s, (const uint8_t *)"AAAB", 4);
    CHECK(!fw_stage_matches(&s, 4, want), "the hash, not the length, decides");
}
int main(void) {
    RUN(test_whole_image_in_chunks_matches);
    RUN(test_short_download_does_not_match);
    RUN(test_overflow_is_refused_not_wrapped);
    RUN(test_right_length_wrong_bytes_does_not_match);
    return REPORT();
}
