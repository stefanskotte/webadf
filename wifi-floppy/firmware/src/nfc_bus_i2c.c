#include "nfc_bus_i2c.h"
#include "hardware/i2c.h"
#include "board_hw.h"

// One register write: the address, then the value, in one transfer.
static bool bus_wr(void *ctx, uint8_t reg, uint8_t v) {
    (void)ctx;
    uint8_t b[2] = { reg, v };
    return i2c_write_timeout_us(board_i2c(), NFC_I2C_ADDR, b, 2, false, NFC_I2C_TIMEOUT_US) == 2;
}

// One register read: the address with no stop (a repeated start follows),
// then one byte. The same shape the bench-proven identify probe used
// (branch nfc-identify) to read both kit tags.
static int bus_rd(void *ctx, uint8_t reg) {
    (void)ctx;
    uint8_t v;
    if (i2c_write_timeout_us(board_i2c(), NFC_I2C_ADDR, &reg, 1, true, NFC_I2C_TIMEOUT_US) != 1) return -1;
    if (i2c_read_timeout_us(board_i2c(), NFC_I2C_ADDR, &v, 1, false, NFC_I2C_TIMEOUT_US) != 1) return -1;
    return v;
}

void nfc_bus_i2c(nfc_bus_t *bus) {
    bus->wr = bus_wr;
    bus->rd = bus_rd;
    bus->ctx = NULL;
}

// The PN532's two transfers (UM0701-02 §6.2.4): a whole frame written, and a
// read that is the status byte plus whatever follows it, both ended by a STOP
// -- a STOP after a not-ready status byte is what the manual asks for.
static bool fbus_wr(void *ctx, const uint8_t *buf, int n) {
    (void)ctx;
    return i2c_write_timeout_us(board_i2c(), PN532_I2C_ADDR, buf, (size_t)n, false,
                                PN532_I2C_TIMEOUT_US) == n;
}

static bool fbus_rd(void *ctx, uint8_t *buf, int n) {
    (void)ctx;
    return i2c_read_timeout_us(board_i2c(), PN532_I2C_ADDR, buf, (size_t)n, false,
                               PN532_I2C_TIMEOUT_US) == n;
}

void nfc_frame_bus_i2c(nfc_frame_bus_t *bus) {
    bus->wr = fbus_wr;
    bus->rd = fbus_rd;
    bus->ctx = NULL;
}
