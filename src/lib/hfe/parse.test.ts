import { describe, it, expect } from 'vitest';
import { parseHfe, reverseBits } from './parse';
import { HFE_V3_REFUSAL } from './messages';
import { fixture, setByte, setTrackLength, sideRange } from './__fixtures__/load';

const reasonOf = (b: Uint8Array) => {
  const r = parseHfe(b);
  if (r.ok) throw new Error('expected a refusal');
  return r.reason;
};

describe('parseHfe', () => {
  it('reads the clean v1 fixture: 80 cylinders, two 12,668-byte sides each', () => {
    const r = parseHfe(fixture('clean'));
    if (!r.ok) throw new Error(r.reason);
    expect(r.disk.cylinders).toBe(80);
    expect(r.disk.bitRate).toBe(253);
    expect(r.disk.encoding).toBe(0xff);
    expect(r.disk.tracks).toHaveLength(80);
    for (const [s0, s1] of r.disk.tracks) {
      expect(s0.bytes.length).toBe(12_668);
      expect(s0.bits).toBe(12_668 * 8);
      expect(s1.bytes.length).toBe(12_668);
    }
  });

  it('de-interleaves and bit-reverses: side 1 byte 300 is the file byte at block 1, offset 256+44, reversed', () => {
    const b = fixture('clean');
    const r = parseHfe(b);
    if (!r.ok) throw new Error(r.reason);
    const at = sideRange(b, 5, 1).at(300);
    expect(r.disk.tracks[5][1].bytes[300]).toBe(reverseBits(b[at]));
  });

  it('reverseBits is a bit mirror', () => {
    expect(reverseBits(0x01)).toBe(0x80);
    expect(reverseBits(0x44)).toBe(0x22);
    expect(reverseBits(0x89)).toBe(0x91);
    for (let i = 0; i < 256; i++) expect(reverseBits(reverseBits(i))).toBe(i);
  });

  it('refuses HFE v3 by signature', () => {
    expect(reasonOf(fixture('v3'))).toBe(HFE_V3_REFUSAL);
  });

  it('refuses formatrevision 1 (HFE v2) with the same message', () => {
    expect(reasonOf(setByte(fixture('clean'), 8, 1))).toBe(HFE_V3_REFUSAL);
  });

  it('refuses a non-HFE file', () => {
    expect(reasonOf(new Uint8Array(901_120))).toMatch(/^Not an HFE file/);
    expect(reasonOf(new Uint8Array(10))).toMatch(/^Not an HFE file/);
  });

  it('accepts encodings 0x00, 0x01 and 0xFF; refuses FM (0x02, 0x03) and anything else', () => {
    for (const e of [0x00, 0x01, 0xff]) expect(parseHfe(setByte(fixture('clean'), 11, e)).ok).toBe(true);
    for (const e of [0x02, 0x03, 0x06]) expect(reasonOf(setByte(fixture('clean'), 11, e))).toMatch(/not MFM/);
  });

  it('accepts bit rates 238..262 and refuses 237, 263 and 500', () => {
    const withRate = (r: number) => setByte(setByte(fixture('clean'), 12, r & 0xff), 13, r >>> 8);
    expect(parseHfe(withRate(238)).ok).toBe(true);
    expect(parseHfe(withRate(262)).ok).toBe(true);
    for (const r of [237, 263, 500]) expect(reasonOf(withRate(r))).toMatch(/double-density/);
  });

  it('refuses one side and refuses fewer than 80 or more than 84 cylinders', () => {
    expect(reasonOf(setByte(fixture('clean'), 10, 1))).toMatch(/double-sided/);
    expect(reasonOf(setByte(fixture('clean'), 9, 79))).toMatch(/cylinders/);
    expect(reasonOf(setByte(fixture('clean'), 9, 85))).toMatch(/cylinders/);
  });

  it('refuses a truncated file and an empty cylinder, never throws', () => {
    const b = fixture('clean');
    expect(reasonOf(b.subarray(0, b.length - 600))).toMatch(/Truncated/);
    expect(reasonOf(setTrackLength(b, 7, 0))).toMatch(/Cylinder 7 is empty/);
    // Cylinder 79's track-table offset pointed far past the end of the file.
    const lut79 = 512 + 79 * 4;
    expect(reasonOf(setByte(setByte(b, lut79, 0xff), lut79 + 1, 0xff))).toMatch(/Truncated HFE file: cylinder 79/);
  });
});
