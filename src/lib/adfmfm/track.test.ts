import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeTrack } from './track';
import { syntheticAdf, type SyntheticKind } from './synthetic';
import { TRACK_BYTES, TRACK_DATA_BYTES, GAP_LEAD_BYTES, SECTOR_MFM_BYTES, SECTORS } from './constants';

const KINDS: SyntheticKind[] = ['zeros', 'ones', 'prng', 'bootblock'];
const FIXTURE_TRACKS = [0, 1, 80, 159];

function golden(kind: SyntheticKind, trackNo: number): Uint8Array {
  // This project is ESM ("type": "module"), so __dirname does not exist.
  const name = `${kind}-t${String(trackNo).padStart(3, '0')}.mfm`;
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return new Uint8Array(readFileSync(path));
}

function trackOf(kind: SyntheticKind, trackNo: number): Uint8Array {
  const adf = syntheticAdf(kind);
  return adf.subarray(trackNo * TRACK_DATA_BYTES, (trackNo + 1) * TRACK_DATA_BYTES);
}

describe('encodeTrack', () => {
  for (const kind of KINDS) {
    for (const trackNo of FIXTURE_TRACKS) {
      it(`is byte-identical to Greaseweazle for ${kind} track ${trackNo}`, () => {
        const ours = encodeTrack(trackOf(kind, trackNo), trackNo);
        const theirs = golden(kind, trackNo);
        // Report the first divergence rather than dumping 12,668 bytes.
        const at = ours.findIndex((b, i) => b !== theirs[i]);
        expect(at, `first differing byte at offset ${at}`).toBe(-1);
        expect(ours).toEqual(theirs);
      });
    }
  }

  it('returns exactly TRACK_BYTES', () => {
    expect(encodeTrack(trackOf('prng', 0), 0).length).toBe(TRACK_BYTES);
  });

  it('places sync at 256 + n * 1088 for all 11 sectors', () => {
    const t = encodeTrack(trackOf('prng', 3), 3);
    for (let n = 0; n < SECTORS; n++) {
      const at = GAP_LEAD_BYTES + n * SECTOR_MFM_BYTES;
      expect(Array.from(t.slice(at, at + 4)), `sector ${n}`).toEqual([0x44, 0x89, 0x44, 0x89]);
    }
  });

  it('emits both gaps as 0xAA', () => {
    const t = encodeTrack(trackOf('prng', 3), 3);
    const endOfSectors = GAP_LEAD_BYTES + SECTORS * SECTOR_MFM_BYTES;
    expect(t.slice(0, GAP_LEAD_BYTES).every((b) => b === 0xaa)).toBe(true);
    expect(t.slice(endOfSectors).every((b) => b === 0xaa)).toBe(true);
    expect(t.length - endOfSectors).toBe(444);
  });

  it('rejects a track that is not exactly 5632 bytes', () => {
    expect(() => encodeTrack(new Uint8Array(5631), 0)).toThrow(/5632/);
    expect(() => encodeTrack(new Uint8Array(5633), 0)).toThrow(/5632/);
  });

  it('rejects a track number outside 0..159', () => {
    expect(() => encodeTrack(trackOf('prng', 0), -1)).toThrow(/track number/i);
    expect(() => encodeTrack(trackOf('prng', 0), 160)).toThrow(/track number/i);
  });

  it('encodes the track number into every sector header', () => {
    // Track 159's sector 0 header is [0xFF, 159, 0, 11]; split and clock-filled
    // that is 55 45 2a a5 55 15 2a a9. Verified by hand against the reference.
    const t = encodeTrack(trackOf('prng', 159), 159);
    const at = GAP_LEAD_BYTES + 4;
    expect(Buffer.from(t.slice(at, at + 8)).toString('hex')).toBe('55452aa555152aa9');
  });
});
