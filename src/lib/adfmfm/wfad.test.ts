import { describe, it, expect } from 'vitest';
import { writeWfad, writeWfadDd, WfadFormatError } from './wfad';
import { ADF_BYTES, ADF_HD_BYTES, WFAD_BYTES } from './constants';

// The header, spelled out byte by byte from the spec's table (HD spec §4.4),
// NOT computed from the constants under test: a wrong constant must fail here.
// wifi-floppy/firmware/test/test_image_loader_wfad.c holds the board's side to
// the same 16 bytes.
const HEADER = [
  0x57, 0x46, 0x41, 0x44,   // "WFAD"
  0x01, 0x00, 0x00, 0x00,   // version 1
  0xa0, 0x00, 0x00, 0x00,   // 160 tracks
  0x16, 0x00, 0x00, 0x00,   // 22 sectors per track
];

// synthetic.ts's xorshift32, over an HD-sized image. Synthetic: no real disk.
function hdAdf(): Uint8Array {
  const adf = new Uint8Array(1_802_240);
  let x = 0x12345678;
  for (let i = 0; i < adf.length; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    adf[i] = x & 0xff;
  }
  return adf;
}

describe('writeWfad', () => {
  it('is the spec header followed by the ADF, byte for byte', () => {
    const adf = hdAdf();
    const out = writeWfad(adf);
    expect(out.length).toBe(1_802_256);
    expect(WFAD_BYTES).toBe(1_802_256);
    expect(Array.from(out.subarray(0, 16))).toEqual(HEADER);
    expect(Buffer.from(out.subarray(16)).equals(Buffer.from(adf))).toBe(true);
  });

  it('track t starts at 16 + t * 11,264 (track-major, 22 x 512 bytes each)', () => {
    const adf = hdAdf();
    const out = writeWfad(adf);
    for (const t of [0, 1, 80, 159]) {
      expect(out[16 + t * 11_264]).toBe(adf[t * 22 * 512]);
      expect(out[16 + t * 11_264 + 11_263]).toBe(adf[t * 22 * 512 + 11_263]);
    }
  });

  it('throws on anything that is not exactly one HD ADF', () => {
    expect(() => writeWfad(new Uint8Array(ADF_BYTES))).toThrow(WfadFormatError);
    expect(() => writeWfad(new Uint8Array(ADF_HD_BYTES - 1))).toThrow(WfadFormatError);
    expect(() => writeWfad(new Uint8Array(ADF_HD_BYTES + 1))).toThrow(WfadFormatError);
    expect(() => writeWfad(new Uint8Array(0))).toThrow(WfadFormatError);
  });
});

describe('writeWfadDd (PaulaNET driver disk, plan 2026-10-12 ruling 24)', () => {
  it('the 16-byte header names 11 sectors, then the ADF unchanged', () => {
    const adf = new Uint8Array(ADF_BYTES).map((_, i) => i & 0xff);
    const out = writeWfadDd(adf);
    expect(out.length).toBe(16 + 901120);
    expect([...out.slice(0, 16)]).toEqual([0x57, 0x46, 0x41, 0x44, 1, 0, 0, 0, 0xa0, 0, 0, 0, 0x0b, 0, 0, 0]);
    expect(out.slice(16)).toEqual(adf);
  });
  it('throws on anything that is not exactly one DD ADF', () => {
    expect(() => writeWfadDd(new Uint8Array(ADF_HD_BYTES))).toThrow(WfadFormatError);
    expect(() => writeWfadDd(new Uint8Array(ADF_BYTES - 1))).toThrow(WfadFormatError);
  });
});
