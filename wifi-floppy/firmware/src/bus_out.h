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

// Hands the five status pads to `pio`, loads status_gate once, and starts one
// state machine per drive (0 .. ndrives-1, ndrives <= WF_DRIVES), drive d with
// initial[d] (a GPIO mask of asserted pins). Call once on core0, before
// anything else sets an output.
void bus_out_init(PIO pio, unsigned ndrives, const uint32_t initial[]);

// Drive d's status word: `pin` asserted or released. A drive that was not
// configured is ignored.
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
// bus_out_drive_id_set. bus_out_set_drive(d, PIN_RDY, ...) keeps working: the
// level goes to drive d's drive_id. Call once on core0, after bus_out_init.
void bus_out_drive_id_init(PIO pio, unsigned ndrives);
// Drive d answers kind `k` from the next answer on -- the first motor-off
// select after a motor-on one, or the 32-bit repeat, never mid-answer. Core0
// only. True if it changed.
bool bus_out_drive_id_set(unsigned d, drive_id_kind_t k);
// Drive 0: HD (true) or DD (false). bus_out_drive_id_set(0, ...).
bool bus_out_drive_id_set_hd(bool hd);
#endif

#endif
