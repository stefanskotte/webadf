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
void fwu_on_instruction(fwu_t *u, const fw_offer_t *offer_or_null, fw_verdict_t verdict);
bool fwu_step(fwu_t *u, const fwu_ops_t *ops, fw_state_t *st, bool idle, uint32_t now_ms);
const char *fwu_state_text(const fwu_t *u);   // NULL when there is nothing to report
const char *fwu_error_text(const fwu_t *u);   // NULL unless FAILED

#endif
