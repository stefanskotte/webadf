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
#include "drive_store.h"

#define PNET_ECHO_BYTES 16384u   /* one half of the PSRAM echo store (main.c) */
/* DF1's INDEX pulse while it streams the echo: its restart and its wrap (main.c). Shorter than
 * the echo's 1.92 ms lead-in (120 B). Spike C showed moving our INDEX edge does not move the
 * Amiga's read; its start is timed from SIDE (HANDOFF 3bi). */
#define PNET_INDEX_PULSE_US 200u

/* PNET_DF1_STATUS: Phase 2's cylinder 76, side 1 (pnet_df1_for_track_l2, L2 builds only). */
typedef enum { PNET_DF1_DISK = 0, PNET_DF1_SILENT, PNET_DF1_ECHO, PNET_DF1_STATUS } pnet_df1_t;

/* What DF1 streams for `want` (cyl * 2 + side): the disk, nothing (154: the Amiga writes), or
 * the echo (155). */
pnet_df1_t pnet_df1_for_track(int want);
/* DF1's WPROT for a head on `cyl`: asserted everywhere but cylinder 77. */
bool pnet_df1_wprot(int cyl);
/* Phase 3 (plan 2026-10-12, ruling 2): whether DF1's PaulaNET path runs in DF1 mode `mode`. Network in
 * every build; in the loopback echo TEST build (WF_PNET_L2 off) Next disk as well, which is how that bench
 * build has always run. Off, and any mode this build does not know: never. */
bool pnet_mode_on(uint8_t mode, bool echo_build);
/* Task 5 review I1: DF1's WPROT for a head on `cyl` under the gate (`on` = pnet_mode_on). On: pnet_df1_wprot.
 * Off: asserted everywhere, cylinder 77 included -- main.c re-asserts it with this when Network mode ends. */
bool pnet_df1_wprot_gated(bool on, int cyl);
/* A WGATE assertion is a loopback batch: DF1 serves a disk, SEL1 (not SEL0) is asserted, and
 * DF1's head is on cylinder 77, side 0. sel0/sel1 are ASSERTED, not pin levels. */
bool pnet_capture_ours(bool df1_serving, bool sel0, bool sel1, int cyl1, int side);
/* Phase 2 (plan 2026-10-11-paulanet-phase2-rob-driver, Task 1): the microseconds a start of DF1's
 * side-1 stream must still wait so it begins `delay_us` after the SIDE edge stamped at side_us, at
 * now_us (time_us_32 values; wrap-safe). 0 once that moment has passed, however long ago the edge was:
 * a stale stamp (no SIDE edge for 36 minutes) or one a hair ahead of now never schedules a start
 * far in the future. */
uint32_t pnet_go_wait_us(uint32_t side_us, uint32_t delay_us, uint32_t now_us);

/* What a start does given its wait: ALARM (wait > min_us: a delayed start), LATE (the due time had
 * passed: start at once), SHORT (due within min_us: at once, since an alarm costs about as much --
 * the start was "delayed" but for under min_us). */
typedef enum { PNET_GO_ALARM, PNET_GO_LATE, PNET_GO_SHORT } pnet_go_kind_t;
pnet_go_kind_t pnet_go_kind(uint32_t wait_us, uint32_t min_us);

/* A pending delayed start is due only while side 1 still wants the out-track (side 1 of cylinder 77). */
bool pnet_go_still_wanted(int want_track1);

/*
 * THE PRE-ARM (2026-10-10). The Amiga's to-board write has no lead-in: sync pulse 1 is ~32 us after
 * WGATE and pulse 2 ~64 us. Armed from the WGATE ISR the capture starts ~26 us late on average and,
 * while core0 builds an 8 KB echo, >64 us late -- inside the data, refused. So the capture is armed
 * AHEAD of the write, from core0's loop, whenever a DF1 batch is the next write the bus can carry:
 * WDATA is idle while nobody writes, so a pre-armed capture records nothing until the first pulse,
 * and its first edge is sync pulse 1. The WGATE ISR then CLAIMS it for a DF1 cylinder-77 write, and
 * CANCELS it on every other assert (a DF0 write above all: DF0 then arms exactly as without it).
 *
 * pnet_prearm_decide is the loop's half, evaluated with interrupts off (main.c): nothing in it can
 * change between the reading and the action.
 */
typedef enum {
    PNET_PREARM_NONE = 0,   /* nothing to do */
    PNET_PREARM_ARM,        /* arm the raw capture now, ahead of the write */
    PNET_PREARM_CANCEL,     /* the conditions are gone: abandon the pre-arm */
    PNET_PREARM_STRAY       /* edges arrived with no write: abandon it, they are not a batch */
} pnet_prearm_t;

typedef struct {
    bool df1_serving;   /* DF1 holds a disk, so its cylinder 77 is the loopback */
    bool sel0;          /* SEL0 asserted: DF0 is in use */
    bool wgate;         /* WGATE asserted: a write is on the bus (its ISR decides, never the loop) */
    bool unpowered;     /* the Amiga's side of the bus is unpowered (bus_power.h) */
    int  cyl1, side;    /* DF1's head */
    bool idle;          /* flux_capture_idle(): an arm now destroys no capture */
    bool prearmed;      /* a pre-arm stands, claimed by no write */
    bool edges;         /* the standing pre-arm has captured something */
} pnet_prearm_in_t;

pnet_prearm_t pnet_prearm_decide(const pnet_prearm_in_t *in);
/* Phase 3 (plan 2026-10-12, Review Focus 4): the loop's pre-arm decision under the runtime gate. `on` is
 * pnet_mode_on for the current DF1 mode (main.c's g_pnet_on). On: pnet_prearm_decide, unchanged. Off: DF1's
 * cylinder 77 is disk data (or nothing), so DF1 counts as not serving -- a pre-arm left standing from
 * Network mode is let go (the ISR's, while WGATE is asserted), and nothing is ever armed. */
pnet_prearm_t pnet_prearm_gated(bool on, const pnet_prearm_in_t *in);

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
