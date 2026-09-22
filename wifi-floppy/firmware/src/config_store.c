// See config_store.h for what this stores and why, and token_store.c's
// header comment for the two-backing split this mirrors exactly:
//
//   WFMF_HOST_TEST : a static in-process buffer.
//   device build   : one dedicated flash sector via hardware/flash.h,
//                    written with pico/flash.h's flash_safe_execute under
//                    the same mounted-disk guard token_store uses.
//
// The one thing this store has that token_store does not: a CRC-32 over
// the record. token_store's magic word (see its file header comment) tells
// "never written" and "torn write" apart from "a real value is here", but
// it sits at offset 0 -- it cannot tell "the write completed the magic and
// then the payload got corrupted" apart from "a real value is here",
// because by the time the magic bytes are intact the reader has no other
// signal to check. Credentials are more exposed to exactly that failure
// than a token is: they're written at the end of an interactive portal
// flow, which is precisely the moment someone is likely to walk away and
// pull the power. Deliberately NOT retrofitted onto token_store -- that
// stays out of scope (plan 4b's deferred list) and this store is the only
// one that needs it.
#include "config_store.h"
#include "token_store.h"
#include "psram_image.h"
#include <string.h>

// Review round 1 (token_store), Minor M-3, applied here from the start:
// a 4-byte little-endian magic word is what lets a read tell "nothing has
// ever been written here" (erased flash reads back as all-0xFF) and "a
// write started but was torn before the magic finished landing" apart from
// "a record is here". Chosen to be neither all-0x00 nor all-0xFF, and
// distinct from TOKEN_MAGIC; otherwise arbitrary.
#define CONFIG_MAGIC 0x57464347u   // 'WFCG', little-endian
#define CONFIG_VERSION 1u

// Record layout, written as one program page:
//   magic(4) . version(1) . ssid_len(1) . pass_len(1) . code_len(1) .
//   ssid[ssid_len] . pass[pass_len] . code[code_len] . crc32(4)
//
// The CRC covers everything from `version` through the last payload byte
// (i.e. NOT the magic itself -- the magic's job is purely "is a record
// here at all", checked first and independently of the CRC).
#define CONFIG_HEADER_LEN 8   // magic(4) + version(1) + 3 length bytes

static void write_u32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16);
    p[3] = (uint8_t)(v >> 24);
}

static uint32_t read_u32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

// Table-less bitwise CRC-32 (polynomial 0xEDB88320, the same one zlib's
// table is derived from). This runs once per provisioning, never in a hot
// path, so the ~8x speed a 256-entry table would buy isn't worth the flash.
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

// Reads a page laid out per the layout comment above. False if the magic
// doesn't match (covers both "never written" and "torn write" -- see
// token_store.c's page_load() for the identical argument), if the stored
// lengths don't fit the field maximums or the page itself (a defensive
// bounds check so a corrupted length byte can never walk the CRC check off
// the end of the page), or if the CRC doesn't match what's actually there.
static bool page_load(const uint8_t *page, size_t page_len, device_config_t *out) {
    if (page_len < CONFIG_HEADER_LEN + 4 || read_u32(page) != CONFIG_MAGIC) return false;
    if (page[4] != CONFIG_VERSION) return false;

    size_t ssid_len = page[5];
    size_t pass_len = page[6];
    size_t code_len = page[7];
    if (ssid_len > CONFIG_SSID_MAX || pass_len > CONFIG_PASS_MAX ||
        code_len > CONFIG_CODE_MAX) {
        return false;
    }

    size_t payload_len = 1 + 3 + ssid_len + pass_len + code_len;   // version+lens+fields
    size_t crc_off = CONFIG_HEADER_LEN + ssid_len + pass_len + code_len;
    if (crc_off + 4 > page_len) return false;

    uint32_t want = read_u32(page + crc_off);
    uint32_t got = crc32_bitwise(page + 4, payload_len);
    if (got != want) return false;

    memset(out, 0, sizeof *out);
    const uint8_t *p = page + CONFIG_HEADER_LEN;
    memcpy(out->ssid, p, ssid_len);           p += ssid_len;
    memcpy(out->pass, p, pass_len);           p += pass_len;
    memcpy(out->code, p, code_len);
    return true;
}

// Builds a page (size page_len) for `cfg` into `out`. False -- and `out`
// left untouched -- if a field has no NUL terminator within its array (the
// one way a fixed-size device_config_t field could still be "over length")
// or the record doesn't fit the page.
static bool page_build(uint8_t *out, size_t page_len, const device_config_t *cfg) {
    size_t ssid_len = strnlen(cfg->ssid, sizeof cfg->ssid);
    size_t pass_len = strnlen(cfg->pass, sizeof cfg->pass);
    size_t code_len = strnlen(cfg->code, sizeof cfg->code);
    if (ssid_len >= sizeof cfg->ssid || pass_len >= sizeof cfg->pass ||
        code_len >= sizeof cfg->code) {
        return false;
    }

    size_t crc_off = CONFIG_HEADER_LEN + ssid_len + pass_len + code_len;
    if (crc_off + 4 > page_len) return false;

    memset(out, 0xFF, page_len);
    write_u32(out, CONFIG_MAGIC);
    out[4] = (uint8_t)CONFIG_VERSION;
    out[5] = (uint8_t)ssid_len;
    out[6] = (uint8_t)pass_len;
    out[7] = (uint8_t)code_len;
    uint8_t *p = out + CONFIG_HEADER_LEN;
    memcpy(p, cfg->ssid, ssid_len);   p += ssid_len;
    memcpy(p, cfg->pass, pass_len);   p += pass_len;
    memcpy(p, cfg->code, code_len);

    size_t payload_len = 1 + 3 + ssid_len + pass_len + code_len;
    uint32_t crc = crc32_bitwise(out + 4, payload_len);
    write_u32(out + crc_off, crc);
    return true;
}

#ifndef WFMF_HOST_TEST
#include "hardware/flash.h"
#include "hardware/address_mapped.h"   // XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE
#include "pico/flash.h"                // flash_safe_execute

// The sector immediately below token_store's: that one claims the very top
// of flash (TOKEN_FLASH_OFFSET), so this one is one sector down. Nothing
// else this project puts in flash, and the disk image itself lives in
// PSRAM (psram_image.c), so the two sectors are never fought over.
#define CONFIG_FLASH_OFFSET (PICO_FLASH_SIZE_BYTES - 2 * FLASH_SECTOR_SIZE)
#define CONFIG_STORE_CAP     FLASH_PAGE_SIZE   // one program page

// Same guard as token_store's disk_is_mounted() -- see its comment there.
static bool disk_is_mounted(void) {
    return psram_active_slot() != SLOT_NONE;
}

static void do_erase(void *param) {
    (void)param;
    flash_range_erase(CONFIG_FLASH_OFFSET, FLASH_SECTOR_SIZE);
}

typedef struct { const uint8_t *data; size_t len; } program_args_t;

static void do_program(void *param) {
    program_args_t *a = param;
    flash_range_erase(CONFIG_FLASH_OFFSET, FLASH_SECTOR_SIZE);
    flash_range_program(CONFIG_FLASH_OFFSET, a->data, a->len);
}

bool config_store_load(device_config_t *out) {
    // NOTRANSLATE, never XIP_BASE: from a partitioned (A/B) boot the boot ROM
    // maps only the booted slot at XIP_BASE, and reading the top of flash
    // through it hard-faults (spec M3, measured). This window is physical
    // flash in every layout, partitioned or not.
    const uint8_t *p = (const uint8_t *)(XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE + CONFIG_FLASH_OFFSET);
    return page_load(p, CONFIG_STORE_CAP, out);
}

bool config_store_save(const device_config_t *cfg) {
    if (disk_is_mounted()) return false;

    // Static rather than a stack buffer -- see token_store_save()'s
    // comment: flash_safe_execute's callback disables interrupts and locks
    // out the other core for as short a window as possible.
    static uint8_t page[CONFIG_STORE_CAP];
    if (!page_build(page, sizeof page, cfg)) return false;

    program_args_t args = { page, sizeof page };
    if (flash_safe_execute(do_program, &args, 1000) != PICO_OK) return false;
    token_store_erase();
    return true;
}

void config_store_erase(void) {
    if (disk_is_mounted()) return;
    flash_safe_execute(do_erase, NULL, 1000);
    token_store_erase();
}

#else   // WFMF_HOST_TEST

#define CONFIG_HOST_CAP (CONFIG_HEADER_LEN + CONFIG_SSID_MAX + CONFIG_PASS_MAX + \
                          CONFIG_CODE_MAX + 4)
static uint8_t g_page[CONFIG_HOST_CAP];
static bool    g_page_init;

// Mirrors flash's power-on-erased state (all-0xFF) until the first save --
// see token_store.c's ensure_init() for why this is belt-and-braces rather
// than load-bearing.
static void ensure_init(void) {
    if (!g_page_init) {
        memset(g_page, 0xFF, sizeof g_page);
        g_page_init = true;
    }
}

bool config_store_load(device_config_t *out) {
    ensure_init();
    return page_load(g_page, sizeof g_page, out);
}

bool config_store_save(const device_config_t *cfg) {
    // Same guard as the device backing -- kept identical so a host test can
    // prove this rule holds without needing flash hardware.
    if (psram_active_slot() != SLOT_NONE) return false;
    ensure_init();
    if (!page_build(g_page, sizeof g_page, cfg)) return false;
    token_store_erase();
    return true;
}

void config_store_erase(void) {
    if (psram_active_slot() != SLOT_NONE) return;
    memset(g_page, 0xFF, sizeof g_page);
    g_page_init = true;
    token_store_erase();
}

// Test-only (declared in config_store.h, defined only here -- same pattern
// as token_store.c's token_store_test_simulate_torn_write()).
//
// Flash programs a page front-to-back: whatever hadn't been written yet
// when power was lost reads back at the erased value (0xFF); whatever had
// already been written reads back exactly as programmed. These two
// helpers pin the two shapes that matters -- interrupted DURING the magic
// word, and interrupted AFTER it -- so each has its own test whose failure
// isolates exactly one of the two defences (magic check, CRC). Review
// round 1 (Important): a single helper that corrupted the magic and also
// stomped a payload byte in one shot could not tell the two defences
// apart -- deleting the CRC comparison left that test passing for the
// wrong reason (the stomped payload byte, not the corrupted magic).
//
// Interrupted before the magic word finished landing: only the first two
// of its four bytes made it out. The rest of the page -- the remaining
// magic bytes, the length bytes, and the whole payload, crc field
// included -- is still at flash's erased value. read_u32() over bytes
// 0-3 will not equal CONFIG_MAGIC, so config_store_load() must be
// rejected by the MAGIC check, the very first thing it does, before the
// CRC (whose field is itself still 0xFF here) is ever consulted.
void config_store_test_simulate_torn_write_during_magic(void) {
    memset(g_page, 0xFF, sizeof g_page);
    g_page[0] = (uint8_t)CONFIG_MAGIC;
    g_page[1] = (uint8_t)(CONFIG_MAGIC >> 8);
    g_page_init = true;
}

// Interrupted after the magic word (and the header that follows it --
// version and the three length bytes) finished landing, but before the
// payload itself did: everything from CONFIG_HEADER_LEN onward -- the
// ssid/pass/code bytes and the crc field -- reverts to the erased value.
// The magic and length checks all pass here (there is nothing wrong with
// them), so only the CRC -- comparing the erased crc field against a
// freshly computed CRC of the now-erased payload -- can catch this.
// Assumes config_store_save() has already written a valid record.
void config_store_test_simulate_torn_write_after_magic(void) {
    ensure_init();
    if (sizeof g_page > CONFIG_HEADER_LEN) {
        memset(g_page + CONFIG_HEADER_LEN, 0xFF, sizeof g_page - CONFIG_HEADER_LEN);
    }
}

// Test-only. Leaves the magic, version, and lengths intact, and the
// payload fully written, but damages one payload byte after the fact --
// e.g. a bit flip well after the write completed, nothing to do with a
// torn write. This is the failure token_store's magic-only scheme cannot
// detect at all, and the one this store's CRC exists to catch.
void config_store_test_corrupt_payload_byte(void) {
    ensure_init();
    g_page[CONFIG_HEADER_LEN] ^= 0xFF;
}

// Review round 2 (Important). Assumes config_store_save() has already
// written a fully valid record. Flips one bit of the magic word's first
// byte and touches nothing else -- version, lengths, payload, and CRC are
// all left exactly as config_store_save() wrote them, and remain mutually
// consistent (the CRC still matches the untouched payload). The only
// thing wrong with this page is the magic word, so this is the helper
// that isolates the magic comparison: unlike the torn-write-during-magic
// case, the version byte here is still CONFIG_VERSION, so removing the
// magic check would let this record load successfully -- only removing
// the CRC comparison as well would not be enough on its own to explain
// why it was rejected in the working code, because the CRC matches.
void config_store_test_corrupt_magic(void) {
    ensure_init();
    g_page[0] ^= 0xFF;
}

#endif
