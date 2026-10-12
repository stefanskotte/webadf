/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
#include "harness.h"
#include "../src/pnet_status.h"
#include "../src/pnet_mfm.h"
#include <stdint.h>
#include <string.h>

/* Cylinder 76's status track, as PaulaNET's driver reads it (spec 2026-10-11 §3.1). */

static const pnet_status_t BENCH = { {0x28, 0xcd, 0xc1, 0x19, 0x6a, 0x38}, -55, 2, 1, 10 };

/* The spec's table, byte for byte, written from the table and not from pnet_status.h. */
static void expected(uint8_t e[156]) {
    memset(e, 0, 156);
    e[0] = 0x00; e[1] = 142;                  /* PaulaNETSettings.length */
    /* 2..135: SSID[34], password[66], hostname[34]: zeros */
    e[136] = 0x00; e[137] = 0x03;             /* flags: RLE both ways */
    e[138] = 0x20; e[139] = 0x00;             /* maxTxSize 8,192 */
    e[140] = 0x3F; e[141] = 0x00;             /* maxRxSize 16,128 */
    e[142] = 0x00; e[143] = 14;               /* LiveStatus.length */
    e[144] = 1; e[145] = 10;                  /* version 1.10 */
    e[146] = 0x28; e[147] = 0xcd; e[148] = 0xc1; e[149] = 0x19; e[150] = 0x6a; e[151] = 0x38;
    e[152] = 0xFF; e[153] = 0xC9;             /* RSSI -55, big-endian */
    e[154] = 2;                               /* link: associated (the driver: online) */
    e[155] = 0;                               /* reserved */
}

static void the_record_is_robs_layout_byte_for_byte(void) {
    uint8_t p[PNET_STATUS_BYTES], e[156];
    pnet_status_payload(&BENCH, p);
    expected(e);
    CHECK(memcmp(p, e, 156) == 0, "the payload");
    for (unsigned i = 0; i < 156; i++)
        if (p[i] != e[i]) { printf("  first difference at byte %u: %02x, want %02x\n", i, p[i], e[i]); break; }
}

/* A 1,024-byte read starting `bit` bits into the looping track, as Paula's DMA sees it. */
static void read_from(const uint8_t *loop, size_t bit, uint8_t *rd, size_t n) {
    for (size_t i = 0; i < n; i++) {
        const size_t b = bit / 8u + i;
        const unsigned k = (unsigned)(bit % 8u);
        const uint8_t hi = loop[b % PNET_STATUS_LOOP_BYTES], lo = loop[(b + 1u) % PNET_STATUS_LOOP_BYTES];
        rd[i] = k ? (uint8_t)((hi << k) | (lo >> (8u - k))) : hi;
    }
}

static void every_start_finds_a_record_within_124_bytes(void) {
    static uint8_t loop[PNET_STATUS_LOOP_BYTES], rd[1024];
    CHECK_EQ_INT(pnet_build_status(loop, sizeof loop, 0x37, 0x81, &BENCH), PNET_STATUS_LOOP_BYTES);
    uint8_t e[156], pay[PNET_STATUS_BYTES];
    expected(e);
    unsigned ok = 0, tried = 0;
    for (size_t bit = 0; bit < PNET_STATUS_LOOP_BYTES * 8u; bit += 3u) {   /* every byte, several bits */
        tried++;
        read_from(loop, bit, rd, sizeof rd);
        const long off = pnet_find_sync(rd, sizeof rd, 124);
        if (off < 0) continue;
        const size_t valid = pnet_shift_left(rd, sizeof rd, (size_t)off);
        pnet_hdr_t h;
        if (pnet_parse_hdr_to_amiga_as(rd, valid, &h, true, PNET_MODE_CONFIG) != PNET_OK) continue;
        if (h.data_size != 156 || h.compressed != 1 || h.amiga_ctr != 0x37 || h.pico_ctr != 0x81) continue;
        if (pnet_rle_decode(rd + PNET_HDR_MFM_BYTES, h.compressed_size, pay, sizeof pay) != 156) continue;
        if (memcmp(pay, e, 156) == 0) ok++;
    }
    CHECK_EQ_INT(ok, tried);
    pnet_hdr_t h;
    read_from(loop, 0, rd, sizeof rd);
    const long off = pnet_find_sync(rd, sizeof rd, 124);
    CHECK(off > 0, "a read from the loop's start");
    (void)pnet_shift_left(rd, sizeof rd, (size_t)off);
    CHECK_EQ_INT(pnet_parse_hdr_to_amiga(rd, sizeof rd, &h, false), PNET_E_MODE);   /* never mistaken for 77 */
}

static void the_lead_in_never_runs_short(void) {
    static const pnet_status_t odd[4] = {
        { {0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa}, -1, 2, 255, 255 },
        { {0x00, 0x00, 0x00, 0x00, 0x00, 0x00}, 0, 0, 0, 0 },
        { {0x01, 0x23, 0x45, 0x67, 0x89, 0xab}, 32767, 2, 1, 10 },
        { {0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55}, -32768, 0, 9, 99 },
    };
    static uint8_t loop[PNET_STATUS_LOOP_BYTES];
    for (unsigned i = 0; i < 4; i++) {
        CHECK_EQ_INT(pnet_build_status(loop, sizeof loop, 0, 0, &odd[i]), PNET_STATUS_LOOP_BYTES);
        unsigned lead = 0;
        while (lead < PNET_STATUS_PERIOD && loop[lead] == 0xAA) lead++;
        CHECK(lead >= PNET_STATUS_MIN_LEAD, "a lead-in of at least PNET_STATUS_MIN_LEAD bytes");
        CHECK(memcmp(loop, loop + PNET_STATUS_PERIOD, PNET_STATUS_PERIOD) == 0, "every record the same");
    }
    CHECK_EQ_INT(pnet_build_status(loop, sizeof loop - 1u, 0, 0, &BENCH), 0);   /* too small a buffer */
}

static void version_bytes_come_from_the_version_string(void) {
    uint8_t a = 9, b = 9;
    pnet_version_bytes("1.10.2+g74c2b2e", &a, &b);
    CHECK(a == 1 && b == 10, "1.10.2+g...");
    pnet_version_bytes("2.0", &a, &b);
    CHECK(a == 2 && b == 0, "2.0");
    pnet_version_bytes("1.x", &a, &b);
    CHECK(a == 0 && b == 0, "unreadable: 0.0");
    pnet_version_bytes("256.1.0", &a, &b);
    CHECK(a == 0 && b == 0, "over a byte: 0.0");
    pnet_version_bytes("", &a, &b);
    CHECK(a == 0 && b == 0, "empty: 0.0");
}

int main(void) {
    RUN(the_record_is_robs_layout_byte_for_byte);
    RUN(every_start_finds_a_record_within_124_bytes);
    RUN(the_lead_in_never_runs_short);
    RUN(version_bytes_come_from_the_version_string);
    return REPORT();
}
