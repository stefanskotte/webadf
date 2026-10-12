/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
/* Implemented from the protocol's description; no code of his (see pnet_link.h). */
#include "pnet_link.h"
#include "pnet_status.h"
#include <string.h>

void pnet_link_init(pnet_link_t *s) {
    memset(s, 0, sizeof *s);
    s->last_amiga = 0xFFu;
    s->pico = 0x7Fu;
}

unsigned pnet_link_ack(pnet_link_t *s, const pnet_hdr_t *h) {
    if (!s->backup || h->pico_ctr != s->pico) return 0;
    const unsigned n = s->nframes;
    s->backup = false;
    s->nframes = 0;
    s->acked++;
    return n;
}

bool pnet_link_is_new(const pnet_link_t *s, const pnet_hdr_t *h) { return h->amiga_ctr != s->last_amiga; }

pnet_take_t pnet_link_take(pnet_link_t *s, const pnet_hdr_t *h, const uint8_t *payload, pnet_ring_t *tx) {
    if (!pnet_link_is_new(s, h)) { s->dup++; return PNET_TAKE_DUP; }
    s->last_amiga = h->amiga_ctr;
    s->fresh++;
    pnet_frame_iter_t it;
    if (pnet_frame_iter_init(&it, payload, h->compressed_size, PNET_TO_BOARD) != PNET_OK) {
        s->malformed++;                                 /* a 1..3-byte payload: one unreadable frame */
        return PNET_TAKE_NEW;
    }
    while (it.i < it.count) {
        if (pnet_ring_space(tx) == 0u) { s->over += it.count - it.i; break; }
        uint8_t *slot = pnet_ring_claim(tx);
        uint16_t len = 0;
        if (pnet_frame_iter_next(&it, slot, PNET_RING_MTU, &len) != PNET_OK) {
            s->malformed += it.count - it.i;            /* this frame and the rest: unreadable */
            break;
        }
        pnet_ring_commit(tx, len);
        s->queued++;
    }
    return PNET_TAKE_NEW;
}

unsigned pnet_link_fit(const uint16_t *lens, unsigned avail, size_t cap) {
    if (avail > PNET_MAX_FRAMES) avail = PNET_MAX_FRAMES;
    unsigned n = 0;
    while (n < avail && pnet_to_amiga_bound(lens, n + 1u) <= cap &&
           pnet_payload_bound(lens, n + 1u) <= PNET_TO_AMIGA_MAX_PAYLOAD) n++;
    return n;
}

void pnet_link_start(pnet_link_t *s, unsigned n) {
    if (n == 0u || s->backup) return;
    if (n > PNET_MAX_FRAMES) n = PNET_MAX_FRAMES;
    s->pico++;
    s->backup = true;
    s->nframes = (uint8_t)n;
}

bool pnet_ota_quiet(uint32_t now_ms, uint32_t last_ms, bool tx_pending) {
    if (tx_pending) return false;
    if (last_ms == 0u) return true;
    return (uint32_t)(now_ms - last_ms) >= PNET_OTA_QUIET_MS;
}

pnet_df1_t pnet_df1_for_track_l2(int want) {
    if (want == PNET_TRACK_STATUS) return PNET_DF1_STATUS;
    if (want == PNET_TRACK_STATUS - 1) return PNET_DF1_SILENT;
    return pnet_df1_for_track(want);
}
