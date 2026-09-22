#include "fw_state.h"
#include "psram_image.h"
#include <string.h>

// Layout (little-endian), 132 bytes, one program page:
//   [0..3]    magic "FWS1"
//   [4]       format (1)
//   [5..8]    installed_sequence
//   [9]       pending (0/1)
//   [10..13]  pending_sequence
//   [14..78]  pending_version, NUL-padded (65)
//   [79..127] failure, NUL-padded (49)
//   [128..131] CRC-32 over [4..127]
#define FW_STATE_MAGIC  0x31535746u
#define FW_STATE_FORMAT 1u
#define OFF_FORMAT    4
#define OFF_INSTALLED 5
#define OFF_PENDING   9
#define OFF_PSEQ      10
#define OFF_PVER      14
#define OFF_FAIL      (OFF_PVER + FW_STATE_VERSION_MAX + 1)
#define OFF_CRC       (OFF_FAIL + FW_STATE_REASON_MAX + 1)
_Static_assert(OFF_CRC + 4 == FW_STATE_RECORD_BYTES, "record layout");

static uint32_t crc32_bytes(const uint8_t *p, size_t n) {
    uint32_t c = 0xffffffffu;
    for (size_t i = 0; i < n; i++) {
        c ^= p[i];
        for (int k = 0; k < 8; k++) c = (c >> 1) ^ (0xedb88320u & (0u - (c & 1u)));
    }
    return ~c;
}
static void put_u32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}
static uint32_t get_u32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

bool fw_state_encode(const fw_state_t *s, uint8_t out[FW_STATE_RECORD_BYTES]) {
    if (!memchr(s->pending_version, '\0', sizeof s->pending_version)) return false;
    if (!memchr(s->failure, '\0', sizeof s->failure)) return false;
    memset(out, 0, FW_STATE_RECORD_BYTES);
    put_u32(out, FW_STATE_MAGIC);
    out[OFF_FORMAT] = FW_STATE_FORMAT;
    put_u32(out + OFF_INSTALLED, s->installed_sequence);
    out[OFF_PENDING] = s->pending ? 1 : 0;
    put_u32(out + OFF_PSEQ, s->pending_sequence);
    memcpy(out + OFF_PVER, s->pending_version, strlen(s->pending_version));
    memcpy(out + OFF_FAIL, s->failure, strlen(s->failure));
    put_u32(out + OFF_CRC, crc32_bytes(out + OFF_FORMAT, OFF_CRC - OFF_FORMAT));
    return true;
}

bool fw_state_decode(const uint8_t *p, fw_state_t *out) {
    memset(out, 0, sizeof *out);
    if (get_u32(p) != FW_STATE_MAGIC) return false;
    if (p[OFF_FORMAT] != FW_STATE_FORMAT) return false;
    if (get_u32(p + OFF_CRC) != crc32_bytes(p + OFF_FORMAT, OFF_CRC - OFF_FORMAT)) return false;
    if (p[OFF_PENDING] > 1) return false;
    if (!memchr(p + OFF_PVER, '\0', FW_STATE_VERSION_MAX + 1)) return false;
    if (!memchr(p + OFF_FAIL, '\0', FW_STATE_REASON_MAX + 1)) return false;
    out->installed_sequence = get_u32(p + OFF_INSTALLED);
    out->pending = p[OFF_PENDING] == 1;
    out->pending_sequence = get_u32(p + OFF_PSEQ);
    memcpy(out->pending_version, p + OFF_PVER, FW_STATE_VERSION_MAX + 1);
    memcpy(out->failure, p + OFF_FAIL, FW_STATE_REASON_MAX + 1);
    return true;
}

// Same guard as config_store/token_store: never write flash under a mounted disk.
static bool disk_is_mounted(void) { return psram_active_slot() != SLOT_NONE; }

#ifndef WFMF_HOST_TEST
#include "hardware/flash.h"
#include "hardware/address_mapped.h"   // XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE
#include "pico/flash.h"

// Below config (-8 KB) and token (-4 KB); outside both A/B partitions, which end at
// 8 MB + 32 KB (partitions.json).
#define FW_STATE_FLASH_OFFSET (PICO_FLASH_SIZE_BYTES - 3 * FLASH_SECTOR_SIZE)

static void do_program(void *param) {
    flash_range_erase(FW_STATE_FLASH_OFFSET, FLASH_SECTOR_SIZE);
    flash_range_program(FW_STATE_FLASH_OFFSET, (const uint8_t *)param, FLASH_PAGE_SIZE);
}

bool fw_state_load(fw_state_t *out) {
    // NOTRANSLATE: see config_store_load (spec M3).
    return fw_state_decode((const uint8_t *)(XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE + FW_STATE_FLASH_OFFSET), out);
}

bool fw_state_save(const fw_state_t *s) {
    if (disk_is_mounted()) return false;
    static uint8_t page[FLASH_PAGE_SIZE];   // static: flash_safe_execute keeps its window short
    memset(page, 0xFF, sizeof page);
    if (!fw_state_encode(s, page)) return false;
    return flash_safe_execute(do_program, page, 1000) == PICO_OK;
}

#else   // WFMF_HOST_TEST

static uint8_t g_raw[FW_STATE_RECORD_BYTES];
void fw_state_test_erase(void) { memset(g_raw, 0xFF, sizeof g_raw); }
uint8_t *fw_state_test_raw(void) { return g_raw; }
bool fw_state_load(fw_state_t *out) { return fw_state_decode(g_raw, out); }
bool fw_state_save(const fw_state_t *s) {
    if (disk_is_mounted()) return false;
    uint8_t rec[FW_STATE_RECORD_BYTES];
    if (!fw_state_encode(s, rec)) return false;
    memcpy(g_raw, rec, sizeof rec);
    return true;
}
#endif
