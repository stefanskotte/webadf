#ifndef FW_UPDATE_H
#define FW_UPDATE_H

#include "fw_offer.h"
#include "fw_verify.h"
#include "fw_stage.h"
#include "fw_apply.h"
#include "fw_state.h"
#include <stdint.h>
#include <stdbool.h>

typedef enum { FWU_IDLE, FWU_QUEUED, FWU_DOWNLOADING, FWU_STAGED, FWU_APPLYING, FWU_REBOOTING, FWU_FAILED } fwu_phase_t;
#define FWU_ERROR_MAX      200
#define FWU_RETRY_FLOOR_MS 5000u
#define FWU_RETRY_CAP_MS   300000u

typedef struct {
    int  (*fetch)(void *ctx, const char *version, fw_stage_t *stage);   // HTTP status or -1
    fw_apply_result_t (*apply)(void *ctx, const uint8_t *img, uint32_t len, const char *sha_hex,
                               uint32_t *slot_off_out);
    bool (*save_state)(void *ctx, const fw_state_t *st);
    void (*request_reboot)(void *ctx, uint32_t slot_off);
    void *ctx;
} fwu_ops_t;

typedef struct {
    fwu_phase_t phase;
    fw_offer_t  offer;
    char        error[FWU_ERROR_MAX + 1];
    uint8_t    *stage_buf;
    uint32_t    stage_cap;
    fw_stage_t  stage;
    uint32_t    retry_at_ms;
    uint32_t    backoff_ms;
} fwu_t;

void fwu_init(fwu_t *u, uint8_t *stage_buf, uint32_t stage_cap);
void fwu_fail(fwu_t *u, const char *why);
// fwu_fail behind fwu_on_instruction's guard: a no-op while APPLYING or
// REBOOTING (past the point of no return), otherwise FAILED with `why`.
// For refusals decided outside fwu (malformed instruction, a board that
// cannot update).
void fwu_refuse(fwu_t *u, const char *why);
void fwu_on_instruction(fwu_t *u, const fw_offer_t *offer_or_null, fw_verdict_t verdict);
bool fwu_step(fwu_t *u, const fwu_ops_t *ops, fw_state_t *st, bool idle, uint32_t now_ms);
const char *fwu_state_text(const fwu_t *u);   // NULL when there is nothing to report
const char *fwu_error_text(const fwu_t *u);   // NULL unless FAILED

// ---------------------------------------------------------------------------
// DIAGNOSTIC (OTA stall, HANDOFF 2026-10-09): one line naming the updater's
// phase, its retry timer and every input of main.c's idle gate (D6), so a
// board that sits at "queued" says WHY. Pure: main.c reads the inputs and the
// pads and does the logging.
//
// The phase by its own name -- fwu_state_text folds STAGED into "queued".
const char *fwu_phase_name(fwu_phase_t p);

typedef struct {
    fwu_phase_t phase;
    uint32_t    retry_at_ms, backoff_ms;
    bool        mounted;     // c.mounted_sha256 non-empty
    int         slot;        // psram_active_slot(), -1 = none
    bool        upw;         // up_has_work
    bool        motor;       // g_motor_on (core0's DF0 motor latch)
    bool        owed;        // fw_report_owed
    bool        preload;     // c.preload.loading
    bool        idle;        // the gate's verdict from the above
    int         dc_state;    // device_client state (dc_state_t)
} fwu_diag_in_t;

typedef struct {
    bool        have;        // a line has been logged
    uint32_t    sig;         // the inputs as last logged (no timers)
    fwu_phase_t phase;       // the phase as last logged
    uint32_t    last_ms;     // when it was logged
} fwu_diag_t;

#define FWU_DIAG_PERIOD_MS 60000u   // a line at least this often
#define FWU_DIAG_MIN_GAP_MS 1000u   // on-change lines at most this often

// True when a line is due: the first call; every FWU_DIAG_PERIOD_MS; a phase
// change; and, while the updater is not IDLE, any change of a gate input
// (at most one per FWU_DIAG_MIN_GAP_MS -- a change inside the gap is logged
// once it has passed, since the comparison is with what was LOGGED). Records
// the inputs as logged when it returns true.
bool fwu_diag_due(fwu_diag_t *d, const fwu_diag_in_t *in, uint32_t now_ms);

// The line, without the pads (main.c appends them). Returns snprintf's value.
int fwu_diag_format(char *buf, int cap, const fwu_diag_in_t *in, uint32_t now_ms);

#endif
