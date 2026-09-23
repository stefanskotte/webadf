#include "fw_stage.h"
#include <string.h>

void fw_stage_begin(fw_stage_t *s, uint8_t *buf, uint32_t cap) {
    s->buf = buf; s->cap = cap; s->got = 0; s->overflow = false;
    sha256_init(&s->sha);
}
void fw_stage_sink(void *ctx, const uint8_t *b, int n) {
    fw_stage_t *s = ctx;
    if (n <= 0 || s->overflow) return;
    if ((uint32_t)n > s->cap - s->got) { s->overflow = true; return; }
    memcpy(s->buf + s->got, b, (size_t)n);
    sha256_update(&s->sha, b, (size_t)n);
    s->got += (uint32_t)n;
}
bool fw_stage_matches(fw_stage_t *s, uint32_t expect_len, const char *expect_sha_hex) {
    if (s->overflow || s->got != expect_len) return false;
    uint8_t d[32]; char hex[65];
    sha256_final(&s->sha, d);
    sha256_hex(d, hex);
    return strcmp(hex, expect_sha_hex) == 0;
}
