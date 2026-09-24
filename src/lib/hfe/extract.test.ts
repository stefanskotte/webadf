import { describe, it, expect } from 'vitest';
import { parseHfe, reverseBits, type HfeDisk, type HfeSide } from './parse';
import { decodeSectors, hasAmigaBootTrack, extractAdf } from './extract';
import { fixture, zeroSide } from './__fixtures__/load';
import { sparseAdf } from './__fixtures__/source';

function disk(bytes: Uint8Array): HfeDisk {
  const r = parseHfe(bytes);
  if (!r.ok) throw new Error(r.reason);
  return r.disk;
}

/** The same revolution, started `k` bits later: sync words land at non-byte offsets, and a sector straddles the end. */
function rotate(side: HfeSide, k: number): HfeSide {
  const out = new Uint8Array(side.bytes.length);
  for (let i = 0; i < side.bits; i++) {
    const p = (i + k) % side.bits;
    if ((side.bytes[p >>> 3] >>> (7 - (p & 7))) & 1) out[i >>> 3] |= 0x80 >> (i & 7);
  }
  return { bits: side.bits, bytes: out };
}

describe('extractAdf', () => {
  it('recovers the exact source ADF from Greaseweazle HFE v1', () => {
    const x = extractAdf(disk(fixture('clean')));
    if (!x.ok) throw new Error(x.reason);
    expect(Buffer.compare(Buffer.from(x.adf), Buffer.from(sparseAdf()))).toBe(0);
  });

  it('names the track when sectors are missing (cylinder 40 side 1 = track 81)', () => {
    const x = extractAdf(disk(zeroSide(fixture('clean'), 40, 1, 2000, 6000)));
    expect(x.ok).toBe(false);
    if (!x.ok) expect(x.reason).toMatch(/^Track 81 \(cylinder 40, side 1\): \d+ of 11 sectors readable$/);
  });
});

describe('decodeSectors', () => {
  it('finds all 11 sectors at any bit offset, including across the index', () => {
    const d = disk(fixture('clean'));
    for (const k of [3, 50_001, 12_668 * 4 + 5]) {
      for (let t = 0; t < 160; t++) {
        expect(decodeSectors(rotate(d.tracks[t >> 1][t & 1], k), t).size, `rotate ${k} track ${t}`).toBe(11);
      }
    }
  });

  it('finds nothing if the LSB-first bytes were not reversed (bit-order guard)', () => {
    const side = disk(fixture('clean')).tracks[0][0];
    const raw = { bits: side.bits, bytes: side.bytes.map((b) => reverseBits(b)) };
    expect(decodeSectors(raw, 0).size).toBe(0);
  });

  it('refuses a sector whose header names another track', () => {
    const d = disk(fixture('clean'));
    expect(decodeSectors(d.tracks[3][0], 7).size).toBe(0);
  });
});

describe('hasAmigaBootTrack', () => {
  it('is true for the Amiga fixture and false for the PC one', () => {
    expect(hasAmigaBootTrack(disk(fixture('clean')))).toBe(true);
    expect(hasAmigaBootTrack(disk(fixture('pc')))).toBe(false);
  });

  it('is false when track 0 side 0 is blank', () => {
    const r = fixture('clean');
    expect(hasAmigaBootTrack(disk(zeroSide(r, 0, 0, 0, 12_668)))).toBe(false);
  });
});
