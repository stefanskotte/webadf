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
    if (p[0] == 0xFF) return false;   // erased sector: nothing stored yet
    size_t n = 0;
    while (n < TOKEN_STORE_CAP - 1 && p[n] != '\0') n++;
    if (n >= (size_t)out_len) n = (size_t)out_len - 1;
    memcpy(out, p, n);
    out[n] = '\0';
    return true;
}

bool token_store_save(const char *token) {
    if (disk_is_mounted()) return false;
    size_t n = strlen(token);
    if (n > TOKEN_STORE_MAX_LEN) return false;

    // Static rather than a stack buffer: flash_safe_execute's callback
    // runs with interrupts disabled and the other core locked out for as
    // short a time as possible, and there is no reason to make that
    // window's stack frame any bigger than it has to be.
    static uint8_t page[TOKEN_STORE_CAP];
    memset(page, 0xFF, sizeof page);
    memcpy(page, token, n);
    page[n] = '\0';

    program_args_t args = { page, sizeof page };
    return flash_safe_execute(do_program, &args, 1000) == PICO_OK;
}

void token_store_erase(void) {
    flash_safe_execute(do_erase, NULL, 1000);
}

#else   // WFMF_HOST_TEST

static char g_token[TOKEN_STORE_MAX_LEN + 1];
static bool g_have_token;

bool token_store_load(char *out, int out_len) {
    if (!g_have_token || out_len <= 0) return false;
    size_t n = strlen(g_token);
    if (n >= (size_t)out_len) n = (size_t)out_len - 1;
    memcpy(out, g_token, n);
    out[n] = '\0';
    return true;
}

bool token_store_save(const char *token) {
    // Same guard as the device backing (see the comment above
    // disk_is_mounted() there) -- kept identical so a host test can prove
    // this rule holds without needing flash hardware.
    if (psram_active_slot() != SLOT_NONE) return false;
    size_t n = strlen(token);
    if (n > TOKEN_STORE_MAX_LEN) return false;
    memcpy(g_token, token, n);
    g_token[n] = '\0';
    g_have_token = true;
    return true;
}

void token_store_erase(void) {
    g_have_token = false;
    g_token[0] = '\0';
}

#endif
