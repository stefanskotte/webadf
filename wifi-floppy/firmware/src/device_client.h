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

// ---------------------------------------------------------------------
// OBSERVATIONS: what this state machine is doing, for something that shows
// it to a human. Nothing here influences the protocol -- an observer that
// does nothing must leave behaviour identical, which is what keeps the
// display from being able to break a mount.
//
// A function pointer rather than a header include, for the same reason
// transport_t is one: this file may not reference the panel, the I2C bus or
// anything else device-only, or it stops building on the host.
//
// The server has ALWAYS sent the disk's title, number and label in the poll
// body (src/lib/mount.ts). Nothing here parsed them, so the device knew only
// a 64-character digest -- which is why "show the disk name" needs no server
// change and no protocol change, only reading fields already on the wire.
#define DC_TITLE_MAX 48
#define DC_LABEL_MAX 24

typedef enum {
    DC_OBS_FETCH_BEGIN,     // a new digest is wanted; title is known
    DC_OBS_FETCH_PROGRESS,  // got/total bytes; emitted only when % changes
    DC_OBS_VERIFY,          // body complete, checking the container
    DC_OBS_MOUNTED,         // published and servable
    DC_OBS_EJECTED,         // desired: null
} dc_obs_kind_t;

typedef struct {
    dc_obs_kind_t kind;
    char     title[DC_TITLE_MAX + 1];
    char     label[DC_LABEL_MAX + 1];
    uint32_t disk_no;
    uint32_t disk_count;
    uint32_t got;
    uint32_t total;
} dc_obs_t;

typedef void (*dc_observe_fn)(void *ctx, const dc_obs_t *o);

// Read timeout for one request/response cycle. The server holds a poll
// open for up to 25s before answering 204 (spec §4.3); a timeout at or
// under that tears down a healthy poll mid-hold and looks exactly like a
// network fault. `dc_step` needs a concrete value to pass to `read()`
// starting now, even though Task 7 is where backoff/timeout policy is
// formalised and tested end to end.
#define DC_POLL_TIMEOUT_MS 30000u

// Backoff policy (Task 7): exponential from the floor, doubling on every
// consecutive failure, capped, plus jitter derived from the injected clock
// so tests stay deterministic (see dc_enter_backoff in device_client.c).
#define DC_BACKOFF_FLOOR_MS 1000u
#define DC_BACKOFF_CAP_MS   60000u

// Roughly how often dc_report_status should be called by the driving main
// loop (Task 7 only defines the constant and the report primitive; the
// periodic/on-transition call sites are wired up by whichever task owns the
// main loop).
#define DC_STATUS_PERIOD_MS 60000u

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
    char         mounted_disk_id[65];
    // The mounted disk's writeProtected flag, as last reported by the
    // server (dc_handle_poll_body fails this safe to true if the poll body
    // omits it or it isn't a JSON boolean). Meaningless while nothing is
    // mounted (mounted_sha256[0] == '\0') -- the driving main loop is
    // expected to treat "nothing mounted" as write-protected regardless of
    // this field's value, which is why dc_init's zero-init (false) here is
    // never itself read as an authoritative "writable".
    bool         mounted_write_protected;

    // --- observation, see dc_set_observer ---
    dc_observe_fn _obs;
    void         *_obs_ctx;
    // The in-flight disk's identity, so a progress observation can carry the
    // title without re-parsing the poll body it came from.
    char          _fetch_title[DC_TITLE_MAX + 1];
    char          _fetch_label[DC_LABEL_MAX + 1];
    uint32_t      _fetch_disk_no;
    uint32_t      _fetch_disk_count;
    int           _fetch_pct;     // last percent emitted, -1 = none yet

    // --- internal blocked-digest ring buffer; do not touch directly ---
    char _blocked[DC_BLOCKED_MAX][65];
    int  _blocked_count;
    int  _blocked_next;
} device_client_t;

void dc_init(device_client_t *c, transport_t *t, clock_ms_fn now,
             const char *host, const char *token);

/** Watch what this client does. Call AFTER dc_init, which zeroes the struct.
 *  `fn` may be NULL to stop observing. Called on the caller's thread, from
 *  inside dc_step -- including from the image read loop, so it must be cheap
 *  and must not block: on this device that loop is the 2 MB transfer. */
void dc_set_observer(device_client_t *c, dc_observe_fn fn, void *ctx);
// One iteration: poll, and act on whatever comes back. Returns the new state.
dc_state_t dc_step(device_client_t *c);

bool dc_digest_is_blocked(const device_client_t *c, const char *sha256);

// Task 7: a 400 invalid_or_used_code is not the same failure as a
// transient network or server fault -- spec D-4b-4 says it is terminal
// (the pairing code is single-use with a 10-minute TTL and will never
// become valid again), while every other non-success is worth retrying
// under backoff. DC_REG_BAD_CODE lets the caller (main.c) route the
// former back to provisioning.h's prov_on_pairing_code_rejected() instead
// of looping on dc_register() forever.
// Review round 2, Minor 2: DC_REG_OK == 0, so `if (!dc_register(...))`
// -- the old bool idiom, and the shape every call site used before this
// task -- now means SUCCESS, the exact opposite of what it meant when
// dc_register() returned bool. device_client.c's dc_enter_backoff() carries
// the same warning for DC_BACKOFF (nonzero) inside dc_register()'s own
// body; this is the same class of trap at the call site instead. Every one
// of the 7 call sites this task touched (main.c's production caller, plus
// the six in test/test_device_client.c) is an explicit `== DC_REG_OK` /
// `== DC_REG_BAD_CODE` comparison, never a bare truthiness check -- keep it
// that way in any new call site.
typedef enum {
    DC_REG_OK,          // 200 with a token; persisted via token_store_save().
    DC_REG_RETRY,       // transport failure, non-200 other than the case
                        // below, or a 200 body missing `token`. Worth
                        // retrying under c->backoff_ms.
    DC_REG_BAD_CODE,    // 400 {"error":"invalid_or_used_code"}. Terminal --
                        // see provisioning.h's prov_on_pairing_code_rejected.
} dc_register_result_t;

// One-shot registration: POST /api/device/register with
// {pairingCode, firmwareVersion, macAddress}. `c` need only have `t` and
// `host` set (dc_init with any token, even NULL, works, since this call
// never reads c->token) -- spec §7: the pairing code itself is the
// credential, so unlike every other request in this file, no bearer is
// sent regardless of what c->token holds. On a 200 with a `token` field,
// persists it via token_store_save() and returns DC_REG_OK; on a 400 body
// whose `error` field is exactly "invalid_or_used_code" returns
// DC_REG_BAD_CODE and stores nothing; on any other outcome (transport
// failure, non-200, or a 200 body missing `token`) returns DC_REG_RETRY
// and stores nothing. The caller (main.c) still owns turning a successful
// registration into a usable device_client_t: reload the token with
// token_store_load() and dc_init() again with it.
//
// Never logs `pairing_code` or the token the server returns -- the token
// is returned exactly once, by this call.
dc_register_result_t dc_register(device_client_t *c, const char *pairing_code,
                 const char *firmware_version, const char *mac);

// Sends one status heartbeat: POST /api/device/status with all six fields
// (spec §4.3 -- "send everything the firmware knows, every time it
// reports") -- mountedSha256, mountedDiskId, version, error, psramFree,
// rssi. `err` may be NULL (reported as JSON null); mountedSha256/
// mountedDiskId are reported as explicit null when nothing is mounted,
// never omitted -- an absent key means "leave the column alone" server
// side, while null means "I hold no disk" (spec §10, F-2). Best-effort:
// a transport failure or unexpected status here is not reflected in
// `backoff_ms` or `state`, except a 401 (token dead), which halts exactly
// as it does for the poll and image endpoints.
void dc_report_status(device_client_t *c, int psram_free, int rssi, const char *err);

#endif
