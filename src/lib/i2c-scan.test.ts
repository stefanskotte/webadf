import { describe, it, expect } from 'vitest';
import { i2cAddrsSchema, describeI2cScan, nameI2cAddr } from './i2c-scan';

// The board's boot I2C scan (fw 1.17.0, wifi-floppy/firmware/src/i2c_scan.h): the addresses that answered on
// i2c1, at most eight, 0x08-0x77. Telemetry: anything else is dropped, never a 400.
describe('i2cAddrsSchema', () => {
  it('accepts the list a board sends, and the empty list', () => {
    expect(i2cAddrsSchema.parse([40, 60])).toEqual([40, 60]);
    expect(i2cAddrsSchema.parse([])).toEqual([]);
    expect(i2cAddrsSchema.parse([8, 9, 10, 11, 12, 13, 14, 119])).toHaveLength(8);
  });
  it('refuses a reserved address, a non-integer, more than eight, or a non-array', () => {
    expect(i2cAddrsSchema.safeParse([7]).success).toBe(false);
    expect(i2cAddrsSchema.safeParse([0x78]).success).toBe(false);
    expect(i2cAddrsSchema.safeParse([40.5]).success).toBe(false);
    expect(i2cAddrsSchema.safeParse(['40']).success).toBe(false);
    expect(i2cAddrsSchema.safeParse([8, 9, 10, 11, 12, 13, 14, 15, 16]).success).toBe(false);
    expect(i2cAddrsSchema.safeParse('40,60').success).toBe(false);
    expect(i2cAddrsSchema.safeParse(null).success).toBe(false);
  });
});

describe('nameI2cAddr', () => {
  it('names the addresses this project meets, and leaves the rest as a number', () => {
    expect(nameI2cAddr(0x3c)).toBe('0x3c (display)');
    expect(nameI2cAddr(0x3d)).toBe('0x3d (display)');
    expect(nameI2cAddr(0x28)).toBe('0x28 (NFC reader, Si512)');
    expect(nameI2cAddr(0x24)).toBe('0x24 (NFC reader, PN532)');
    expect(nameI2cAddr(0x50)).toBe('0x50');
    expect(nameI2cAddr(0x08)).toBe('0x08');
  });
});

describe('describeI2cScan', () => {
  it('says nothing for a board that sends no scan (older firmware keeps today\'s card)', () => {
    expect(describeI2cScan('absent', null)).toBeNull();
    expect(describeI2cScan('present', null)).toBeNull();
    expect(describeI2cScan(null, null)).toBeNull();
  });
  it('a working reader: where it is', () => {
    expect(describeI2cScan('present', [0x28, 0x3c])).toEqual({ ok: true, line: 'NFC reader at 0x28', seen: null });
  });
  it('no reader, a display on the bus', () => {
    expect(describeI2cScan('absent', [0x3c])).toEqual({
      ok: false, line: 'No NFC reader found — nothing at 0x28', seen: 'I2C devices seen: 0x3c (display)',
    });
  });
  it('no reader and nothing at all on the bus', () => {
    expect(describeI2cScan('absent', [])).toEqual({
      ok: false, line: 'No NFC reader found — nothing at 0x28', seen: 'Nothing on the I2C bus',
    });
  });
  it('a PN532 on firmware before 1.18.0 (or a version not known): it needs the update', () => {
    const want = {
      ok: false, line: 'No NFC reader found — the PN532 at 0x24 needs firmware 1.18.0 or newer',
      seen: 'I2C devices seen: 0x24 (NFC reader, PN532), 0x3c (display)',
    };
    expect(describeI2cScan('absent', [0x24, 0x3c], '1.17.0+gabc1234')).toEqual(want);
    expect(describeI2cScan('absent', [0x24, 0x3c])).toEqual(want);
    expect(describeI2cScan('absent', [0x24, 0x3c], null)).toEqual(want);
  });
});

// fw 1.18.0: the board drives a PN532 at 0x24 as well as the Si512 at 0x28 (nfc_reader.h), the Si512 first.
describe('describeI2cScan, firmware 1.18.0 and newer', () => {
  const FW = '1.18.0+gabc1234';
  it('a working PN532: where it is', () => {
    expect(describeI2cScan('present', [0x24, 0x3c], FW)).toEqual({ ok: true, line: 'NFC reader at 0x24', seen: null });
    expect(describeI2cScan('present', [0x24], '1.19.2+gdeadbee')).toEqual({ ok: true, line: 'NFC reader at 0x24', seen: null });
  });
  it('both answered: the board uses the Si512, and says so', () => {
    expect(describeI2cScan('present', [0x24, 0x28, 0x3c], FW)).toEqual({ ok: true, line: 'NFC reader at 0x28', seen: null });
  });
  it('a PN532 answered at boot but is not working is not called "no NFC reader"', () => {
    const d = describeI2cScan('absent', [0x24, 0x3c], FW);
    expect(d).toEqual({
      ok: false, line: 'No working NFC reader — a device answered at 0x24 at boot, but the reader is not responding',
      seen: 'I2C devices seen: 0x24 (NFC reader, PN532), 0x3c (display)',
    });
    expect(d?.line).not.toMatch(/^No NFC reader/);
  });
  it('the Si512 address wins the not-responding line when both answered', () => {
    expect(describeI2cScan('absent', [0x24, 0x28], FW)?.line)
      .toBe('No working NFC reader — a device answered at 0x28 at boot, but the reader is not responding');
  });
  it('nothing at either address: both are named', () => {
    expect(describeI2cScan('absent', [0x3c], FW)).toEqual({
      ok: false, line: 'No NFC reader found — nothing at 0x28 or 0x24', seen: 'I2C devices seen: 0x3c (display)',
    });
    expect(describeI2cScan('absent', [], FW)?.line).toBe('No NFC reader found — nothing at 0x28 or 0x24');
  });
  it('older boards keep the old line for an empty 0x24', () => {
    expect(describeI2cScan('absent', [0x3c], '1.17.0+gabc1234')?.line).toBe('No NFC reader found — nothing at 0x28');
  });
  it('something answered at 0x28 at boot, but the reader is not responding', () => {
    expect(describeI2cScan('absent', [0x28])).toEqual({
      ok: false, line: 'No working NFC reader — a device answered at 0x28 at boot, but the reader is not responding',
      seen: 'I2C devices seen: 0x28 (NFC reader, Si512)',
    });
  });
  it('a reader state not yet reported reads like absent, with the scan beside it', () => {
    expect(describeI2cScan(null, [0x3c])?.line).toBe('No NFC reader found — nothing at 0x28');
  });
});
