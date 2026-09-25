#ifndef NFC_PROBE_H
#define NFC_PROBE_H
// Which NFC reader is on I2C1, asked of the chip itself, logged raw.
//
// The bench module was sold as a PN532, but the boot scan found it at 0x28 --
// where a PN532 cannot be (its address is fixed at 0x24) and where an MFRC522
// wired for I2C lands. Its markings are sanded off. So this asks both ways and
// logs the bytes that came back, rather than trusting the listing or the
// address:
//
//   * RC522 family: read VersionReg (0x37) at 0x28.
//     0x91/0x92 = NXP MFRC522, 0x88 = FM17522 clone, anything else = unknown.
//   * PN532: send GetFirmwareVersion at 0x24 AND 0x28, and log the response
//     frame. A real PN532 answers D5 03 with IC byte 0x32.
//
// Bring-up only; the first step of the NFC work (HANDOFF §4, NFC backlog).
// Call once from core0's init, AFTER i2c_probe_bus() has set up the bus.
// Bounded: at most a few hundred ms, and only when something answered at
// 0x24 or 0x28 in a quick address check.

void nfc_probe_identify(void);

#endif
