#ifndef NFC_BUS_I2C_H
#define NFC_BUS_I2C_H
// The Si512 reader's bus on the board: i2c1 at 0x28 (spec 2026-09-25 §3, §4.3).
//
// Device-only, and deliberately nothing but two transfers: every decision the
// reader makes lives in nfc_reader.c, which runs on the host against
// test/si512_fake.c through the same nfc_bus_t.
//
// It does NOT initialise i2c1. i2c_probe_bus() already did, at boot, and
// ssd1306_selftest() raised it to 400 kHz if a panel answered; with no panel
// it stays at the probe's 100 kHz. Re-initialising here would reset the
// controller under the panel's feet and undo that choice.
#include "nfc_reader.h"

#define NFC_I2C_ADDR       0x28
// Spec §4.3: every transfer is bounded. A present chip answers in well under
// 1 ms; this only matters for a bus held low by a loose lead.
#define NFC_I2C_TIMEOUT_US 5000

// Fills `bus` with the i2c1 transfers.
void nfc_bus_i2c(nfc_bus_t *bus);

#endif
