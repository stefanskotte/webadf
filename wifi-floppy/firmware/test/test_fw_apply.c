#include "harness.h"
#include "../src/fw_apply.h"
#include "../src/sha256.h"
#include <string.h>

#define FLASH_BYTES (64u * 4096u)
static uint8_t flash[FLASH_BYTES];
static uint32_t log_off[64]; static char log_op[64]; static int log_n;
static int fail_program_at = -1;

static bool fe(void *ctx, uint32_t off) { (void)ctx; memset(flash + off, 0xFF, 4096); log_op[log_n] = 'E'; log_off[log_n++] = off; return true; }
static bool fp(void *ctx, uint32_t off, const uint8_t d[4096]) {
    (void)ctx;
    if ((int)(off / 4096) == fail_program_at) return false;
    for (int i = 0; i < 4096; i++) flash[off + (uint32_t)i] &= d[i];   // NOR: program only clears bits
    log_op[log_n] = 'P'; log_off[log_n++] = off; return true;
}
static const uint8_t *fr(void *ctx, uint32_t off) { (void)ctx; return flash + off; }
static const fw_flash_t F = { fe, fp, fr, NULL };

static uint8_t img[3 * 4096 + 100];
static void hex_of(const uint8_t *p, uint32_t n, char out[65]) {
    sha256_t s; uint8_t d[32]; sha256_init(&s); sha256_update(&s, p, n); sha256_final(&s, d); sha256_hex(d, out);
}
static void reset(void) {
    memset(flash, 0x5a, sizeof flash);   // the slot holds an OLD image
    log_n = 0; fail_program_at = -1;
    for (uint32_t i = 0; i < sizeof img; i++) img[i] = (uint8_t)(i * 7u);
}

static void test_writes_and_verifies(void) {
    reset();
    char want[65]; hex_of(img, sizeof img, want);
    CHECK_EQ_INT(fw_apply_image(&F, 8 * 4096, 16 * 4096, img, sizeof img, want), FWA_OK);
    CHECK(memcmp(flash + 8 * 4096, img, sizeof img) == 0, "the image is in the slot");
    CHECK(flash[8 * 4096 + sizeof img] == 0xFF, "the tail of the last sector is erased, not stale");
}
// D7: erase the header FIRST, program it LAST. Until the final program there is no valid
// IMAGE_DEF in the slot, old or new.
static void test_header_erased_first_and_programmed_last(void) {
    reset();
    char want[65]; hex_of(img, sizeof img, want);
    fw_apply_image(&F, 8 * 4096, 16 * 4096, img, sizeof img, want);
    CHECK(log_op[0] == 'E' && log_off[0] == 8 * 4096, "the first operation erases the header sector");
    CHECK(log_op[log_n - 1] == 'P' && log_off[log_n - 1] == 8 * 4096, "the last operation programs it");
    for (int i = 1; i < log_n - 1; i++)
        CHECK(!(log_op[i] == 'P' && log_off[i] == 8 * 4096), "nothing programs the header in between");
}
static void test_power_cut_midway_leaves_no_header(void) {
    reset();
    fail_program_at = 10;   // the third sector's program fails, as a cut would stop it
    char want[65]; hex_of(img, sizeof img, want);
    CHECK_EQ_INT(fw_apply_image(&F, 8 * 4096, 16 * 4096, img, sizeof img, want), FWA_PROGRAM_FAILED);
    for (int i = 0; i < 4096; i++) if (flash[8 * 4096 + (uint32_t)i] != 0xFF) { CHECK(false, "header sector must still be erased"); break; }
}
static void test_too_big_touches_nothing(void) {
    reset();
    CHECK_EQ_INT(fw_apply_image(&F, 8 * 4096, 2 * 4096, img, sizeof img, "00"), FWA_TOO_BIG);
    CHECK_EQ_INT(log_n, 0);
}
static void test_readback_mismatch_is_reported(void) {
    reset();
    CHECK_EQ_INT(fw_apply_image(&F, 8 * 4096, 16 * 4096, img, sizeof img, "00"), FWA_READBACK_MISMATCH);
}

int main(void) {
    RUN(test_writes_and_verifies);
    RUN(test_header_erased_first_and_programmed_last);
    RUN(test_power_cut_midway_leaves_no_header);
    RUN(test_too_big_touches_nothing);
    RUN(test_readback_mismatch_is_reported);
    return REPORT();
}
