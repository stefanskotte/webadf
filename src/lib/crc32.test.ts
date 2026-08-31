import { describe, it, expect } from 'vitest';
import { crc32 } from './crc32';

const enc = (s: string) => new TextEncoder().encode(s);

describe('crc32', () => {
  it('matches known vectors', () => {
    expect(crc32(enc(''))).toBe('00000000');
    expect(crc32(enc('a'))).toBe('e8b7be43');
    expect(crc32(enc('abc'))).toBe('352441c2');
    expect(crc32(enc('123456789'))).toBe('cbf43926');
  });

  it('zero-pads a small result to 8 hex chars', () => {
    // The point of returning a string: TOSEC writes crc as 8 hex digits, and
    // a numeric 0 formatted with toString(16) would be "0", never matching.
    expect(crc32(enc('')).length).toBe(8);
  });

  it('is lowercase, so comparisons need no normalising at the call site', () => {
    expect(crc32(enc('abc'))).toBe(crc32(enc('abc')).toLowerCase());
  });

  it('handles bytes above 0x7f', () => {
    expect(crc32(new Uint8Array([0x00, 0xff, 0x80, 0x7f]))).toMatch(/^[0-9a-f]{8}$/);
  });
});
