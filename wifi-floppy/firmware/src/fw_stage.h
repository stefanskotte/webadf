#ifndef FW_STAGE_H
#define FW_STAGE_H
#include "sha256.h"
#include <stdint.h>
#include <stdbool.h>

typedef struct {
    uint8_t *buf;
    uint32_t cap;
    uint32_t got;
    bool overflow;
    sha256_t sha;
} fw_stage_t;

void fw_stage_begin(fw_stage_t *s, uint8_t *buf, uint32_t cap);
void fw_stage_sink(void *ctx, const uint8_t *b, int n);
bool fw_stage_matches(fw_stage_t *s, uint32_t expect_len, const char *expect_sha_hex);

#endif
