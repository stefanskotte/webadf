// See override_store.h. Same two-backing split and record discipline as
// config_store.c (magic + version + CRC-32 over version..payload):
//
//   WFMF_HOST_TEST : a static in-process buffer.
//   device build   : one dedicated flash sector, read through the NOTRANSLATE
//                    window, written with flash_safe_execute.
#include "override_store.h"
#include <stdio.h>
#include <string.h>

#define OVERRIDE_MAGIC 0x52565357u   // 'WSVR', little-endian
#define OVERRIDE_VERSION 1u

// Record layout, written as one program page:
//   magic(4) . version(1) . host_len(1) . port_lo(1) . port_hi(1) . tls(1) .
//   host[host_len] . crc32(4)
// The CRC covers version through the last host byte (not the magic).
#define OVERRIDE_HEADER_LEN 9

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

// Host characters: [A-Za-z0-9.-] only (an IPv4 literal passes).
static bool host_ok(const uint8_t *h, size_t len) {
    if (len < 1 || len > OVERRIDE_HOST_MAX) return false;
    for (size_t i = 0; i < len; i++) {
        uint8_t c = h[i];
        bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                  (c >= '0' && c <= '9') || c == '.' || c == '-';
        if (!ok) return false;
    }
    return true;
}

static bool page_load(const uint8_t *page, size_t page_len, server_override_t *out) {
    if (page_len < OVERRIDE_HEADER_LEN + 4 || read_u32(page) != OVERRIDE_MAGIC) return false;
    if (page[4] != OVERRIDE_VERSION) return false;

    size_t host_len = page[5];
    uint16_t port = (uint16_t)(page[6] | (page[7] << 8));
    uint8_t tls = page[8];
    if (!host_ok(page + OVERRIDE_HEADER_LEN, host_len > OVERRIDE_HOST_MAX ? 0 : host_len)) return false;
    if (port < 1 || tls > OVR_TLS_NOVERIFY) return false;

    size_t crc_off = OVERRIDE_HEADER_LEN + host_len;
    if (crc_off + 4 > page_len) return false;
    size_t payload_len = 1 + 1 + 2 + 1 + host_len;   // version..host
    if (crc32_bitwise(page + 4, payload_len) != read_u32(page + crc_off)) return false;

    memset(out, 0, sizeof *out);
    memcpy(out->host, page + OVERRIDE_HEADER_LEN, host_len);
    out->port = port;
    out->tls = tls;
    return true;
}

static bool page_build(uint8_t *out, size_t page_len, const server_override_t *o) {
    size_t host_len = strnlen(o->host, sizeof o->host);
    if (host_len >= sizeof o->host) return false;   // no terminator
    if (!host_ok((const uint8_t *)o->host, host_len)) return false;
    if (o->port < 1 || o->tls > OVR_TLS_NOVERIFY) return false;

    size_t crc_off = OVERRIDE_HEADER_LEN + host_len;
    if (crc_off + 4 > page_len) return false;

    memset(out, 0xFF, page_len);
    write_u32(out, OVERRIDE_MAGIC);
    out[4] = (uint8_t)OVERRIDE_VERSION;
    out[5] = (uint8_t)host_len;
    out[6] = (uint8_t)(o->port & 0xFF);
    out[7] = (uint8_t)(o->port >> 8);
    out[8] = o->tls;
    memcpy(out + OVERRIDE_HEADER_LEN, o->host, host_len);
    size_t payload_len = 1 + 1 + 2 + 1 + host_len;
    write_u32(out + crc_off, crc32_bitwise(out + 4, payload_len));
    return true;
}

#ifndef WFMF_HOST_TEST
#include "hardware/flash.h"
#include "hardware/address_mapped.h"   // XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE
#include "pico/flash.h"                // flash_safe_execute

// Sixth sector down from the end of flash (see the map in drive_store.c).
#define OVERRIDE_FLASH_OFFSET (PICO_FLASH_SIZE_BYTES - 6 * FLASH_SECTOR_SIZE)
#define OVERRIDE_STORE_CAP    FLASH_PAGE_SIZE   // one program page

static void do_erase(void *param) {
    (void)param;
    flash_range_erase(OVERRIDE_FLASH_OFFSET, FLASH_SECTOR_SIZE);
}

typedef struct { const uint8_t *data; size_t len; } program_args_t;

static void do_program(void *param) {
    program_args_t *a = param;
    flash_range_erase(OVERRIDE_FLASH_OFFSET, FLASH_SECTOR_SIZE);
    flash_range_program(OVERRIDE_FLASH_OFFSET, a->data, a->len);
}

bool override_store_load(server_override_t *out) {
    // NOTRANSLATE, never XIP_BASE: see config_store_load().
    const uint8_t *p = (const uint8_t *)(XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE + OVERRIDE_FLASH_OFFSET);
    return page_load(p, OVERRIDE_STORE_CAP, out);
}

bool override_store_save(const server_override_t *o) {
    static uint8_t page[OVERRIDE_STORE_CAP];
    if (!page_build(page, sizeof page, o)) return false;
    program_args_t args = { page, sizeof page };
    return flash_safe_execute(do_program, &args, 1000) == PICO_OK;
}

void override_store_erase(void) {
    flash_safe_execute(do_erase, NULL, 1000);
}

#else   // WFMF_HOST_TEST

#define OVERRIDE_HOST_CAP (OVERRIDE_HEADER_LEN + OVERRIDE_HOST_MAX + 4)
static uint8_t g_page[OVERRIDE_HOST_CAP];
static bool    g_page_init;

static void ensure_init(void) {
    if (!g_page_init) {
        memset(g_page, 0xFF, sizeof g_page);
        g_page_init = true;
    }
}

bool override_store_load(server_override_t *out) {
    ensure_init();
    return page_load(g_page, sizeof g_page, out);
}

bool override_store_save(const server_override_t *o) {
    ensure_init();
    return page_build(g_page, sizeof g_page, o);
}

void override_store_erase(void) {
    memset(g_page, 0xFF, sizeof g_page);
    g_page_init = true;
}

void override_store_test_corrupt_payload_byte(void) {
    ensure_init();
    g_page[OVERRIDE_HEADER_LEN] ^= 0xFF;
}

void override_store_test_corrupt_magic(void) {
    ensure_init();
    g_page[0] ^= 0xFF;
}

#endif

// ---- pure helpers (both builds) ----

void server_effective(bool loaded, const server_override_t *o, const char *default_host, server_override_t *out) {
    memset(out, 0, sizeof *out);
    if (loaded && o) { *out = *o; return; }
    snprintf(out->host, sizeof out->host, "%s", default_host);
    out->port = 443;
    out->tls = OVR_TLS_VERIFY;
}

bool server_is_custom(const server_override_t *eff, const char *default_host) {
    return strcmp(eff->host, default_host) != 0 || eff->port != 443 || eff->tls != OVR_TLS_VERIFY;
}

void server_host_header(const server_override_t *s, char *out, size_t cap) {
    if (s->port == 443) snprintf(out, cap, "%s", s->host);
    else snprintf(out, cap, "%s:%u", s->host, (unsigned)s->port);
}
