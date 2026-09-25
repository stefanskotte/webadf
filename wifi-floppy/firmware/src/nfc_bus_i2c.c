#include "nfc_bus_i2c.h"
#include "hardware/i2c.h"

// One register write: the address, then the value, in one transfer.
static bool bus_wr(void *ctx, uint8_t reg, uint8_t v) {
    (void)ctx;
    uint8_t b[2] = { reg, v };
    return i2c_write_timeout_us(i2c1, NFC_I2C_ADDR, b, 2, false, NFC_I2C_TIMEOUT_US) == 2;
}

// One register read: the address with no stop (a repeated start follows),
// then one byte. The same shape the bench-proven identify probe used
// (branch nfc-identify) to read both kit tags.
static int bus_rd(void *ctx, uint8_t reg) {
    (void)ctx;
    uint8_t v;
    if (i2c_write_timeout_us(i2c1, NFC_I2C_ADDR, &reg, 1, true, NFC_I2C_TIMEOUT_US) != 1) return -1;
    if (i2c_read_timeout_us(i2c1, NFC_I2C_ADDR, &v, 1, false, NFC_I2C_TIMEOUT_US) != 1) return -1;
    return v;
}

void nfc_bus_i2c(nfc_bus_t *bus) {
    bus->wr = bus_wr;
    bus->rd = bus_rd;
    bus->ctx = NULL;
}
