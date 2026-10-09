// See display_store.h. Structure mirrors config_store.c: pure page
// build/load, then a device flash backing and a host buffer backing.
//
// Record layout, one program page:
//   magic(4) . version(4) . panel(1) . has_layout(1) . blob_len(1) .
//   blob[blob_len] . crc32(4)
// The CRC covers version .. last blob byte (not the magic, which only says
// "a record is here at all").
#include "display_store.h"
#include "psram_image.h"
#include <string.h>

#define DISPLAY_MAGIC 0x44535031u   // 'DSP1', little-endian
#define DISPLAY_HEADER_LEN 11       // magic(4) + version(4) + panel + has_layout + blob_len

static void write_u32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}

static uint32_t read_u32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static uint32_t crc32_bitwise(const uint8_t *data, size_t len) {
    uint32_t crc = 0xFFFFFFFFu;
    for (size_t i = 0; i < len; i++) {
        crc ^= data[i];
        for (int bit = 0; bit < 8; bit++) {
            uint32_t mask = -(crc & 1u);
            crc = (crc >> 1) ^ (0xEDB88320u & mask);
        }
    }
    return ~crc;
}

static bool page_load(const uint8_t *page, size_t page_len, display_record_t *out) {
    if (page_len < DISPLAY_HEADER_LEN + 4 || read_u32(page) != DISPLAY_MAGIC) return false;
    size_t blob_len = page[10];
    if (blob_len > LAYOUT_BLOB_MAX) return false;
    size_t crc_off = DISPLAY_HEADER_LEN + blob_len;
    if (crc_off + 4 > page_len) return false;
    if (crc32_bitwise(page + 4, crc_off - 4) != read_u32(page + crc_off)) return false;

    memset(out, 0, sizeof *out);
    out->version = read_u32(page + 4);
    out->panel = page[8];
    out->has_layout = page[9];
    out->blob_len = (uint8_t)blob_len;
    memcpy(out->blob, page + DISPLAY_HEADER_LEN, blob_len);
    return true;
}

static bool page_build(uint8_t *out, size_t page_len, const display_record_t *r) {
    if (r->blob_len > LAYOUT_BLOB_MAX) return false;
    size_t crc_off = DISPLAY_HEADER_LEN + r->blob_len;
    if (crc_off + 4 > page_len) return false;

    memset(out, 0xFF, page_len);
    write_u32(out, DISPLAY_MAGIC);
    write_u32(out + 4, r->version);
    out[8] = r->panel;
    out[9] = r->has_layout;
    out[10] = r->blob_len;
    memcpy(out + DISPLAY_HEADER_LEN, r->blob, r->blob_len);
    write_u32(out + crc_off, crc32_bitwise(out + 4, crc_off - 4));
    return true;
}

bool display_store_should_write(bool pending, bool disk_mounted) {
    return pending && !disk_mounted;
}

#ifndef WFMF_HOST_TEST
#include "hardware/flash.h"
#include "hardware/address_mapped.h"   // XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE
#include "pico/flash.h"                // flash_safe_execute

// Top-of-flash map (each one sector, counted down from the end):
//   -1 token_store.c   -2 config_store.c   -3 fw_state.c (OTA state)
//   -4 display_store.c (this one)   -5 drive_store.c
// The A/B partitions (partitions.json) end at 8224K, far below all five.
#define DISPLAY_FLASH_OFFSET (PICO_FLASH_SIZE_BYTES - 4 * FLASH_SECTOR_SIZE)
#define DISPLAY_STORE_CAP    FLASH_PAGE_SIZE   // one program page

static bool disk_is_mounted(void) {
    return psram_active_slot() != SLOT_NONE;
}

static void do_erase(void *param) {
    (void)param;
    flash_range_erase(DISPLAY_FLASH_OFFSET, FLASH_SECTOR_SIZE);
}

typedef struct { const uint8_t *data; size_t len; } program_args_t;

static void do_program(void *param) {
    program_args_t *a = param;
    flash_range_erase(DISPLAY_FLASH_OFFSET, FLASH_SECTOR_SIZE);
    flash_range_program(DISPLAY_FLASH_OFFSET, a->data, a->len);
}

bool display_store_load(display_record_t *out) {
    // NOTRANSLATE: see config_store_load() (partitioned boots fault on XIP_BASE).
    const uint8_t *p = (const uint8_t *)(XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE + DISPLAY_FLASH_OFFSET);
    return page_load(p, DISPLAY_STORE_CAP, out);
}

bool display_store_save(const display_record_t *r) {
    if (disk_is_mounted()) return false;
    static uint8_t page[DISPLAY_STORE_CAP];   // static: see config_store_save()
    if (!page_build(page, sizeof page, r)) return false;
    program_args_t args = { page, sizeof page };
    return flash_safe_execute(do_program, &args, 1000) == PICO_OK;
}

void display_store_erase(void) {
    if (disk_is_mounted()) return;
    flash_safe_execute(do_erase, NULL, 1000);
}

#else   // WFMF_HOST_TEST

#define DISPLAY_HOST_CAP (DISPLAY_HEADER_LEN + LAYOUT_BLOB_MAX + 4)
static uint8_t g_page[DISPLAY_HOST_CAP];
static bool    g_page_init;

static void ensure_init(void) {
    if (!g_page_init) { memset(g_page, 0xFF, sizeof g_page); g_page_init = true; }
}

bool display_store_load(display_record_t *out) {
    ensure_init();
    return page_load(g_page, sizeof g_page, out);
}

bool display_store_save(const display_record_t *r) {
    if (psram_active_slot() != SLOT_NONE) return false;   // same guard as the device backing
    ensure_init();
    return page_build(g_page, sizeof g_page, r);
}

void display_store_erase(void) {
    if (psram_active_slot() != SLOT_NONE) return;
    memset(g_page, 0xFF, sizeof g_page);
    g_page_init = true;
}

void display_store_corrupt_for_test(void) {
    ensure_init();
    g_page[DISPLAY_HEADER_LEN] ^= 0xFF;   // first blob byte; magic, lengths untouched
}

#endif
