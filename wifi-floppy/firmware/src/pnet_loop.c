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
