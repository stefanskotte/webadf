#ifndef UPLOADER_H
#define UPLOADER_H
// Write-back piece 2b, Task 5 -- write-back spec §3.1
// (docs/superpowers/specs/2026-09-18-write-back-and-disk-history-design.md)
// and HANDOFF §4g, whose four differences from the spec text this file
// implements: a per-boot `session` token (rule 1), a `mount` fixed from
// open to close (rule 2), write-protect decided at session open rather than
// per upload (rule 3), and the close protocol this task does not yet reach
// (rule 4, Task 6).
//
// This is the core1 poll loop's other half, beside dc_step(): for each
// dirty track, in track order, one POST at a time. Closing the session --
// hashing the whole image and telling the server it is complete -- is
// Task 6; here, a session that is open with nothing left dirty just waits
// (UP_WAITING).
//
// ONE REQUEST AT A TIME, BY CONSTRUCTION: up_step() sends at most one
// request per call and returns before starting another, and it shares
// device_client_t's single transport (`dc`) with dc_step()/dc_report_status
// -- there is no second connection this file could open even if it wanted
// to. HANDOFF §4g's fourth parked item ("keep one request in flight across
// the uploader and the status reporter") is therefore satisfied by
// construction, not by a lock: whichever of core1_main's call sites runs
// next, the transport is idle when it starts.
//
// RULE: this file (uploader.c) may not include any pico-sdk or lwIP header
// -- only C standard headers and the project's own pure headers -- for the
// same reason device_client.h states the same rule: it is compiled into
// every host test binary.
#include <stdint.h>
#include <stdbool.h>
#include "device_client.h"
#include "psram_image.h"

// How long with nothing dirty before the session closes (Task 6). Named
// here because up_has_work()/up_step() are what a caller polls against it.
#define UP_IDLE_CLOSE_MS 3000u
// 1-64 chars, [A-Za-z0-9_-] (HANDOFF §4g rule 1) -- generous headroom over
// what core1_main is expected to generate.
#define UP_SESSION_MAX   64

typedef enum { UP_SYNCED, UP_PENDING, UP_OFFLINE } up_sync_t;
typedef enum { UP_NOTHING, UP_WAITING, UP_DID_REQUEST } up_step_t;

// core0's write bookkeeping, read from core1 without a lock: both are a
// single word each, and up_step()/up_has_work() only ever compare them,
// never rely on them being consistent with each other at the instant of
// the read. Task 6 uses last_write_ms() for the idle-close timer.
typedef uint32_t (*up_counter_fn)(void);

typedef struct {
    device_client_t *dc;
    char     session[UP_SESSION_MAX + 1];
    up_counter_fn write_gen;       // +1 per write core0 applied
    up_counter_fn last_write_ms;   // dc->now() time of the last applied write
    bool     open;                 // a server session exists for (mount, session)
    uint32_t mount;                // fixed from open to close (HANDOFF 4g rule 2)
    char     disk_id[65];
    uint32_t seq;                  // last seq the server accepted in this session
    uint8_t  sent[(NUM_TRACKS + 7) / 8];
    bool     parked;               // after not_mounted, until the mount changes
    uint32_t parked_version;
    char     parked_sha[65];
    bool     online;               // last request reached the server
    uint32_t backoff_ms;
    uint32_t retry_at_ms;          // meaningful only while `waiting` is true
    // Review round 1, Important: set true only by the backoff itself, and
    // consulted (then cleared) only at the top of up_step -- never compared
    // against `now` once cleared. Without this, a `retry_at_ms` set once
    // during a transient failure and never touched again by a long run of
    // successes goes stale, and `(int32_t)(now - retry_at_ms)` silently
    // flips sign once `now` drifts more than 2^31 ms (~24.8 days) past it --
    // up_step would then wrongly report UP_WAITING (while up_has_work/
    // up_holds still read true, so the disk stays held and polling stays
    // suppressed) until the 32-bit clock wraps back, even though nothing is
    // actually backing off any more. A gate that only ever looks at the
    // timer while this flag says a wait is in progress cannot be fooled by
    // how stale the timer's last value is.
    bool     waiting;
    bool     force_wprot;          // after 409 write_protected, until the mount changes
    uint32_t wprot_version;
} uploader_t;

void      up_init(uploader_t *u, device_client_t *dc, const char *session,
                  up_counter_fn write_gen, up_counter_fn last_write_ms);
bool      up_pending(const uploader_t *u);    // dirty tracks or an open session
bool      up_has_work(uploader_t *u);         // run up_step instead of polling
bool      up_holds(void *u);                  // a dc_hold_fn
up_step_t up_step(uploader_t *u);             // at most one request
up_sync_t up_sync(const uploader_t *u);
bool      up_forces_wprot(uploader_t *u);

#endif
