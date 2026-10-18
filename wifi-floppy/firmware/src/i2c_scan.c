#include "i2c_scan.h"
#include <stdio.h>

void i2c_scan_add(i2c_scan_t *s, uint8_t addr) {
    if (addr < 0x08 || addr > 0x77) return;     // reserved by the I2C spec, never probed
    if (s->n >= I2C_SCAN_MAX) return;
    s->addr[s->n++] = addr;
}

void i2c_scan_done(i2c_scan_t *s) { s->done = true; }

bool i2c_scan_has(const i2c_scan_t *s, uint8_t addr) {
    if (!s || !s->done) return false;
    for (uint8_t i = 0; i < s->n && i < I2C_SCAN_MAX; i++)
        if (s->addr[i] == addr) return true;
    return false;
}

int i2c_scan_json(const i2c_scan_t *s, char *out, size_t cap) {
    if (cap == 0) return 0;
    out[0] = '\0';
    if (!s || !s->done) return 0;
    // Written in place, no scratch buffer: this runs on core1, whose stack is
    // measured tight (device_client.c's STACK note).
    size_t k = (size_t)snprintf(out, cap, ",\"i2c\":[");
    const uint8_t n = s->n < I2C_SCAN_MAX ? s->n : I2C_SCAN_MAX;
    for (uint8_t i = 0; i < n && k < cap; i++)
        k += (size_t)snprintf(out + k, cap - k, i ? ",%u" : "%u", (unsigned)s->addr[i]);
    if (k < cap) k += (size_t)snprintf(out + k, cap - k, "]");
    if (k >= cap) {                    // never a cut-off key: a broken body loses the report
        out[0] = '\0';
        return 0;
    }
    return (int)k;
}
