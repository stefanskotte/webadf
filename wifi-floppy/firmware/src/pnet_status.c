/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
/* Implemented from the layout in his paulanetstruct.h; no code of his (see pnet_status.h). */
#include "pnet_status.h"
#include "pnet_mfm.h"
#include <string.h>

_Static_assert(PNET_STATUS_RLE_MAX >= PNET_STATUS_BYTES + PNET_STATUS_BYTES / 127u + 2u,
               "the record's RLE fits its buffer (pnet_rle_bound)");
_Static_assert(PNET_STATUS_PERIOD % 4u == 0u, "records start on DMA words");

static void put16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)(v >> 8); p[1] = (uint8_t)v; }

void pnet_status_payload(const pnet_status_t *st, uint8_t out[PNET_STATUS_BYTES]) {
    memset(out, 0, PNET_STATUS_BYTES);
    put16(out + PNET_ST_LENGTH, PNET_ST_SETTINGS_BYTES);
    put16(out + PNET_ST_FLAGS, PNET_ST_FLAGS_RLE_BOTH);
    put16(out + PNET_ST_MAX_TX, PNET_ST_MAX_TX_BYTES);
    put16(out + PNET_ST_MAX_RX, PNET_TO_AMIGA_MAX_PAYLOAD);
    put16(out + PNET_ST_LIVE, PNET_ST_LIVE_BYTES);
    out[PNET_ST_VERSION] = st->ver_major;
    out[PNET_ST_VERSION + 1u] = st->ver_minor;
    memcpy(out + PNET_ST_MAC, st->mac, 6);
    put16(out + PNET_ST_RSSI, (uint16_t)st->rssi);
    out[PNET_ST_LINK] = st->link;
}

size_t pnet_build_status(uint8_t *out, size_t cap, uint8_t amiga_ctr, uint8_t pico_ctr,
                         const pnet_status_t *st) {
    if (cap < PNET_STATUS_LOOP_BYTES) return 0;
    uint8_t raw[PNET_STATUS_BYTES], rle[PNET_STATUS_RLE_MAX];
    pnet_status_payload(st, raw);
    const size_t r = pnet_rle_encode(raw, sizeof raw, rle);              /* even: padded */
    const size_t body = 4u + PNET_HDR_MFM_BYTES + r;
    if (body + PNET_STATUS_MIN_LEAD > PNET_STATUS_PERIOD) return 0;
    const size_t lead = PNET_STATUS_PERIOD - body;
    const pnet_hdr_t h = {
        .checksum = pnet_checksum(rle, r), .data_size = PNET_STATUS_BYTES, .compressed_size = (uint16_t)r,
        .mode = PNET_MODE_CONFIG, .compressed = PNET_COMPRESSED_RLE, .amiga_ctr = amiga_ctr, .pico_ctr = pico_ctr,
    };
    memset(out, 0xAA, lead);
    pnet_put_hdr_to_amiga(out + lead, &h);
    memcpy(out + lead + 4u + PNET_HDR_MFM_BYTES, rle, r);
    for (unsigned i = 1; i < PNET_STATUS_RECORDS; i++)
        memcpy(out + (size_t)i * PNET_STATUS_PERIOD, out, PNET_STATUS_PERIOD);
    return PNET_STATUS_LOOP_BYTES;
}

/* Decimal digits at *p, at most 255: their value (and *p moved past them), or -1. */
static int number(const char **p) {
    int v = -1;
    while (**p >= '0' && **p <= '9') {
        v = (v < 0 ? 0 : v) * 10 + (**p - '0');
        if (v > 255) return -1;
        (*p)++;
    }
    return v;
}

void pnet_version_bytes(const char *v, uint8_t *major, uint8_t *minor) {
    *major = *minor = 0;
    const int a = number(&v);
    if (a < 0 || *v != '.') return;
    v++;
    const int b = number(&v);
    if (b < 0 || (*v != '.' && *v != '+' && *v != '\0')) return;
    *major = (uint8_t)a;
    *minor = (uint8_t)b;
}
