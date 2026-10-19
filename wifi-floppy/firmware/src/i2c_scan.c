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

i2c_rec_t i2c_recover_action(bool sda_high, bool scl_high, int pulses) {
    if (!scl_high) return I2C_REC_SCL_HELD;
    if (sda_high) return pulses == 0 ? I2C_REC_IDLE : I2C_REC_STOP;
    return pulses < 9 ? I2C_REC_CLOCK : I2C_REC_STUCK;
}

// SCL high within I2C_SCL_WAIT_US (a stretch), or false (held).
static bool scl_wait(const i2c_lines_t *io) {
    const uint32_t t0 = io->now_us(io->ctx);
    while (!io->scl(io->ctx)) {
        if (io->now_us(io->ctx) - t0 >= I2C_SCL_WAIT_US) return false;
        io->delay_us(io->ctx, 10);
    }
    return true;
}

i2c_rec_t i2c_bus_clear(const i2c_lines_t *io, int *pulses_out) {
    io->set_scl(io->ctx, false);
    io->set_sda(io->ctx, false);
    io->delay_us(io->ctx, 10);
    int pulses = 0;
    i2c_rec_t a;
    for (;;) {
        const bool scl_high = scl_wait(io);
        a = i2c_recover_action(io->sda(io->ctx), scl_high, pulses);
        if (a != I2C_REC_CLOCK) break;
        io->set_scl(io->ctx, true);  io->delay_us(io->ctx, 5);   // 100 kHz, the probe's own rate
        io->set_scl(io->ctx, false); io->delay_us(io->ctx, 5);
        pulses++;
    }
    if (a == I2C_REC_STOP) {                       // SCL high, SDA high: make it a STOP -- SDA low, then up
        io->set_scl(io->ctx, true);  io->delay_us(io->ctx, 5);
        io->set_sda(io->ctx, true);  io->delay_us(io->ctx, 5);
        io->set_scl(io->ctx, false); io->delay_us(io->ctx, 5);
        (void)scl_wait(io);
        io->set_sda(io->ctx, false); io->delay_us(io->ctx, 5);
    }
    *pulses_out = pulses;
    return a;
}
