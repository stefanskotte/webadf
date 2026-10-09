#ifndef DF1_LIVE_H
#define DF1_LIVE_H
// The DF1 setting changed while the board runs (spec 2026-10-08 D3): what
// core0 does to DF1's lines and machines. Pure, so the transitions are
// host-tested; main.c only carries the plan out.
//
// Three states of DF1 on the bus:
//   OFF     machines disabled: no ID answer, no line, no pad written -- no
//           drive at all. Only ever entered at boot (stored OFF).
//   ON      machines running, ID DD (HD with an HD disk in a WF_DF1_HD build),
//           WPROT asserted, CHNG asserted until a disk is in and stepped.
//   PARKED  switched off while running: machines STILL running, ID NONE,
//           CHNG + WPROT asserted, no disk. A running Amiga that found DF1 at
//           its last reset sees an empty drive -- disabling the machines would
//           release CHNG, which reads as a disk in the drive (a phantom).
//           Kickstart's next reset reads ID 0: no DF1. The next board boot
//           (stored OFF) leaves the machines disabled: every line released.
//
// Transitions (the setting arrives; `enabled` = DF1's machines run now):
//   -> NEXT, any state     ID DD, WPROT, TRK0 from the head, CHNG (empty),
//                          machines enabled (a no-op when parked), then the
//                          published DF1 word is looked at again so a disk
//                          core1 already handed over is inserted.
//   -> OFF, ON or PARKED   parked: ID NONE, eject (CHNG asserted, RDY
//                          released), DF1's stream stopped. Never disabled.
//   -> OFF, OFF            nothing: an absent drive stays absent.
#include <stdbool.h>
#include <stdint.h>
#include "drive_id.h"
#include "drive_store.h"

typedef struct {
    drive_id_kind_t id;   // DF1's ID from its next answer (bus_out_drive_id_set)
    bool set_id;          // write `id`
    bool lines;           // assert WPROT, TRK0 = (head at cylinder 0)
    bool eject;           // dskchg_image_ejected_d(1): CHNG asserted, RDY released
    bool unmount;         // stop DF1's stream and forget its mount
    bool enable;          // bus_out_drive_enable(1, true)
    bool rescan;          // re-read DF1's published word (a disk already there mounts)
    bool parked;          // the result is PARKED (for the log)
} df1_live_t;

df1_live_t df1_live_apply(df1_mode_t to, bool enabled);

// Drive mask the STEP ISR moves (bit d = drive d): DF0 always; DF1 while its
// machines run (ON or PARKED) -- a parked DF1 is an empty drive whose head
// still moves and whose TRK0 follows it, as a real one's would. A SEL1 step
// outside the mask is the df1-seen telemetry (spec §3), so that counts only
// while this board answers as no DF1 at all: a running Amiga that found our
// DF1 at its last reset steps it to look for a disk, parked or not, and those
// steps are not another drive's.
uint8_t df1_serving_mask(unsigned n_drives, bool df1_enabled);

#endif
