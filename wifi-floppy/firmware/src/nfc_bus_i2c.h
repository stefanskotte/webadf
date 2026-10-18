#ifndef NFC_BUS_I2C_H
#define NFC_BUS_I2C_H
// The tag readers' buses on the board: the Si512 at i2c1 0x28 (spec
// 2026-09-25 §3, §4.3), and the PN532 at i2c1 0x24 (UM0701-02 §6.2.4: 8-bit
// address 0x48).
//
// Device-only, and deliberately nothing but transfers: every decision the
// reader makes lives in nfc_reader.c / nfc_si512.c / nfc_pn532.c, which run
// on the host against test/si512_fake.c and test/pn532_fake.c through the
// same nfc_bus_t and nfc_frame_bus_t.
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

#define PN532_I2C_ADDR       0x24
// A PN532 transfer is a whole frame: up to 28 bytes written or 27 read here
// (nfc_reader.h), ~2.6 ms at the no-panel 100 kHz. Waking from LowVbat it
// also stretches SCL ~1 ms, up to 2 ms (UM0701-02 §6.3.3.3, AN10609 §2.5.2).
// Bounded all the same, with room for both: a bus held low by a loose lead
// costs core0 at most this, once per step.
#define PN532_I2C_TIMEOUT_US 8000

// Fills `bus` with the Si512's i2c1 transfers.
void nfc_bus_i2c(nfc_bus_t *bus);

// Fills `bus` with the PN532's i2c1 transfers.
void nfc_frame_bus_i2c(nfc_frame_bus_t *bus);

#endif
