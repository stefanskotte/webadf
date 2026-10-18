import { z } from 'zod';
import { firmwareAtLeast } from '@/lib/firmware-version';

/**
 * The board's boot I2C scan (fw 1.17.0, wifi-floppy/firmware/src/i2c_scan.h): the addresses that answered on
 * i2c1 at boot, at most eight, never a reserved one (0x00-0x07, 0x78-0x7f). It is what makes a remote "no NFC
 * reader" diagnosable without a USB log. Stored in devices.i2c_addrs; null = a board that sends no scan.
 */
export const I2C_SCAN_MAX = 8;
export const i2cAddrsSchema = z.array(z.number().int().min(0x08).max(0x77)).max(I2C_SCAN_MAX);

/** The Si512 module this firmware drives (nfc_bus_i2c.c). */
export const NFC_READER_ADDR = 0x28;
/** A PN532 module (UM0701-02: 8-bit 0x48), driven from fw 1.18.0 (nfc_pn532.c). The board tries the Si512 first. */
export const PN532_ADDR = 0x24;
export const PN532_FIRMWARE = '1.18.0';

const hex = (a: number) => `0x${a.toString(16).padStart(2, '0')}`;

/** Addresses this project is likely to meet, named so a bare number is not the whole answer. Not exhaustive:
 *  an unknown one is shown plainly rather than guessed at (the firmware's own rule, i2c_probe.c known()). */
const KNOWN: Record<number, string> = {
  0x28: 'NFC reader, Si512',
  0x24: 'NFC reader, PN532',
  0x3c: 'display',
  0x3d: 'display',
};

export function nameI2cAddr(a: number): string {
  return KNOWN[a] ? `${hex(a)} (${KNOWN[a]})` : hex(a);
}

export type I2cScanText = { ok: boolean; line: string; seen: string | null };

/** The card's NFC line in plain words, from the reader's state, the boot scan and the firmware version (a PN532
 *  works from 1.18.0). null when the board sent no scan (older firmware): the card then shows what it showed before. */
export function describeI2cScan(
  nfcReader: 'present' | 'absent' | null, addrs: number[] | null, firmwareVersion: string | null = null,
): I2cScanText | null {
  if (addrs === null) return null;
  const si512 = addrs.includes(NFC_READER_ADDR);
  const pn532 = addrs.includes(PN532_ADDR);
  const pnOk = firmwareAtLeast(firmwareVersion, PN532_FIRMWARE);
  // The board's own order (nfc_reader.c st_absent): the Si512 if it answers, else the PN532.
  const at = si512 ? NFC_READER_ADDR : pn532 && pnOk ? PN532_ADDR : null;
  if (nfcReader === 'present') return { ok: true, line: at !== null ? `NFC reader at ${hex(at)}` : 'NFC reader found', seen: null };
  const line = at !== null
    ? `No working NFC reader — a device answered at ${hex(at)} at boot, but the reader is not responding`
    : pn532
      ? `No NFC reader found — the PN532 at ${hex(PN532_ADDR)} needs firmware ${PN532_FIRMWARE} or newer`
      : pnOk
        ? `No NFC reader found — nothing at ${hex(NFC_READER_ADDR)} or ${hex(PN532_ADDR)}`
        : `No NFC reader found — nothing at ${hex(NFC_READER_ADDR)}`;
  const seen = addrs.length === 0 ? 'Nothing on the I2C bus' : `I2C devices seen: ${addrs.map(nameI2cAddr).join(', ')}`;
  return { ok: false, line, seen };
}
