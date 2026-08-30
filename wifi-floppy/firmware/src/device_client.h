#ifndef DEVICE_CLIENT_H
#define DEVICE_CLIENT_H
// The whole §10 device-contract state machine (see docs/superpowers/specs/
// 2026-08-30-device-firmware-protocol-design.md §4), pure C so it runs in
// the host test build. It talks to the network only through `transport_t`
// (Task 5) and parses only through `http_*` (Task 4) and `json_scan.h`
// (this task).
//
// RULE: this file (device_client.c) may not include any pico-sdk or lwIP
// header -- only C standard headers and the project's own pure headers.
// That is the property that keeps it host-testable, and it degrades
// silently: one include and nothing announces the loss. If it seems to
// need one, the seam is in the wrong place.
#include <stdint.h>
#include <stdbool.h>
#include "transport.h"

typedef enum {
    DC_UNPROVISIONED, DC_IDLE_POLL, DC_FETCHING, DC_VERIFYING,
    DC_SWAPPING, DC_BACKOFF, DC_HALTED
} dc_state_t;

typedef struct {
    char     sha256[65];
    char     disk_id[65];
    uint32_t version;
    bool     write_protected;
    bool     present;          // false => desired: null => eject
} dc_desired_t;

// Read timeout for one request/response cycle. The server holds a poll
// open for up to 25s before answering 204 (spec §4.3); a timeout at or
// under that tears down a healthy poll mid-hold and looks exactly like a
// network fault. `dc_step` needs a concrete value to pass to `read()`
// starting now, even though Task 7 is where backoff/timeout policy is
// formalised and tested end to end.
#define DC_POLL_TIMEOUT_MS 30000u

// Digests that returned 400/404/422 -- permanently unfetchable for this
// device. Small and fixed: the desired state rarely cycles through many bad
// digests, and an unbounded set on a device with no allocator is worse than
// forgetting the oldest.
#define DC_BLOCKED_MAX 4

typedef struct {
    transport_t *t;
    clock_ms_fn  now;
    const char  *host;
    const char  *token;
    uint32_t     since;        // RAM ONLY. Never persisted. Always 0 at boot.
    dc_state_t   state;
    uint32_t     backoff_ms;
    uint32_t     mounted_version;
    char         mounted_sha256[65];

    // --- internal blocked-digest ring buffer; do not touch directly ---
    char _blocked[DC_BLOCKED_MAX][65];
    int  _blocked_count;
    int  _blocked_next;
} device_client_t;

void dc_init(device_client_t *c, transport_t *t, clock_ms_fn now,
             const char *host, const char *token);
// One iteration: poll, and act on whatever comes back. Returns the new state.
dc_state_t dc_step(device_client_t *c);

bool dc_digest_is_blocked(const device_client_t *c, const char *sha256);

#endif
