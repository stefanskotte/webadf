/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
#ifndef PNET_LOOP_H
#define PNET_LOOP_H
/*
 * The cylinder-77 loopback's decisions (WF_PNET_LOOP TEST builds): what DF1 streams for a track,
 * WPROT, whose write a capture is, and PaulaNET's counter/acknowledge rule. Pure; main.c acts.
 *
 * Implemented from the protocol's description; no code of his.
 *
 * Counters, as PaulaNET has them: each side bumps its own 8-bit counter per new batch and echoes
 * the other's. A batch whose amiga counter equals the last one taken is a resend: its frames are
 * not taken again. An amiga batch that echoes our current pico counter acknowledges our batch,
 * which is then dropped. In the loopback our batch IS the echo of the Amiga's last frames.
 */
#include <stdint.h>
#include <stdbool.h>
#include "pnet_frame.h"

#define PNET_ECHO_BYTES 16384u   /* one half of the PSRAM echo store (main.c) */

typedef enum { PNET_DF1_DISK = 0, PNET_DF1_SILENT, PNET_DF1_ECHO } pnet_df1_t;

/* What DF1 streams for `want` (cyl * 2 + side): the disk, nothing (154: the Amiga writes), or
 * the echo (155). */
pnet_df1_t pnet_df1_for_track(int want);
/* DF1's WPROT for a head on `cyl`: asserted everywhere but cylinder 77. */
bool pnet_df1_wprot(int cyl);
/* A WGATE assertion is a loopback batch: DF1 serves a disk, SEL1 (not SEL0) is asserted, and
 * DF1's head is on cylinder 77, side 0. sel0/sel1 are ASSERTED, not pin levels. */
bool pnet_capture_ours(bool df1_serving, bool sel0, bool sel1, int cyl1, int side);

typedef struct {
    uint8_t  last_amiga;               /* 0xFF: nothing taken yet */
    uint8_t  pico;                     /* our batch counter, 0x7F at start (as PaulaNET's) */
    uint8_t  nframes;                  /* frames in the echo; 0 = an empty batch */
    uint16_t len[PNET_MAX_FRAMES];
    uint32_t rx, fresh, dup;           /* captures; new batches; resends */
    uint32_t bad[PNET_E_COUNT];        /* refused captures, by reason (main.c counts these) */
} pnet_loop_t;

void pnet_loop_init(pnet_loop_t *s);
bool pnet_loop_is_new(const pnet_loop_t *s, const pnet_hdr_t *h);
/* A parsed batch: n frames of lens[] if it is new (n = 0 and lens may be NULL for a resend). */
void pnet_loop_commit(pnet_loop_t *s, const pnet_hdr_t *h, unsigned n, const uint16_t *lens);
#endif
