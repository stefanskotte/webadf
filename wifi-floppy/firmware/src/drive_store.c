// See drive_store.h. Structure mirrors display_store.c: pure page
// build/load, then a device flash backing and a host buffer backing.
//
// Record layout, one program page:
//   magic(4) . version(4) . mode(1) . crc32(4)
// The CRC covers version .. mode (not the magic, which only says "a record is
// here at all").
#include "drive_store.h"
#include "psram_image.h"
#include "swap_gate.h"
#include <string.h>

#define DRIVE_MAGIC 0x44525631u   // 'DRV1'
#define DRIVE_PAYLOAD_LEN 5       // version(4) + mode(1)
#define DRIVE_RECORD_LEN (4 + DRIVE_PAYLOAD_LEN + 4)

#if WF_DF1_DEFAULT
// Image marker: tells scripts/firmware-release.ts (src/lib/firmware-manifest.ts)
// that this build turns DF1 on by default, which is for bench TEST builds only.
const char wf_df1_default_marker[] = "wf-df1-default-on";
#endif

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

static bool page_load(const uint8_t *page, size_t page_len, drive_record_t *out) {
    if (page_len < DRIVE_RECORD_LEN || read_u32(page) != DRIVE_MAGIC) return false;
    if (crc32_bitwise(page + 4, DRIVE_PAYLOAD_LEN) != read_u32(page + 4 + DRIVE_PAYLOAD_LEN)) return false;
    memset(out, 0, sizeof *out);
    out->version = read_u32(page + 4);
    out->mode = page[8];
    return true;
}

static bool page_build(uint8_t *out, size_t page_len, const drive_record_t *r) {
    if (page_len < DRIVE_RECORD_LEN) return false;
    memset(out, 0xFF, page_len);
    write_u32(out, DRIVE_MAGIC);
    write_u32(out + 4, r->version);
    out[8] = r->mode;
    write_u32(out + 4 + DRIVE_PAYLOAD_LEN, crc32_bitwise(out + 4, DRIVE_PAYLOAD_LEN));
    return true;
}

df1_mode_t drive_boot_mode(bool loaded, const drive_record_t *r) {
#if WF_DF1_DEFAULT
    // Read the marker through a volatile pointer so the linker keeps it.
    static const char *volatile keep = wf_df1_default_marker;
    (void)keep[0];
#endif
    if (!loaded || !r) return WF_DF1_DEFAULT ? DF1_MODE_NEXT : DF1_MODE_OFF;
    return r->mode == DF1_MODE_NEXT ? DF1_MODE_NEXT : DF1_MODE_OFF;
}

bool drive_store_should_write(bool pending, bool drive_empty, bool idle) {
    return pending && (drive_empty || idle);
}

bool drive_store_idle(uint32_t now, bool motor_on, bool wgate_asserted,
                      uint32_t last_activity_ms, bool writes_unsent) {
    if (writes_unsent || motor_on) return false;   // never forced past either
    // motor_on is false here, so swap_gate's forced release (SWAP_FORCE_MS of
    // silence) can only pass a WGATE that reads asserted -- a powered-off
    // Amiga, which reads nothing.
    return swap_gate_idle(now, false, wgate_asserted, last_activity_ms, NULL);
}

#ifndef WFMF_HOST_TEST
#include "hardware/flash.h"
#include "hardware/address_mapped.h"   // XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE
#include "pico/flash.h"                // flash_safe_execute

// Top-of-flash map (each one sector, counted down from the end):
//   -1 token_store.c   -2 config_store.c   -3 fw_state.c (OTA state)
//   -4 display_store.c   -5 drive_store.c (this one)
// The A/B partitions (partitions.json) end at 8224K, far below all five.
#define DRIVE_FLASH_OFFSET (PICO_FLASH_SIZE_BYTES - 5 * FLASH_SECTOR_SIZE)
#define DRIVE_STORE_CAP    FLASH_PAGE_SIZE   // one program page

// DF1 holds a disk only while DF0 does (the slot invariant, Task 13), so "no
// DF0 slot active" is sufficient to know both drives are empty. Guards the
// erase only: the save's timing is the caller's (drive_store_should_write).
static bool disk_is_mounted(void) {
    return psram_active_slot() != SLOT_NONE;
}

static void do_erase(void *param) {
    (void)param;
    flash_range_erase(DRIVE_FLASH_OFFSET, FLASH_SECTOR_SIZE);
}

typedef struct { const uint8_t *data; size_t len; } program_args_t;

static void do_program(void *param) {
    program_args_t *a = param;
    flash_range_erase(DRIVE_FLASH_OFFSET, FLASH_SECTOR_SIZE);
    flash_range_program(DRIVE_FLASH_OFFSET, a->data, a->len);
}

bool drive_store_load(drive_record_t *out) {
    // NOTRANSLATE: see config_store_load() (partitioned boots fault on XIP_BASE).
    const uint8_t *p = (const uint8_t *)(XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE + DRIVE_FLASH_OFFSET);
    return page_load(p, DRIVE_STORE_CAP, out);
}

bool drive_store_save(const drive_record_t *r) {
    static uint8_t page[DRIVE_STORE_CAP];   // static: see config_store_save()
    if (!page_build(page, sizeof page, r)) return false;
    program_args_t args = { page, sizeof page };
    return flash_safe_execute(do_program, &args, 1000) == PICO_OK;
}

void drive_store_erase(void) {
    if (disk_is_mounted()) return;
    flash_safe_execute(do_erase, NULL, 1000);
}

#else   // WFMF_HOST_TEST

static uint8_t g_page[DRIVE_RECORD_LEN];
static bool    g_page_init;

static void ensure_init(void) {
    if (!g_page_init) { memset(g_page, 0xFF, sizeof g_page); g_page_init = true; }
}

bool drive_store_load(drive_record_t *out) {
    ensure_init();
    return page_load(g_page, sizeof g_page, out);
}

bool drive_store_save(const drive_record_t *r) {
    ensure_init();   // no mounted-disk guard: the caller decides when (R17)
    return page_build(g_page, sizeof g_page, r);
}

void drive_store_erase(void) {
    if (psram_active_slot() != SLOT_NONE) return;
    memset(g_page, 0xFF, sizeof g_page);
    g_page_init = true;
}

void drive_store_corrupt_for_test(void) {
    ensure_init();
    g_page[8] ^= 0xFF;   // the mode byte; magic untouched
}

#endif
