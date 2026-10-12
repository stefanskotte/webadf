/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
#ifndef PNET_STATUS_H
#define PNET_STATUS_H
/*
 * PaulaNET Phase 2: the status track on DF1's cylinder 76, side 1, which Rob's PaulaNET.device reads
 * when it opens and every 5 s after (spec 2026-10-11 §3.1). Pure; main.c streams it. Implemented from
 * the layout in his paulanetstruct.h; no code of his.
 *
 * One record: a lead-in of AA, 44 89 44 89, the 12-byte DataHeader MFM-encoded (mode 2 "config",
 * compressed 1 = RLE, the board's counters: amiga = the last batch taken, which the driver reads as
 * its acknowledgement), then the RLE of a 156-byte payload -- PaulaNETSettings (142 bytes) and
 * LiveStatus (14), big-endian:
 *     0 length 142 | 2 SSID[34] 0 | 36 password[66] 0 | 102 hostname[34] 0 | 136 flags 3
 *   138 maxTxSize 8192 (the Amiga's batch budget) | 140 maxRxSize 16128
 *   142 length 14 | 144 version major, minor | 146 MAC[6] | 152 RSSI (int16) | 154 link | 155 0
 * The track repeats the record every PNET_STATUS_PERIOD bytes, so a read that starts at any bit finds
 * a sync STARTING within its first 124 bytes, inside the driver's scan, with no start timing at all.
 */
#include <stdint.h>
#include <stddef.h>
#include "pnet_frame.h"

#define PNET_CYL_STATUS         76
#define PNET_TRACK_STATUS       (PNET_CYL_STATUS * 2 + 1)   /* 153: side 1, the Amiga reads */
#define PNET_MODE_CONFIG        2u
#define PNET_COMPRESSED_RLE     1u
#define PNET_STATUS_BYTES       156u
#define PNET_STATUS_RLE_MAX     160u     /* >= pnet_rle_bound(156) = 159, even */
#define PNET_STATUS_PERIOD      124u     /* one record's start to the next; a multiple of 4 */
#define PNET_STATUS_RECORDS     8u
#define PNET_STATUS_LOOP_BYTES  (PNET_STATUS_PERIOD * PNET_STATUS_RECORDS)   /* 992: what DF1 loops */
#define PNET_STATUS_MIN_LEAD    16u      /* AA bytes before each sync, at the least */

/* The payload's fields (his paulanetstruct.h). */
#define PNET_ST_LENGTH          0u
#define PNET_ST_FLAGS           136u
#define PNET_ST_MAX_TX          138u
#define PNET_ST_MAX_RX          140u
#define PNET_ST_LIVE            142u
#define PNET_ST_VERSION         144u
#define PNET_ST_MAC             146u
#define PNET_ST_RSSI            152u
#define PNET_ST_LINK            154u
#define PNET_ST_SETTINGS_BYTES  142u
#define PNET_ST_LIVE_BYTES      14u
#define PNET_ST_FLAGS_RLE_BOTH  3u       /* bit 1: the Amiga sends RLE; bit 0: so does the board */
#define PNET_ST_MAX_TX_BYTES    8192u    /* never 0 or small: the driver's 16-bit space sum would wrap */
#define PNET_LINK_DOWN          0u
#define PNET_LINK_NOIP          2u       /* associated; the driver counts 1, 2, 3 and 5 as online */

typedef struct {
    uint8_t mac[6];
    int16_t rssi;                        /* dBm; 0 = not known */
    uint8_t link;                        /* PNET_LINK_* */
    uint8_t ver_major, ver_minor;
} pnet_status_t;

/* The 156-byte payload. SSID, password and hostname are always zeros. */
void pnet_status_payload(const pnet_status_t *st, uint8_t out[PNET_STATUS_BYTES]);
/* What DF1 loops: PNET_STATUS_RECORDS copies of the record, PNET_STATUS_PERIOD bytes apart, at out.
 * Returns PNET_STATUS_LOOP_BYTES, or 0 if cap is smaller or a record would leave under
 * PNET_STATUS_MIN_LEAD bytes of lead-in (it cannot: the payload's RLE is about 30 bytes). */
size_t pnet_build_status(uint8_t *out, size_t cap, uint8_t amiga_ctr, uint8_t pico_ctr,
                         const pnet_status_t *st);
/* Major and minor from "M.m[.p][+...]" (WF_FIRMWARE_VERSION); 0, 0 when unreadable. */
void pnet_version_bytes(const char *v, uint8_t *major, uint8_t *minor);
#endif
