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
 *  - The Amiga's batch: new when its amiga counter differs from the last one taken. Taken only if
 *    the TX ring holds ALL its frames -- otherwise not taken at all, so its counter goes
 *    unacknowledged and the Amiga resends it (no frame goes out half or twice).
 *  - Our batch: the first `nframes` frames of the RX ring, built under counter `pico`. It stays out
 *    -- rebuilt unchanged whenever DF1's buffer is rebuilt -- until an Amiga header echoes `pico`;
 *    only then do its frames leave the ring (main.c drops them) and may a new batch start.
 *  - An empty batch (nothing waiting) does not move `pico`.
 */
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include "pnet_frame.h"

#define PNET_CANRECEIVE   1u
#define PNET_OTA_QUIET_MS 10000u

typedef enum { PNET_TAKE_NEW, PNET_TAKE_DUP, PNET_TAKE_FULL } pnet_take_t;

typedef struct {
    uint8_t  last_amiga, pico;
    bool     backup;
    uint8_t  nframes;
    uint32_t fresh, dup, txfull, acked;
} pnet_link_t;

void pnet_link_init(pnet_link_t *s);
/* The acknowledgement in a valid Amiga header: the number of frames it frees (0 if none). */
unsigned pnet_link_ack(pnet_link_t *s, const pnet_hdr_t *h);
bool pnet_link_is_new(const pnet_link_t *s, const pnet_hdr_t *h);
/* A parsed Amiga batch of n frames: NEW (the caller queues the frames), DUP, or FULL (n > tx_space:
 * not taken). Counts each. */
pnet_take_t pnet_link_take(pnet_link_t *s, const pnet_hdr_t *h, unsigned n, uint32_t tx_space);
/* How many of the first `avail` waiting frames (lengths lens[]) one batch to the Amiga holds within
 * `cap` bytes on the wire (pnet_to_amiga_bound), at most PNET_MAX_FRAMES. */
unsigned pnet_link_fit(const uint16_t *lens, unsigned avail, size_t cap);
/* A new batch of n frames goes out: pico moves on. No-op for n == 0 or while one is out. */
void pnet_link_start(pnet_link_t *s, unsigned n);
/* The OTA rule for Network mode: cylinder 77 quiet for PNET_OTA_QUIET_MS (last_ms 0 = never
 * active) and nothing queued for the radio. */
bool pnet_ota_quiet(uint32_t now_ms, uint32_t last_ms, bool tx_pending);
#endif
