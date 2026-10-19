// See key_store.h. Record layout, one program page: magic(4) . key(16) . crc32(4); the CRC covers the key.
#include "key_store.h"
#include "drive_store.h"   // drive_store_should_write: the same deferred-write rule
#include <stddef.h>
#include <string.h>

#define KEY_MAGIC 0x4B424657u   // "WFBK" in memory order
#define KEY_RECORD_LEN (4 + KEY_STORE_BYTES + 4)

static void write_u32(uint8_t *p, uint32_t v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24); }
static uint32_t read_u32(const uint8_t *p) { return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24); }
static uint32_t crc32_bitwise(const uint8_t *data, size_t len) {
    uint32_t crc = 0xFFFFFFFFu;
    for (size_t i = 0; i < len; i++) {
        crc ^= data[i];
        for (int bit = 0; bit < 8; bit++) { uint32_t mask = -(crc & 1u); crc = (crc >> 1) ^ (0xEDB88320u & mask); }
    }
    return ~crc;
}
static bool page_load(const uint8_t *page, size_t len, uint8_t out[KEY_STORE_BYTES]) {
    if (len < KEY_RECORD_LEN || read_u32(page) != KEY_MAGIC) return false;
    if (crc32_bitwise(page + 4, KEY_STORE_BYTES) != read_u32(page + 4 + KEY_STORE_BYTES)) return false;
    memcpy(out, page + 4, KEY_STORE_BYTES);
    return true;
}
static bool page_build(uint8_t *out, size_t len, const uint8_t k[KEY_STORE_BYTES]) {
    if (len < KEY_RECORD_LEN) return false;
    memset(out, 0xFF, len);
    write_u32(out, KEY_MAGIC);
    memcpy(out + 4, k, KEY_STORE_BYTES);
    write_u32(out + 4 + KEY_STORE_BYTES, crc32_bitwise(k, KEY_STORE_BYTES));
    return true;
}
bool key_store_should_write(bool unsaved, bool drive_record_this_pass, bool drive_empty, bool idle) {
    return unsaved && !drive_record_this_pass && drive_store_should_write(true, drive_empty, idle);
}

void key_store_hex(const uint8_t k[KEY_STORE_BYTES], char out[2 * KEY_STORE_BYTES + 1]) {
    static const char d[] = "0123456789abcdef";
    for (int i = 0; i < KEY_STORE_BYTES; i++) { out[2 * i] = d[k[i] >> 4]; out[2 * i + 1] = d[k[i] & 15]; }
    out[2 * KEY_STORE_BYTES] = 0;
}

#ifndef WFMF_HOST_TEST
#include "hardware/flash.h"
#include "hardware/address_mapped.h"   // XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE
#include "pico/flash.h"                // flash_safe_execute

// Sector -8: -1..-6 are the stores (drive_store.c's map), -7 the boot trail's update trail (boot_trail_hw.c).
#define KEY_FLASH_OFFSET (PICO_FLASH_SIZE_BYTES - 8 * FLASH_SECTOR_SIZE)
#define KEY_STORE_CAP    FLASH_PAGE_SIZE

typedef struct { const uint8_t *data; size_t len; } program_args_t;
static void do_program(void *param) {
    program_args_t *a = param;
    flash_range_erase(KEY_FLASH_OFFSET, FLASH_SECTOR_SIZE);
    flash_range_program(KEY_FLASH_OFFSET, a->data, a->len);
}
bool key_store_load(uint8_t out[KEY_STORE_BYTES]) {
    // NOTRANSLATE: see config_store_load() (partitioned boots fault on XIP_BASE).
    const uint8_t *p = (const uint8_t *)(XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE + KEY_FLASH_OFFSET);
    return page_load(p, KEY_STORE_CAP, out);
}
bool key_store_save(const uint8_t k[KEY_STORE_BYTES]) {
    static uint8_t page[KEY_STORE_CAP];   // static: see config_store_save()
    if (!page_build(page, sizeof page, k)) return false;
    program_args_t args = { page, sizeof page };
    return flash_safe_execute(do_program, &args, 1000) == PICO_OK;
}
#else   // WFMF_HOST_TEST
static uint8_t g_page[KEY_RECORD_LEN];
static bool g_init;
static void ensure_init(void) { if (!g_init) { memset(g_page, 0xFF, sizeof g_page); g_init = true; } }
bool key_store_load(uint8_t out[KEY_STORE_BYTES]) { ensure_init(); return page_load(g_page, sizeof g_page, out); }
bool key_store_save(const uint8_t k[KEY_STORE_BYTES]) { ensure_init(); return page_build(g_page, sizeof g_page, k); }
void key_store_erase_for_test(void) { memset(g_page, 0xFF, sizeof g_page); g_init = true; }
void key_store_corrupt_for_test(void) { ensure_init(); g_page[5] ^= 0xFF; }
#endif
