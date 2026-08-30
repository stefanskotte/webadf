// See token_store.h for what this stores and why. Two backings, selected
// at compile time exactly like psram_image.c's have_psram split:
//
//   WFMF_HOST_TEST : a static in-process buffer, so device_client.c's
//                    registration tests (test_device_client.c) and this
//                    file's own tests (test_token_store.c) can run without
//                    a flash chip.
//   device build   : one dedicated flash sector, erase-then-program via
//                    hardware/flash.h, wrapped in pico/flash.h's
//                    flash_safe_execute so the erase/program pair runs
//                    with interrupts disabled and core0 locked out of
//                    flash for its duration (see main.c's call to
//                    flash_safe_execute_core_init() and its DMA IRQ
//                    comment -- writing flash disables XIP, and core0's
//                    real-time DMA IRQ must never be caught mid-flash).
#include "token_store.h"
#include "psram_image.h"
#include <string.h>

// Review round 1, Minor M-3: the stored layout is a 4-byte little-endian
// magic word, then a NUL-terminated token -- identical on both backings.
// The magic is what lets a read tell "nothing has ever been written here"
// (an erased flash sector reads back as all-0xFF, which is not this magic)
// apart from "a write started but was interrupted before it finished" (a
// torn write -- e.g. power lost mid-program -- leaves some other partial
// bit pattern, also not this magic) from "a real token is here". Without
// it, the old p[0] != 0xFF check treated anything except a fully-erased
// first byte as a valid token, so a torn write could hand back garbage
// bytes dressed up as a token instead of correctly reporting nothing
// stored. Chosen to be neither all-0x00 nor all-0xFF; otherwise arbitrary.
#define TOKEN_MAGIC 0x314B4F54u   // "TOK1", little-endian

static void magic_write(uint8_t *p, uint32_t magic) {
    p[0] = (uint8_t)magic;
    p[1] = (uint8_t)(magic >> 8);
    p[2] = (uint8_t)(magic >> 16);
    p[3] = (uint8_t)(magic >> 24);
}

static uint32_t magic_read(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

// Reads a page laid out as [4-byte magic][NUL-terminated token]. False if
// the magic doesn't match -- covers both "never written" and "torn write"
// alike, and both must read back as "nothing stored", never as whatever
// partial bytes happen to look like a C string.
static bool page_load(const uint8_t *page, size_t page_len, char *out, int out_len) {
    if (page_len < 5 || magic_read(page) != TOKEN_MAGIC) return false;
    const uint8_t *tok = page + 4;
    size_t cap = page_len - 4;
    size_t n = 0;
    while (n < cap - 1 && tok[n] != '\0') n++;
    if (n >= (size_t)out_len) n = (size_t)out_len - 1;
    memcpy(out, tok, n);
    out[n] = '\0';
    return true;
}

// Builds a page (size page_len) for `token` into `out`. False -- and `out`
// left untouched -- if it doesn't fit.
static bool page_build(uint8_t *out, size_t page_len, const char *token) {
    size_t n = strlen(token);
    if (n > TOKEN_STORE_MAX_LEN || n + 4 + 1 > page_len) return false;
    memset(out, 0xFF, page_len);
    magic_write(out, TOKEN_MAGIC);
    memcpy(out + 4, token, n);
    out[4 + n] = '\0';
    return true;
}

#ifndef WFMF_HOST_TEST
#include "hardware/flash.h"
#include "hardware/address_mapped.h"   // XIP_BASE
#include "pico/flash.h"                // flash_safe_execute

// Carve the token sector out of the very top of flash. PICO_FLASH_SIZE_BYTES
// comes from the board header (see CMakeLists.txt's PICO_BOARD); nothing
// else this project puts in flash is placed there by the linker, and the
// disk image itself lives in PSRAM (psram_image.c), not flash, so this
// sector is never fought over.
#define TOKEN_FLASH_OFFSET (PICO_FLASH_SIZE_BYTES - FLASH_SECTOR_SIZE)
#define TOKEN_STORE_CAP     FLASH_PAGE_SIZE   // one program page

// Belt and braces with main.c's __not_in_flash_func on the DMA IRQ.
// Registration runs before any disk is mounted (main.c only calls
// token_store_save() from the boot-time registration path); if that ever
// stops being true, refusing here -- rather than writing flash out from
// under a streaming DMA -- is what catches it.
static bool disk_is_mounted(void) {
    return psram_active_slot() != SLOT_NONE;
}

static void do_erase(void *param) {
    (void)param;
    flash_range_erase(TOKEN_FLASH_OFFSET, FLASH_SECTOR_SIZE);
}

typedef struct { const uint8_t *data; size_t len; } program_args_t;

static void do_program(void *param) {
    program_args_t *a = param;
    // A page can only be programmed to something other than all-1s after
    // its sector has been erased back to all-1s (hardware/flash.h).
    flash_range_erase(TOKEN_FLASH_OFFSET, FLASH_SECTOR_SIZE);
    flash_range_program(TOKEN_FLASH_OFFSET, a->data, a->len);
}

bool token_store_load(char *out, int out_len) {
    if (out_len <= 0) return false;
    const uint8_t *p = (const uint8_t *)(XIP_BASE + TOKEN_FLASH_OFFSET);
    return page_load(p, TOKEN_STORE_CAP, out, out_len);
}

bool token_store_save(const char *token) {
    if (disk_is_mounted()) return false;

    // Static rather than a stack buffer: flash_safe_execute's callback
    // runs with interrupts disabled and the other core locked out for as
    // short a time as possible, and there is no reason to make that
    // window's stack frame any bigger than it has to be.
    static uint8_t page[TOKEN_STORE_CAP];
    if (!page_build(page, sizeof page, token)) return false;

    program_args_t args = { page, sizeof page };
    return flash_safe_execute(do_program, &args, 1000) == PICO_OK;
}

void token_store_erase(void) {
    // Review round 1, Minor M-2: token_store_save() has always refused
    // while a disk is mounted; erase() writes the same flash sector (an
    // erase is itself a flash write, not merely "forgetting" something in
    // RAM) and had no such guard. Unreachable today (main.c never calls
    // this), but the whole point of the guard is to survive a future
    // caller that doesn't know that -- see disk_is_mounted()'s comment.
    if (disk_is_mounted()) return;
    flash_safe_execute(do_erase, NULL, 1000);
}

#else   // WFMF_HOST_TEST

#define TOKEN_HOST_CAP (4 + TOKEN_STORE_MAX_LEN + 1)
static uint8_t g_page[TOKEN_HOST_CAP];
static bool    g_page_init;

// Mirrors flash's power-on-erased state (all-0xFF, i.e. no magic match)
// until the first save -- lazily, so a test that never calls
// token_store_erase() first still starts from "nothing stored" rather than
// however g_page happened to be zero-initialized (0x00 bytes also don't
// match TOKEN_MAGIC, so this is belt-and-braces rather than load-bearing,
// but it keeps the host backing's default state honestly modelling the
// device backing's).
static void ensure_init(void) {
    if (!g_page_init) {
        memset(g_page, 0xFF, sizeof g_page);
        g_page_init = true;
    }
}

bool token_store_load(char *out, int out_len) {
    if (out_len <= 0) return false;
    ensure_init();
    return page_load(g_page, sizeof g_page, out, out_len);
}

bool token_store_save(const char *token) {
    // Same guard as the device backing (see disk_is_mounted()'s comment
    // there) -- kept identical so a host test can prove this rule holds
    // without needing flash hardware.
    if (psram_active_slot() != SLOT_NONE) return false;
    ensure_init();
    return page_build(g_page, sizeof g_page, token);
}

void token_store_erase(void) {
    // M-2, mirrored -- see the device backing's token_store_erase().
    if (psram_active_slot() != SLOT_NONE) return;
    memset(g_page, 0xFF, sizeof g_page);
    g_page_init = true;
}

// Test-only (declared in token_store.h, defined only here -- see
// psram_image_set_backing() for the same pattern). Simulates a flash
// program that started but never completed (e.g. a power loss mid-write):
// the page ends up holding neither the erased pattern nor a valid
// magic+token. Lets test_token_store.c prove M-3's fix actually rejects
// this case instead of surfacing partial bytes as if they were real.
void token_store_test_simulate_torn_write(void) {
    ensure_init();
    magic_write(g_page, TOKEN_MAGIC);
    g_page[0] ^= 0xFF;      // corrupt the magic: neither valid nor erased
    g_page[4] = 'x';        // a plausible-looking stray token byte, for good measure
}

#endif
