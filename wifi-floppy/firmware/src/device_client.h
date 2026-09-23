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

// Returning true means "unsent writes exist for the mounted disk" -- see
// dc_set_hold below.
typedef bool (*dc_hold_fn)(void *ctx);

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

// Sized from the poll body's actual shape, not guessed. readDesired()
// (src/lib/mount.ts) emits, in this order: version, sha256 (64 hex),
// diskId, gameId, game, diskNo, diskCount, label, writeProtected. The
// fixed part -- keys, punctuation, the two 64-char-capable ids, the
// 64-hex digest and three small integers -- comes to under 400 bytes;
// everything above that is headroom for the two free-text fields (`game`,
// a title, and `label`), which are `text` columns with no length limit at
// all in the schema, so no buffer size can be *proved* sufficient here.
//
// Two things matter about the ordering: `sha256` is emitted first, so a
// truncated body still yields a plausible-looking digest, while
// `writeProtected` is emitted LAST, so it is the first field a long title
// pushes off the end. Losing it silently would be a disk presented as
// writable purely because its title was long -- so this is never resolved
// by a favourable default: a truncated body is refused outright (dc_step's
// DC_IDLE_POLL/backoff path below never calls dc_handle_poll_body on one),
// which means a lost writeProtected can never present a disk as writable.
// So: the buffer is generous (~1.1 KB for the two free-text fields), AND
// truncation is recorded rather than silently swallowed -- dc_step
// refuses to act on a truncated body at all (see its DC_IDLE_POLL/backoff
// path), which is the same "touch nothing" resolution every other
// malformed-response case takes.
#define DC_POLL_BODY_BYTES 1536
//
// Moved here from device_client.c so the server side can assert against it:
// src/lib/device-limits.test.ts computes the worst-case body from the real
// field bounds and fails if it would not fit. That matters more than it
// looks, because dc_step REFUSES a truncated body outright rather than
// parsing a prefix -- an over-long body costs the whole instruction, so the
// board stops mounting and ejecting, not merely updating.

// The status report is the one request this file POSTs a body with, so it
// needs a bigger request buffer than a bare GET line (DC_REQ_BUF_BYTES):
// two 64-hex-char fields, a mount version, an escaped error string, the
// firmware version, and two ints, plus the request line and headers.
//
// Raised from 512/1024 when firmwareVersion joined the body. A maximal body
// -- 64-hex sha, 64-char disk id, 10-digit version, 256-byte error, 64-char
// firmware version, plus keys -- is ~560 bytes, and the old 512 would have
// overflowed. dc_report_status fails SILENTLY on overflow (it returns false
// with no log line), so that would have shown up as a heartbeat that stopped
// whenever an error string happened to be long, not as an error. Both
// buffers are `static` (see the STACK note in device_client.c), so the cost
// is .bss rather than stack. test_status_body_fits_at_maximum is what keeps
// the headroom honest when the next field is added.
// Raised for the four firmware-update fields dc_report_status may append
// (updateProtocol, firmwareUpdateState, firmwareUpdateError,
// firmwareInstructionAck): worst case adds ~
// ,"updateProtocol":1,"firmwareUpdateState":"downloading","firmwareUpdateError":"<200>","firmwareInstructionAck":4294967295
// -- about 300 bytes.
#define DC_STATUS_BODY_BYTES  1024
#define DC_STATUS_REQ_BYTES   1536
// `err` is firmware-authored (a short static string or errno-derived text,
// never network input), but it still has to survive being embedded in a
// JSON string unescaped -- truncated well short of DC_STATUS_BODY_BYTES so
// there is always room left for the rest of the fields.
#define DC_STATUS_ERR_BYTES   256
// 64 characters plus the terminator: FIRMWARE_VERSION_MAX in
// src/lib/firmware-version.ts is the server's bound on the same string, and
// a board that could report a version the server rejects would be a gap with
// no reason to exist.
#define DC_STATUS_VER_BYTES   65

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

// Firmware self-update (piece 2b): the wire fields this board can speak
// once it opts in. DC_UPDATE_PROTOCOL is the one version this firmware
// implements; dc_set_fw_report's update_protocol field is compared against
// it (well, is just the value sent) -- 0 means "say nothing, this build
// does not participate".
#define DC_UPDATE_PROTOCOL        1
// Sized like DC_POLL_BODY_BYTES's `update` object: version (up to
// FIRMWARE_VERSION_MAX), sequence, a 64-hex sha256, sizeBytes, an ed25519
// signature (base64, 88 chars), keyId and instructionVersion, plus keys and
// punctuation -- comfortably under 512.
#define DC_FW_UPDATE_JSON_BYTES   512

// What main.c (a later task) hands dc_report_status to describe, so this
// file never has to know what "downloading" or "applying" mean -- only how
// to put them on the wire. `state`/`error` are `const char *` rather than
// copied in, so the caller's own storage (a static string literal, or its
// own escaped buffer) is what dc_report_status reads at send time; NULL
// means an explicit JSON null for either, never an omitted key -- the same
// honesty rule every other optional field in this file follows.
typedef struct {
    int         update_protocol;   // 0 = omit the field (and send 0 at register)
    const char *state;             // NULL => JSON null
    const char *error;             // NULL => JSON null
    uint32_t    instruction_ack;
} dc_fw_report_t;

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

    // --- write-back, see dc_set_hold / dc_force_refetch ---
    dc_hold_fn _hold;
    void      *_hold_ctx;
    bool       _refetch;

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

    // --- firmware self-update (piece 2b); see dc_take_fw_fields ---
    // Set by dc_step when instructionVersion moved past fw_instruction_version.
    bool     fw_instruction_new;
    uint32_t fw_instruction_version;
    bool     fw_offer_present;       // an "update" object came with it
    char     fw_update_json[DC_FW_UPDATE_JSON_BYTES];
    // Set via dc_set_fw_report; the pointer is kept, not copied -- see its
    // own comment.
    const dc_fw_report_t *_fw_report;
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
// side, while null means "I hold no disk" (spec §10, F-2). Best-effort as
// far as `backoff_ms`/`state` go -- a transport failure or unexpected
// status here does not touch either, except a 401 (token dead), which
// halts exactly as it does for the poll and image endpoints.
//
// Returns true iff a complete response with a 2xx status (204 included)
// actually arrived; false otherwise (a transport failure, a truncated
// response, a non-2xx status, or the 401 case above). Fix round 1 (write-
// back piece 2b task 8): the caller (main.c) MUST NOT treat the mounted
// disk's identity/version as reported to the server unless this returns
// true -- the server decides an upload's not_mounted/behind verdict from
// the mountedVersion it last successfully heard (HANDOFF 4g), and a caller
// that advanced its own bookkeeping on a failed send would let the two
// drift apart with no way to notice.
// `fw_version` may be NULL, which reports firmwareVersion as null rather
// than omitting the key. It travels as a parameter, the way dc_register
// already takes it, so that device_client.c never includes the generated
// version header -- host tests compile this file without the firmware build.
bool dc_report_status(device_client_t *c, int psram_free, int rssi, const char *err,
                      const char *fw_version);

// Registers `r` as the firmware-update report dc_report_status and
// dc_register append to their bodies (updateProtocol, firmwareUpdateState,
// firmwareUpdateError, firmwareInstructionAck) -- the pointer is kept, not
// copied, so the caller's own storage must outlive it. `r` may be NULL to
// stop reporting. update_protocol <= 0 means "say nothing, this build does
// not participate": dc_report_status omits all four fields entirely (not
// merely as null) and dc_register omits updateProtocol -- a board that has
// not opted in must never claim the capability.
void dc_set_fw_report(device_client_t *c, const dc_fw_report_t *r);

// Write-back (piece 2b): what an uploader needs from the poll/fetch state
// machine to hold a disk open while writes are still on the way to the
// server, and to push those writes out itself.

// Registers `fn` (with `ctx`) as the hold check: while something is mounted
// (mounted_sha256[0] != '\0') and `fn(ctx)` returns true, dc_handle_poll_body
// treats a `desired` that would eject or replace the mounted disk as a
// no-op -- nothing is ejected, fetched or published, `since` does not
// advance, and backoff is untouched, so the poll is retried again once the
// hold lifts. `fn` may be NULL to stop holding. With nothing mounted the
// hold is ignored -- there is nothing to protect.
void dc_set_hold(device_client_t *c, dc_hold_fn fn, void *ctx);

// Forces the next poll to take the fetch path even if it names the digest
// already mounted -- for when the server's copy of a disk must win over the
// board's own (e.g. after closing a write session server-side). Resets
// `since` to 0 so the poll is answered immediately rather than waiting for
// the next version bump; dc_complete_transition() clears the flag once the
// resulting transition completes.
void dc_force_refetch(device_client_t *c);

// Adopts `sha256` as the mounted digest without fetching or verifying
// anything -- for when a write session on this same disk has already been
// closed server-side and the server's new digest is known to match what is
// already sitting in PSRAM. Nothing else (version, disk id, PSRAM slot)
// changes; the next poll naming this digest is then a no-op, exactly as if
// it had arrived by a normal fetch.
void dc_adopt_image(device_client_t *c, const char *sha256);

// Largest body dc_post will send in one call -- one head plus one track
// (see the STACK note in device_client.c for why the request buffer this
// backs is `static` and sized from this).
#define DC_POST_BODY_MAX 5632

// Sends one POST with a binary body (`body`/`body_len`, up to
// DC_POST_BODY_MAX -- NUL bytes and all, unlike http_build_request's
// C-string body) and copies the response body, NUL-terminated, into `resp`
// (`resp_cap` bytes, truncated if it doesn't fit; `resp` may be NULL to
// discard it). Returns the HTTP status on a well-formed exchange, or -1 for
// a transport/framing failure, an incomplete body, `body_len` out of range,
// or a request head that does not fit. A 401 halts (state = DC_HALTED) the
// same as every other endpoint in this file, and still returns 401.
int dc_post(device_client_t *c, const char *path, const char *content_type,
            const uint8_t *body, int body_len, char *resp, int resp_cap);

#endif
