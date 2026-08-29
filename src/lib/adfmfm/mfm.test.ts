import { describe, it, expect } from 'vitest';
import { splitOddEven, joinOddEven, fillClockBits, checksum } from './mfm';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const bin = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));

describe('splitOddEven', () => {
  it('matches the reference for a mixed input', () => {
    expect(hex(splitOddEven(bin('ff0053a5')))).toBe('5500015055005105');
  });

  it('doubles the length and leaves the 0xAA lanes empty', () => {
    const out = splitOddEven(bin('ff0053a5'));
    expect(out.length).toBe(8);
    expect(out.every((b) => (b & 0xaa) === 0)).toBe(true);
  });

  it('puts all odd bits before all even bits, not interleaved', () => {
    // A single 0xFF byte: odd half then even half, never 0x55 0x55 interleaved
    // with anything between them.
    expect(hex(splitOddEven(bin('ff')))).toBe('5555');
    expect(hex(splitOddEven(bin('ff00')))).toBe('55005500');
  });
});

describe('joinOddEven', () => {
  it('inverts splitOddEven', () => {
    expect(hex(joinOddEven(splitOddEven(bin('ff0053a5'))))).toBe('ff0053a5');
  });

  it('inverts splitOddEven for every single-byte value', () => {
    for (let i = 0; i < 256; i++) {
      const v = Uint8Array.of(i);
      expect(joinOddEven(splitOddEven(v))).toEqual(v);
    }
  });
});

describe('checksum', () => {
  it('matches the reference for sector 0 of track 0', () => {
    const hdrLabel = new Uint8Array(20);
    hdrLabel.set([0xff, 0, 0, 11], 0);
    expect(checksum(hdrLabel)).toBe(0x00000004);
  });

  it('matches the reference for sector 5 of track 79', () => {
    const hdrLabel = new Uint8Array(20);
    hdrLabel.set([0xff, 79, 5, 6], 0);
    expect(checksum(hdrLabel)).toBe(0x00400505);
  });

  it('matches the reference for a short input', () => {
    expect(checksum(bin('01020304'))).toBe(0x01010004);
  });

  it('never sets a bit outside 0x55555555', () => {
    const rnd = new Uint8Array(512);
    for (let i = 0; i < rnd.length; i++) rnd[i] = (i * 37 + 11) & 0xff;
    expect(checksum(rnd) & ~0x55555555).toBe(0);
  });

  it('refuses a length that is not a multiple of 4', () => {
    // Otherwise the trailing partial word silently checksums phantom zeroes.
    expect(() => checksum(new Uint8Array(6))).toThrow(/multiple of 4/);
  });

  it('is zero for the degenerate all-zero and all-0xFF blocks', () => {
    // Documented so nobody mistakes these for evidence the checksum works —
    // this is exactly why the prng and bootblock fixtures exist.
    expect(checksum(new Uint8Array(512))).toBe(0);
    expect(checksum(new Uint8Array(512).fill(0xff))).toBe(0);
  });
});

describe('fillClockBits', () => {
  it('turns a run of zero bytes into 0xAA', () => {
    const t = bin('00000000');
    fillClockBits(t);
    expect(hex(t)).toBe('aaaaaaaa');
  });

  it('leaves the 0x4489 sync pattern untouched', () => {
    const t = bin('44894489');
    fillClockBits(t);
    expect(hex(t)).toBe('44894489');
  });

  it('preserves sync when it is surrounded by gap', () => {
    const t = bin('004489448900');
    fillClockBits(t);
    expect(hex(t)).toBe('aa448944892a');
  });

  it('leaves a byte that already carries clock bits alone', () => {
    const t = bin('5555');
    fillClockBits(t);
    expect(hex(t)).toBe('5555');
  });

  it('carries state across the byte boundary', () => {
    // 0x01 0x00 -> 0xa9 0x2a. The second byte's leading clock bit depends on
    // the last data bit of the first, so a per-byte implementation gets 0xaa.
    const t = bin('0100');
    fillClockBits(t);
    expect(hex(t)).toBe('a92a');
  });

  it('mutates in place and returns nothing', () => {
    const t = bin('0000');
    expect(fillClockBits(t)).toBeUndefined();
    expect(hex(t)).toBe('aaaa');
  });
});
