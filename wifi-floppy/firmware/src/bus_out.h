#ifndef BUS_OUT_H
#define BUS_OUT_H
// ---------------------------------------------------------------------------
// The ONLY writer of the status outputs: INDEX, CHNG, WPROT, RDY, TRK0.
//
// Those pads belong to the status_gate PIO program (floppy.pio), one state
// machine per drive, which puts that drive's word on them while its select is
// asserted and releases them (once, on the deselect) while it is not.
// gpio_put() on them does NOTHING once PIO owns the pad -- silently -- so
// test/run.sh fails the build if one comes back.
//
// Written from the DMA IRQ (INDEX), the STEP ISR (TRK0), dskchg (CHNG/RDY) on
// core0 and the poll loop (WPROT) on core1: every update is a read-modify-write
// of a shared word, so it runs under a hardware spinlock with interrupts off.
// ---------------------------------------------------------------------------
#include <stdbool.h>
#include "hardware/pio.h"

// Drives the board can answer as: DF0 and DF1. Each has its own status_gate
// state machine (gated by its own select) and, with WF_DRIVE_ID, its own
// drive_id state machine; the PIO programs are loaded once and shared.
#define WF_DRIVES 2

// Hands the five status pads to `pio`, loads status_gate once, and configures
// one state machine per drive (0 .. ndrives-1, ndrives <= WF_DRIVES), drive d
// with initial[d] (a GPIO mask of asserted pins). Starts drive 0's only; the
// others wait for bus_out_drive_enable. Call once on core0, before anything
// else sets an output.
void bus_out_init(PIO pio, unsigned ndrives, const uint32_t initial[]);

// Drive d (1 .. ndrives-1) on the bus or off it. bus_out_init and
// bus_out_drive_id_init CONFIGURE every drive -- claimed, loaded, the pads
// handed over -- but start only drive 0's machines; every other drive's
// status_gate and drive_id state machines stay DISABLED until this enables
// them. A disabled machine writes no pad, so a drive that is off is
// pad-identical to no drive at all, even while both selects are low (many
// trackloaders select every drive at once to stop the motors).
//
// While a drive is off, bus_out_set_drive and bus_out_drive_id_set still
// keep its word and ID (the shadow and the machine's Y), so enabling it puts
// exactly that on the bus:
//   on:  the shadow is queued and the RDY level and the ID are in X/Y, the
//        machines are moved to a point that writes nothing while their select
//        is high, THEN enabled. If the select is already low (both selects
//        low together included), they write the pads on their first pass.
//   off: (boot-time only since Task 19 -- a live switch-off parks DF1 with its
//        machines running, df1_live.h)
//        the machines are disabled, THEN the drive's pads are released once
//        (status pads and RDY) -- only while SEL0 is high, so nothing of DF0's
//        is overwritten; with SEL0 low, DF0's own machines own the pads and
//        release them at its deselect.
// Under the bus_out spinlock; core0. Drive 0 always runs: d == 0 is ignored.
// No-op when already in that state.
void bus_out_drive_enable(unsigned d, bool on);
bool bus_out_drive_enabled(unsigned d);

// Drive d's status word: `pin` asserted or released. A drive that was not
// configured is ignored; one that is off keeps the word for when it is on.
void bus_out_set_drive(unsigned d, unsigned pin, bool assert);
// Drive 0 (DF0): every caller from before the second drive.
void bus_out_set(unsigned pin, bool assert);

// CMake passes WF_DRIVE_ID=0 or 1 (option WF_DRIVE_ID, default ON). The
// fallback is the conservative one: no responder.
#ifndef WF_DRIVE_ID
#define WF_DRIVE_ID 0
#endif

#if WF_DRIVE_ID
#include "drive_id.h"
// Hands RDY to floppy.pio's drive_id program on `pio`, one state machine per
// drive (0 .. ndrives-1), which answers the Amiga's drive-ID read on that
// drive's motor-off selects (drive_id.h, HD spec §5.4). Each answers DD until
// bus_out_drive_id_set. Drive 0's is started; any other drive's starts with
// bus_out_drive_enable (which must then come after this call). bus_out_set_drive(d, PIN_RDY, ...) keeps working: the
// level goes to drive d's drive_id. Call once on core0, after bus_out_init.
void bus_out_drive_id_init(PIO pio, unsigned ndrives);
// Drive d answers kind `k` from the next answer on -- the first motor-off
// select after a motor-on one, or the 32-bit repeat, never mid-answer. Core0
// only. True if it changed. Works on a drive that is off too (Y is written by
// exec'd instructions, which a disabled machine runs): set the kind BEFORE
// bus_out_drive_enable and the drive's first answer is already that kind.
bool bus_out_drive_id_set(unsigned d, drive_id_kind_t k);
// Drive 0: HD (true) or DD (false). bus_out_drive_id_set(0, ...).
bool bus_out_drive_id_set_hd(bool hd);
#endif

#endif
