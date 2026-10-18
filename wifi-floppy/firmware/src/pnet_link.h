/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
#ifndef PNET_LINK_H
#define PNET_LINK_H
/*
 * PaulaNET Phase 1: the counter/acknowledge rule for real frames (Phase 0's pnet_loop.h has it for
 * the echo). Pure; core0 acts (main.c). Implemented from the protocol's description; no code of his.
 *
 * Each side bumps its own 8-bit counter per new batch and echoes the other's.
 *  - The Amiga's batch: new when its amiga counter differs from the last one taken. A new batch is
 *    ALWAYS taken (Phase 2, spec 2026-10-11 §3.2): its counter becomes the last taken, so the next
 *    header acknowledges it, and its frames go into the TX ring while the ring has room. Frames that
 *    do not fit, and a malformed frame with every frame after it, are dropped and counted. Rob's own
 *    board drops on a full queue too, TCP resends, and a batch never acknowledged is resent by his
 *    driver forever, which locks its sending up. (Phase 1 refused a batch the ring could not hold.)
 *  - Our batch: the first `nframes` frames of the RX ring, built under counter `pico`. It stays out
 *    -- rebuilt unchanged whenever DF1's buffer is rebuilt -- until an Amiga header echoes `pico`;
 *    only then do its frames leave the ring (main.c drops them) and may a new batch start.
 *  - An empty batch (nothing waiting) does not move `pico`.
 */
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include "pnet_frame.h"
#include "pnet_ring.h"
#include "pnet_loop.h"

#define PNET_CANRECEIVE   1u
#define PNET_OTA_QUIET_MS 10000u

typedef enum { PNET_TAKE_NEW, PNET_TAKE_DUP } pnet_take_t;

typedef struct {
    uint8_t  last_amiga, pico;
    bool     backup;
    uint8_t  nframes;
    uint32_t fresh, dup, acked;
    uint32_t queued;      /* the Amiga's frames into the TX ring */
    uint32_t over;        /* ...dropped: the ring was full */
    uint32_t malformed;   /* ...dropped: a malformed frame, and every frame after it in its batch */
    uint32_t lz4_in;      /* LZ4 (spec 2026-10-18): the Amiga's frames that came LZ4 */
    uint32_t lz4_bad;     /* ...refused, a bad size word included, counted in malformed too */
    bool     amiga_lz4;   /* the latest checked header from the Amiga carried PNET_DRIVER_LZ4 (a resend's counts) */
} pnet_link_t;

void pnet_link_init(pnet_link_t *s);
/* The acknowledgement in a valid Amiga header: the number of frames it frees (0 if none). */
unsigned pnet_link_ack(pnet_link_t *s, const pnet_hdr_t *h);
bool pnet_link_is_new(const pnet_link_t *s, const pnet_hdr_t *h);
/* The Amiga's batch, its header already checked (pnet_parse_hdr_from_amiga); `payload` is its
 * h->compressed_size bytes. DUP (counted, nothing queued) when its counter is the last taken;
 * otherwise NEW, always -- see above. Never claims a slot the ring does not have. Every header, a resend's too,
 * sets amiga_lz4 from its PNET_DRIVER_LZ4 bit (spec 2026-10-18 §3). pnet_link_take is pnet_link_take_lz4 with no
 * window: LZ4 frames are then unreadable. */
pnet_take_t pnet_link_take(pnet_link_t *s, const pnet_hdr_t *h, const uint8_t *payload, pnet_ring_t *tx);
/* As pnet_link_take, LZ4-aware: a batch carrying PNET_DRIVER_LZ4 is decoded frame by frame into win
 * (PNET_LZ4_WINDOW bytes) at even offsets (pnet_lz4.h), its LZ4 frames linked to the earlier ones, and each frame copied into its
 * slot; scratch (PNET_LZ4_BLOCK_MAX bytes) takes an MFM-wrapped block. A batch without the bit decodes as before. */
pnet_take_t pnet_link_take_lz4(pnet_link_t *s, const pnet_hdr_t *h, const uint8_t *payload, pnet_ring_t *tx,
                               uint8_t *win, uint8_t *scratch);
/* The batch out holds n frames from now on, n below nframes only (never more, never 0): its rebuild without LZ4
 * (the driver stopped asking) fits fewer; the rest stay in the ring for the next batch. */
void pnet_link_shrink(pnet_link_t *s, unsigned n);
/* How many of the first `avail` waiting frames (lengths lens[]) one batch to the Amiga holds: within
 * `cap` bytes on the wire (pnet_to_amiga_bound) and PNET_TO_AMIGA_MAX_PAYLOAD bytes of payload
 * (pnet_payload_bound), at most PNET_MAX_FRAMES. The rest stay in the ring for the next batch.
 * main.c packs with pnet_pack (LZ4, 1.16.0); without LZ4 that picks the same count (test_pnet_pack.c). */
unsigned pnet_link_fit(const uint16_t *lens, unsigned avail, size_t cap);
/* A new batch of n frames goes out: pico moves on. No-op for n == 0 or while one is out. */
void pnet_link_start(pnet_link_t *s, unsigned n);
/* The OTA rule for Network mode: cylinder 77 quiet for PNET_OTA_QUIET_MS (last_ms 0 = never
 * active) and nothing queued for the radio. */
bool pnet_ota_quiet(uint32_t now_ms, uint32_t last_ms, bool tx_pending);
/* What DF1 streams in an L2 build (Phase 2): cylinder 76 side 1 is the status track (pnet_status.h),
 * side 0 nothing -- the driver never reads it, and a disk track there would overwrite the batch
 * prepared in DF1's buffer every 5 s -- and every other track as pnet_df1_for_track. */
pnet_df1_t pnet_df1_for_track_l2(int want);
#endif
