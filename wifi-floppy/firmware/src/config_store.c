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

// ---------------------------------------------------------------- several networks
//
// Field report 2026-11-14: the board now keeps up to CONFIG_NETS_MAX
// networks. The record grew WITHOUT changing the layout above, which stays
// page 0 of the record byte for byte, version byte still 1:
//
//   page 0 (256 B)  the single-network record above, holding the network
//                   LAST JOINED (net[last]) and the pairing code.
//   pages 1-2       an extension: the other networks and where page 0's
//                   network sits in the saved order. Absent (erased) when
//                   only one network is saved.
//
//   ext: magic 'WFCN'(4) . ext_version(1) . n(1) . last(1) . page0_crc(4) .
//        { ssid_len(1) . pass_len(1) . ssid . pass } x (n - 1) . crc32(4)
//   The CRC covers ext_version through the last network byte; page0_crc is
//   the CRC stored in page 0, so an extension is only ever combined with the
//   page 0 it was written with.
//
// Why this shape rather than a version-2 record:
//   * A board in the field holds exactly page 0 today. It loads unchanged --
//     the "migration" is that nothing has to move, so a firmware update can
//     never lose its network, and no flash write happens at boot to convert
//     it (a power cut mid-conversion would lose the network AND the code).
//   * An older firmware reads only page 0 (it programs one page and loads
//     one page). After a rollback -- an OTA trial that never confirms boots
//     the old slot again -- it still finds a valid record: the last-joined
//     network and the code, and the token in its own sector. Only the extra
//     networks are invisible to it; its next save erases them (it erases the
//     sector and programs page 0 only), which this firmware then reads as one
//     network.
//   * Flash programs page by page, so a write torn after page 0 leaves page 0
//     whole and the extension invalid: this loads as the one last-joined
//     network, the code and the token intact. Degraded, never lost.
#define CONFIG_PAGE      CONFIG_STORE_PAGE_BYTES
#define CONFIG_EXT_MAGIC 0x4E434657u   // 'WFCN', little-endian
#define CONFIG_EXT_VERSION 1u
#define CONFIG_EXT_HEADER_LEN 11       // magic(4) + ext_version(1) + n(1) + last(1) + page0_crc(4)

_Static_assert(CONFIG_EXT_HEADER_LEN + (CONFIG_NETS_MAX - 1) * (2 + CONFIG_SSID_MAX + CONFIG_PASS_MAX) + 4
                   <= CONFIG_STORE_RECORD_BYTES - CONFIG_PAGE, "the extension fits pages 1-2");
_Static_assert(CONFIG_HEADER_LEN + CONFIG_SSID_MAX + CONFIG_PASS_MAX + CONFIG_CODE_MAX + 4 <= CONFIG_PAGE,
               "the single-network record fits page 0");

// Reads page 0 per the single-network layout above. False if the magic
// doesn't match (covers both "never written" and "torn write" -- see
// token_store.c's page_load() for the identical argument), if the stored
// lengths don't fit the field maximums or the page itself (a defensive
// bounds check so a corrupted length byte can never walk the CRC check off
// the end of the page), or if the CRC doesn't match what's actually there.
// On success *net and code hold the record and *crc_out its stored CRC.
static bool page_load(const uint8_t *page, size_t page_len, wifi_net_t *net,
                      char code[CONFIG_CODE_MAX + 1], uint32_t *crc_out) {
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

    memset(net, 0, sizeof *net);
    memset(code, 0, CONFIG_CODE_MAX + 1);
    const uint8_t *p = page + CONFIG_HEADER_LEN;
    memcpy(net->ssid, p, ssid_len);           p += ssid_len;
    memcpy(net->pass, p, pass_len);           p += pass_len;
    memcpy(code, p, code_len);
    *crc_out = want;
    return true;
}

// Builds page 0 (size page_len) for one network and the code into `out`.
// False -- and `out` left untouched -- if a field has no NUL terminator
// within its array (the one way a fixed-size field could still be "over
// length") or the record doesn't fit the page. *crc_out: the CRC written.
static bool page_build(uint8_t *out, size_t page_len, const wifi_net_t *net,
                       const char *code_field, size_t code_cap, uint32_t *crc_out) {
    size_t ssid_len = strnlen(net->ssid, sizeof net->ssid);
    size_t pass_len = strnlen(net->pass, sizeof net->pass);
    size_t code_len = strnlen(code_field, code_cap);
    if (ssid_len >= sizeof net->ssid || pass_len >= sizeof net->pass ||
        code_len >= code_cap) {
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
    memcpy(p, net->ssid, ssid_len);   p += ssid_len;
    memcpy(p, net->pass, pass_len);   p += pass_len;
    memcpy(p, code_field, code_len);

    size_t payload_len = 1 + 3 + ssid_len + pass_len + code_len;
    uint32_t crc = crc32_bitwise(out + 4, payload_len);
    write_u32(out + crc_off, crc);
    *crc_out = crc;
    return true;
}

// The extension (pages 1-2). False when absent or invalid in any way; `out`
// is then left exactly as page 0 made it (one network). Validates every byte
// before copying any, and uses no buffer of its own: config_store_load is also
// called on core0 (2 KB stack), and from either core, so no shared static.
static bool ext_load(const uint8_t *ext, size_t len, uint32_t page0_crc, device_config_t *out) {
    if (len < CONFIG_EXT_HEADER_LEN + 4 || read_u32(ext) != CONFIG_EXT_MAGIC) return false;
    if (ext[4] != CONFIG_EXT_VERSION) return false;
    int n = ext[5], last = ext[6];
    if (n < 2 || n > CONFIG_NETS_MAX || last >= n) return false;
    if (read_u32(ext + 7) != page0_crc) return false;   // written with a different page 0

    size_t off = CONFIG_EXT_HEADER_LEN;
    for (int i = 0; i < n - 1; i++) {
        if (off + 2 > len) return false;
        size_t sl = ext[off], pl = ext[off + 1];
        if (sl > CONFIG_SSID_MAX || pl > CONFIG_PASS_MAX) return false;
        off += 2 + sl + pl;
        if (off + 4 > len) return false;
    }
    if (read_u32(ext + off) != crc32_bitwise(ext + 4, off - 4)) return false;

    // Valid. Page 0's network moves to position `last`; the others fill the
    // rest in order.
    out->net[last] = out->net[0];
    off = CONFIG_EXT_HEADER_LEN;
    for (int i = 0; i < n; i++) {
        if (i == last) continue;
        size_t sl = ext[off], pl = ext[off + 1];
        off += 2;
        memset(&out->net[i], 0, sizeof out->net[i]);
        memcpy(out->net[i].ssid, ext + off, sl);   off += sl;
        memcpy(out->net[i].pass, ext + off, pl);   off += pl;
    }
    out->n_nets = n;
    out->last = last;
    return true;
}

// Builds the extension for cfg into ext[0..len). False on an over-length field.
static bool ext_build(uint8_t *ext, size_t len, const device_config_t *cfg, uint32_t page0_crc) {
    memset(ext, 0xFF, len);
    if (cfg->n_nets < 2) return true;   // one network: no extension, pages 1-2 stay erased
    write_u32(ext, CONFIG_EXT_MAGIC);
    ext[4] = (uint8_t)CONFIG_EXT_VERSION;
    ext[5] = (uint8_t)cfg->n_nets;
    ext[6] = (uint8_t)cfg->last;
    write_u32(ext + 7, page0_crc);
    size_t off = CONFIG_EXT_HEADER_LEN;
    for (int i = 0; i < cfg->n_nets; i++) {
        if (i == cfg->last) continue;
        const wifi_net_t *w = &cfg->net[i];
        size_t sl = strnlen(w->ssid, sizeof w->ssid), pl = strnlen(w->pass, sizeof w->pass);
        if (sl >= sizeof w->ssid || pl >= sizeof w->pass) return false;
        if (off + 2 + sl + pl + 4 > len) return false;
        ext[off++] = (uint8_t)sl;
        ext[off++] = (uint8_t)pl;
        memcpy(ext + off, w->ssid, sl);   off += sl;
        memcpy(ext + off, w->pass, pl);   off += pl;
    }
    write_u32(ext + off, crc32_bitwise(ext + 4, off - 4));
    return true;
}

// Fills *out only on success (out is untouched when nothing valid is stored:
// page_load writes only after its CRC check passed).
static bool record_load(const uint8_t *rec, size_t len, device_config_t *out) {
    uint32_t crc0 = 0;
    if (len < CONFIG_PAGE || !page_load(rec, CONFIG_PAGE, &out->net[0], out->code, &crc0)) return false;
    for (int i = 1; i < CONFIG_NETS_MAX; i++) memset(&out->net[i], 0, sizeof out->net[i]);
    out->n_nets = 1;
    out->last = 0;
    (void)ext_load(rec + CONFIG_PAGE, len - CONFIG_PAGE, crc0, out);   // absent/invalid: one network
    return true;
}

// The whole record (len = CONFIG_STORE_RECORD_BYTES) for cfg. False -- out
// then undefined, nothing written by the callers -- on no network, an
// out-of-range `last`, or an over-length field.
static bool record_build(uint8_t *rec, size_t len, const device_config_t *cfg) {
    if (len < CONFIG_STORE_RECORD_BYTES) return false;
    if (cfg->n_nets < 1 || cfg->n_nets > CONFIG_NETS_MAX) return false;
    if (cfg->last < 0 || cfg->last >= cfg->n_nets) return false;
    uint32_t crc0 = 0;
    if (!page_build(rec, CONFIG_PAGE, &cfg->net[cfg->last], cfg->code, sizeof cfg->code, &crc0))
        return false;
    return ext_build(rec + CONFIG_PAGE, len - CONFIG_PAGE, cfg, crc0);
}

// ---------------------------------------------------------------- the list, pure

int config_find_net(const device_config_t *cfg, const char *ssid) {
    if (!cfg || !ssid) return -1;
    for (int i = 0; i < cfg->n_nets && i < CONFIG_NETS_MAX; i++)
        if (strcmp(cfg->net[i].ssid, ssid) == 0) return i;
    return -1;
}

int config_add_net(device_config_t *cfg, const char *ssid, const char *pass) {
    if (!cfg || !ssid || !pass || !*ssid) return -1;
    if (strlen(ssid) > CONFIG_SSID_MAX || strlen(pass) > CONFIG_PASS_MAX) return -1;
    int i = config_find_net(cfg, ssid);
    if (i < 0) {
        if (cfg->n_nets >= CONFIG_NETS_MAX) return -1;   // full: refuse, never drop one
        if (cfg->n_nets < 0) cfg->n_nets = 0;
        i = cfg->n_nets++;
        memset(&cfg->net[i], 0, sizeof cfg->net[i]);
        memcpy(cfg->net[i].ssid, ssid, strlen(ssid));
    }
    memset(cfg->net[i].pass, 0, sizeof cfg->net[i].pass);
    memcpy(cfg->net[i].pass, pass, strlen(pass));
    return i;
}

bool config_remove_net(device_config_t *cfg, int idx) {
    if (!cfg || idx < 0 || idx >= cfg->n_nets) return false;
    for (int i = idx; i < cfg->n_nets - 1; i++) cfg->net[i] = cfg->net[i + 1];
    cfg->n_nets--;
    memset(&cfg->net[cfg->n_nets], 0, sizeof cfg->net[cfg->n_nets]);
    if (cfg->last == idx) cfg->last = 0;
    else if (cfg->last > idx) cfg->last--;
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
#define CONFIG_STORE_CAP     CONFIG_STORE_RECORD_BYTES   // three program pages (see above)
_Static_assert(CONFIG_STORE_PAGE_BYTES == FLASH_PAGE_SIZE, "page 0 is one program page");
_Static_assert(CONFIG_STORE_CAP % FLASH_PAGE_SIZE == 0 && CONFIG_STORE_CAP <= FLASH_SECTOR_SIZE,
               "whole pages, inside the config sector");

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
    return record_load(p, CONFIG_STORE_CAP, out);
}

static bool store_write(const device_config_t *cfg) {
    if (disk_is_mounted()) return false;

    // Static rather than a stack buffer -- see token_store_save()'s
    // comment: flash_safe_execute's callback disables interrupts and locks
    // out the other core for as short a window as possible. 768 B: never
    // on a stack (core0's is 2 KB).
    static uint8_t page[CONFIG_STORE_CAP];
    if (!record_build(page, sizeof page, cfg)) return false;

    program_args_t args = { page, sizeof page };
    return flash_safe_execute(do_program, &args, 1000) == PICO_OK;
}

bool config_store_save(const device_config_t *cfg) {
    if (!store_write(cfg)) return false;
    token_store_erase();
    return true;
}

bool config_store_update(const device_config_t *cfg) {
    return store_write(cfg);
}

void config_store_erase(void) {
    if (disk_is_mounted()) return;
    flash_safe_execute(do_erase, NULL, 1000);
    token_store_erase();
}

#else   // WFMF_HOST_TEST

#define CONFIG_HOST_CAP CONFIG_STORE_RECORD_BYTES   // the device record, byte for byte
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
    return record_load(g_page, sizeof g_page, out);
}

static bool store_write(const device_config_t *cfg) {
    // Same guard as the device backing -- kept identical so a host test can
    // prove this rule holds without needing flash hardware.
    if (psram_active_slot() != SLOT_NONE) return false;
    ensure_init();
    static uint8_t rec[CONFIG_HOST_CAP];
    if (!record_build(rec, sizeof rec, cfg)) return false;   // nothing written on failure
    memcpy(g_page, rec, sizeof g_page);
    return true;
}

bool config_store_save(const device_config_t *cfg) {
    if (!store_write(cfg)) return false;
    token_store_erase();
    return true;
}

bool config_store_update(const device_config_t *cfg) {
    return store_write(cfg);
}

void config_store_test_write_raw(const unsigned char *bytes, int len) {
    memset(g_page, 0xFF, sizeof g_page);
    if (len > (int)sizeof g_page) len = (int)sizeof g_page;
    if (len > 0) memcpy(g_page, bytes, (size_t)len);
    g_page_init = true;
}

const unsigned char *config_store_test_raw(void) {
    ensure_init();
    return g_page;
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
