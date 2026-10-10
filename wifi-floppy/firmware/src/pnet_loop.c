/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
/* Implemented from the protocol's description; no code of his (see pnet_loop.h). */
#include "pnet_loop.h"
#include <string.h>

pnet_df1_t pnet_df1_for_track(int want) {
    if (want == PNET_TRACK_IN) return PNET_DF1_SILENT;
    if (want == PNET_TRACK_OUT) return PNET_DF1_ECHO;
    return PNET_DF1_DISK;
}

bool pnet_df1_wprot(int cyl) { return cyl != PNET_CYL; }

bool pnet_capture_ours(bool df1_serving, bool sel0, bool sel1, int cyl1, int side) {
    return df1_serving && !sel0 && sel1 && cyl1 == PNET_CYL && side == 0;
}

pnet_prearm_t pnet_prearm_decide(const pnet_prearm_in_t *in) {
    /* Where the next write is a DF1 batch: DF1 on cylinder 77, side 0 (pnet_capture_ours less
     * WGATE and SEL1), and DF0 not selected -- SEL1 asserted, or no drive yet (about to be). */
    const bool where = in->df1_serving && in->cyl1 == PNET_CYL && in->side == 0;
    if (in->prearmed) {
        if (in->unpowered) return PNET_PREARM_CANCEL;      /* a floating bus writes nothing */
        if (in->wgate) return PNET_PREARM_NONE;            /* the ISR claims or cancels it */
        if (in->edges) return PNET_PREARM_STRAY;           /* no write, yet edges: not a batch */
        return where ? PNET_PREARM_NONE : PNET_PREARM_CANCEL;
    }
    if (in->idle && where && !in->sel0 && !in->wgate && !in->unpowered) return PNET_PREARM_ARM;
    return PNET_PREARM_NONE;
}

void pnet_loop_init(pnet_loop_t *s) {
    memset(s, 0, sizeof *s);
    s->last_amiga = 0xFFu;
    s->pico = 0x7Fu;
}

bool pnet_loop_is_new(const pnet_loop_t *s, const pnet_hdr_t *h) {
    return h->amiga_ctr != s->last_amiga;
}

void pnet_loop_commit(pnet_loop_t *s, const pnet_hdr_t *h, unsigned n, const uint16_t *lens) {
    if (h->pico_ctr == s->pico) s->nframes = 0;          // the Amiga has our batch
    if (!pnet_loop_is_new(s, h)) { s->dup++; return; }  // a resend: frames already taken
    s->last_amiga = h->amiga_ctr;
    s->fresh++;
    if (n == 0) return;
    if (n > PNET_MAX_FRAMES) n = PNET_MAX_FRAMES;
    s->pico++;
    s->nframes = (uint8_t)n;
    memcpy(s->len, lens, n * sizeof *lens);
}
