import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeTrack, decodeTrack, TrackDecodeError } from './track';
import { checksum } from './mfm';
import { syntheticAdf, type SyntheticKind } from './synthetic';
import { TRACK_BYTES, TRACK_DATA_BYTES, GAP_LEAD_BYTES, GAP_TRAIL_BYTES, SECTOR_MFM_BYTES, SECTORS } from './constants';

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
    expect(t.length - endOfSectors).toBe(GAP_TRAIL_BYTES);
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

  it('folds the label into the header checksum, which no zero-label fixture can prove', () => {
    const header = Uint8Array.of(0xff, 0, 0, 11);
    const zeroLabel = new Uint8Array(16);
    const nonZeroLabel = new Uint8Array(16).fill(0x5a);
    // A uniform 16-byte fill is four identical 32-bit words, and XOR of an
    // even count of identical words is zero -- so an unbroken fill of 0x5A
    // would cancel out exactly like the all-zero label does, silently
    // defeating this assertion. Break the symmetry in the last byte so the
    // four label words don't XOR away to nothing.
    nonZeroLabel[15] = 0x5b;

    // (a) The label in every fixture is 16 zero bytes, and checksum XORs
    // big-endian u32 words: folding in four all-zero words is arithmetically
    // a no-op. So checksum(header) and checksum(header ++ zeroLabel) are
    // numerically identical for every track of every disk, and no fixture
    // comparison can ever tell apart a header checksum that covers the label
    // from one that doesn't. Do not delete this as "redundant" — it is the
    // only thing standing between that bug and a green suite.
    const headerAndZeroLabel = new Uint8Array(header.length + zeroLabel.length);
    headerAndZeroLabel.set(header, 0);
    headerAndZeroLabel.set(zeroLabel, header.length);
    expect(checksum(headerAndZeroLabel)).toBe(checksum(header));

    // (b) The contract that actually matters: a non-zero label DOES change
    // the checksum, so the implementation had better actually include it.
    const headerAndNonZeroLabel = new Uint8Array(header.length + nonZeroLabel.length);
    headerAndNonZeroLabel.set(header, 0);
    headerAndNonZeroLabel.set(nonZeroLabel, header.length);
    expect(checksum(headerAndNonZeroLabel)).not.toBe(checksum(header));
  });
});

describe('decodeTrack', () => {
  for (const kind of KINDS) {
    for (const trackNo of FIXTURE_TRACKS) {
      it(`round-trips ${kind} track ${trackNo}`, () => {
        expect(decodeTrack(encodeTrack(trackOf(kind, trackNo), trackNo)))
          .toEqual(trackOf(kind, trackNo));
      });

      it(`decodes Greaseweazle's own bytes for ${kind} track ${trackNo}`, () => {
        expect(decodeTrack(golden(kind, trackNo))).toEqual(trackOf(kind, trackNo));
      });
    }
  }

  it('rejects a track of the wrong length', () => {
    expect(() => decodeTrack(new Uint8Array(12667))).toThrow(/12668/);
  });

  it('rejects a track with a corrupted data checksum', () => {
    const t = encodeTrack(trackOf('prng', 0), 0);
    t[GAP_LEAD_BYTES + 60] ^= 0x11; // flip data bits in sector 0
    expect(() => decodeTrack(t)).toThrow(TrackDecodeError);
  });

  it('rejects a track with a corrupted header checksum', () => {
    const t = encodeTrack(trackOf('prng', 0), 0);
    t[GAP_LEAD_BYTES + 12] ^= 0x11; // flip label bits in sector 0
    expect(() => decodeTrack(t)).toThrow(TrackDecodeError);
  });

  it('rejects a track that is missing a sector', () => {
    const t = encodeTrack(trackOf('prng', 0), 0);
    t.fill(0xaa, GAP_LEAD_BYTES, GAP_LEAD_BYTES + 4); // destroy sector 0's sync
    expect(() => decodeTrack(t)).toThrow(/11 sectors|sector 0/i);
  });

  it('rejects a track with a duplicate sector id', () => {
    const t = encodeTrack(trackOf('prng', 0), 0);
    // Copy sector 0 (at GAP_LEAD_BYTES) to sector 1's position (at GAP_LEAD_BYTES + SECTOR_MFM_BYTES)
    // This creates two structurally valid, checksummed sectors both claiming id 0
    t.set(t.subarray(GAP_LEAD_BYTES, GAP_LEAD_BYTES + SECTOR_MFM_BYTES), GAP_LEAD_BYTES + SECTOR_MFM_BYTES);
    expect(() => decodeTrack(t)).toThrow(TrackDecodeError);
    expect(() => decodeTrack(t)).toThrow(/appears twice/);
  });
});
