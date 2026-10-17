#ifndef SWAP_PHASE_H
#define SWAP_PHASE_H
// ---------------------------------------------------------------------------
// A disk replaced by another disk is shown to the Amiga as EMPTY first.
//
// Field report 2026-10-17: installing Workbench 3.2, "Please insert volume
// Locale" stayed up after Locale was mounted from the web, until Retry was
// clicked. The board switched the new image in place: /CHNG asserted with a
// disk present, released by the next STEP (dskchg.c). Kickstart 3.2's
// trackdisk (disassembled) checks for a change every SWAP_TD_POLL_MS with a
// disk in, SWAP_TD_EMPTY_POLL_MS without: it reads /CHNG, if low reports a
// REMOVAL, steps, reads again, and if now high reports an INSERTION. Against
// an in-place switch both arrive ~100 us apart in ONE poll, and the ROM
// filesystem posts nothing while its previous input event is unanswered, so
// the insertion never reaches the requester. A real drive is empty for at
// least one poll -- nobody swaps a disk in 100 us.
//
// So a mounted disk replaced by another mounted disk (web mount, Next disk,
// NFC tap; DF0 and DF1) is first presented as an empty drive -- /CHNG
// asserted with no image, which a STEP cannot clear, and no stream -- for
// SWAP_EMPTY_MS, and only then inserted. SWAP_EMPTY_MS covers two with-a-disk
// polls, so at least one (normally two, allowing for a late timer tick) sees
// the drive empty and reports the removal on its own; the insertion is then
// reported by a later poll, after the removal's event was answered. It is
// below SWAP_TD_EMPTY_POLL_MS, so the new disk is already in when the first
// empty-drive poll comes: the requester closes within ~2.5 s of the removal.
//
// The swap gate (swap_gate.h, 1.6.1: the drive light out, no writes) runs on
// core1 BEFORE the new slot is published; this phase starts only once core0
// sees the publish, so it never shortens that wait. A second swap during the
// empty phase restarts the timer and the newest disk goes in; an eject
// cancels the pending insert. core0 keeps the deadline in its loop, never a
// blocking wait.
//
// Pure, host-tested; wraparound handled as ((int32_t)(now - x) >= 0).
// ---------------------------------------------------------------------------
#include <stdbool.h>
#include <stdint.h>

#define SWAP_TD_POLL_MS        500u    // trackdisk's change check, disk in (Kickstart 3.2)
#define SWAP_TD_EMPTY_POLL_MS 2500u    // ... and with no disk
#define SWAP_EMPTY_MS         1000u    // = 2 x SWAP_TD_POLL_MS, < SWAP_TD_EMPTY_POLL_MS

typedef struct {
    bool     empty;       // presenting the drive empty, an insert pending
    uint32_t until_ms;    // when that insert is due
} swap_phase_t;

typedef enum {
    SWAP_PHASE_INSERT_NOW,   // the drive was empty: announce the disk now
    SWAP_PHASE_GO_EMPTY,     // disk over disk: eject, stop the stream, wait
    SWAP_PHASE_EJECT,        // no disk now (cancels any pending insert)
} swap_phase_action_t;

void swap_phase_init(swap_phase_t *p);

/** The drive's image changed. `was_mounted`: a disk was assigned to the drive
 *  before this change (including one still waiting out an empty phase);
 *  `now_mounted`: one is now. */
swap_phase_action_t swap_phase_on_change(swap_phase_t *p, uint32_t now,
                                         bool was_mounted, bool now_mounted);

/** True once, when the pending insert is due; the phase then ends. */
bool swap_phase_insert_due(swap_phase_t *p, uint32_t now);

/** In the empty phase: nothing streams, nothing announces an insert. */
bool swap_phase_empty(const swap_phase_t *p);

/** Drop a pending insert (the drive was switched off meanwhile). */
void swap_phase_cancel(swap_phase_t *p);
#endif
