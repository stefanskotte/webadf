import { describe, it, expect } from 'vitest';
import { ADF_BYTES } from '@/lib/adfmfm';
import {
  buildDelta, applyDelta, encodeDelta, decodeDelta, encodedSize,
  shouldSnapshot, DeltaError, SECTOR_BYTES, SECTORS_PER_DISK,
} from './delta';

/**
 * Compare whole images by the FIRST DIFFERING BYTE, never with toEqual.
 *
 * Two reasons, and the second is the important one. toEqual on a 901,120-byte
 * Uint8Array walks it with rich diffing -- the chain test below spent eleven
 * seconds in it, against 1.15 ms for the buildDelta it was checking. And when
 * it fails it prints a diff of the whole disk, which tells you nothing. A byte
 * offset tells you exactly which sector went wrong.
 */
function firstDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return -2;          // -2: lengths differ
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;                                     // -1: identical
}

const SAME = -1;

/** Deterministic, so a failure is reproducible from the seed alone. */
function noise(seed: number, len = ADF_BYTES): Uint8Array {
  const out = new Uint8Array(len);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < len; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

function withSector(img: Uint8Array, sector: number, fill: number): Uint8Array {
  const out = img.slice();
  out.fill(fill, sector * SECTOR_BYTES, (sector + 1) * SECTOR_BYTES);
  return out;
}

describe('buildDelta / applyDelta', () => {
  it('round-trips: before + delta === after', () => {
    const before = noise(1);
    const after = withSector(withSector(before, 3, 0xaa), 1759, 0xbb);
    const d = buildDelta(before, after);
    expect(d.sectors).toEqual([3, 1759]);
    expect(firstDiff(applyDelta(before, d), after)).toBe(SAME);
  });

  it('records ONLY the sectors that changed, not the track around them', () => {
    // The whole reason for diffing at 512 bytes: the Amiga rewrites all 11
    // sectors of a track to change one, so a track-level delta would report
    // eleven changes where one happened and a history browser could never say
    // what actually occurred.
    const before = noise(2);
    const after = before.slice();
    after[7 * SECTOR_BYTES + 100] ^= 0xff;     // one byte, in one sector
    const d = buildDelta(before, after);
    expect(d.sectors).toEqual([7]);
    expect(d.bytes.length).toBe(SECTOR_BYTES);
  });

  it('an unchanged image produces an empty delta', () => {
    const img = noise(3);
    const d = buildDelta(img, img);
    expect(d.sectors).toEqual([]);
    expect(d.bytes.length).toBe(0);
    expect(firstDiff(applyDelta(img, d), img)).toBe(SAME);
  });

  it('a byte at the very first and very last offset is still caught', () => {
    // Off-by-one at either end would lose real data silently.
    const before = new Uint8Array(ADF_BYTES);
    for (const at of [0, ADF_BYTES - 1]) {
      const after = before.slice();
      after[at] = 0xff;
      const d = buildDelta(before, after);
      expect(d.sectors).toEqual([Math.floor(at / SECTOR_BYTES)]);
      expect(firstDiff(applyDelta(before, d), after)).toBe(SAME);
    }
  });

  it('does not modify the image it is applied to', () => {
    const before = noise(4);
    const copy = before.slice();
    applyDelta(before, buildDelta(before, withSector(before, 10, 1)));
    expect(firstDiff(before, copy)).toBe(SAME);
  });

  it('refuses an image that is not a standard ADF', () => {
    expect(() => buildDelta(new Uint8Array(10), noise(5))).toThrow(DeltaError);
    expect(() => applyDelta(new Uint8Array(10), { sectors: [], bytes: new Uint8Array(0) }))
      .toThrow(DeltaError);
  });

  it('survives a large, scattered change', () => {
    const before = noise(6);
    let after: Uint8Array = before.slice();
    for (let s = 0; s < SECTORS_PER_DISK; s += 7) after = withSector(after, s, s & 0xff);
    const d = buildDelta(before, after);
    expect(d.sectors.length).toBe(Math.ceil(SECTORS_PER_DISK / 7));
    expect(firstDiff(applyDelta(before, d), after)).toBe(SAME);
  });
});

describe('encodeDelta / decodeDelta', () => {
  it('survives the wire', () => {
    const before = noise(7);
    const after = withSector(withSector(before, 0, 0x11), 880, 0x22);
    const d = buildDelta(before, after);
    const back = decodeDelta(encodeDelta(d));
    expect(back.sectors).toEqual(d.sectors);
    expect(back.bytes).toEqual(d.bytes);
    expect(firstDiff(applyDelta(before, back), after)).toBe(SAME);
  });

  it('encodes an empty delta without special-casing it', () => {
    const d = { sectors: [], bytes: new Uint8Array(0) };
    expect(decodeDelta(encodeDelta(d)).sectors).toEqual([]);
  });

  it('rejects bytes that are not a delta', () => {
    expect(() => decodeDelta(new Uint8Array(64))).toThrow(/not a disk delta/);
    expect(() => decodeDelta(new Uint8Array(4))).toThrow(/too short/);
  });

  it('rejects a truncated delta rather than returning a short one', () => {
    // These blobs outlive the code that wrote them; a silently short delta
    // would apply cleanly and leave the disk quietly wrong.
    const d = buildDelta(noise(8), withSector(noise(8), 5, 0x99));
    const enc = encodeDelta(d);
    expect(() => decodeDelta(enc.subarray(0, enc.length - 10))).toThrow(/but is/);
  });

  it('rejects a sector index outside the disk', () => {
    const d = buildDelta(noise(9), withSector(noise(9), 5, 0x99));
    const enc = encodeDelta(d);
    new DataView(enc.buffer).setUint32(16, SECTORS_PER_DISK);   // one past the end
    expect(() => decodeDelta(enc)).toThrow(/outside the disk/);
  });

  it('rejects repeated or out-of-order sectors', () => {
    // Two entries for one sector would make the result depend on apply order,
    // and a delta has to mean exactly one thing.
    const before = noise(10);
    const after = withSector(withSector(before, 4, 1), 9, 2);
    const enc = encodeDelta(buildDelta(before, after));
    const dv = new DataView(enc.buffer);
    dv.setUint32(16 + (4 + SECTOR_BYTES), 4);       // second entry duplicates the first
    expect(() => decodeDelta(enc)).toThrow(/ascending and unique/);
  });

  it('reports its own encoded size correctly', () => {
    const d = buildDelta(noise(11), withSector(noise(11), 1, 7));
    expect(encodeDelta(d).length).toBe(encodedSize(d.sectors.length));
  });
});

describe('shouldSnapshot', () => {
  it('keeps a normal write as a delta', () => {
    expect(shouldSnapshot(11)).toBe(false);      // one Amiga track
    expect(shouldSnapshot(100)).toBe(false);
  });

  it('switches to a snapshot once a delta stops saving anything', () => {
    // A format or a large install rewrites most of the disk: that is both the
    // worst case for replay depth and the point a delta costs as much as the
    // image it describes.
    expect(shouldSnapshot(SECTORS_PER_DISK)).toBe(true);
    expect(shouldSnapshot(Math.floor(SECTORS_PER_DISK * 0.9))).toBe(true);
  });
});

describe('a history chain', () => {
  it('replays to any point, and each point is exactly what was written', () => {
    // The actual requirement: rewind. Ten writes, then every prefix of the
    // chain must reproduce the disk as it stood after that write.
    const base = noise(12);
    const states: Uint8Array[] = [base];
    const deltas = [];
    for (let n = 1; n <= 10; n++) {
      const next = withSector(states[n - 1], n * 13, n);
      deltas.push(buildDelta(states[n - 1], next));
      states.push(next);
    }
    for (let k = 0; k <= 10; k++) {
      let img = base;
      for (let i = 0; i < k; i++) img = applyDelta(img, deltas[i]);
      expect(firstDiff(img, states[k])).toBe(SAME);
    }
  });

  it('a later write to the same sector does not disturb an earlier version', () => {
    // Rewind must show what WAS there, not the newest content of that sector.
    const base = noise(13);
    const v1 = withSector(base, 42, 0xa1);
    const v2 = withSector(v1, 42, 0xa2);
    const d1 = buildDelta(base, v1);
    const d2 = buildDelta(v1, v2);
    expect(applyDelta(base, d1)[42 * SECTOR_BYTES]).toBe(0xa1);
    expect(applyDelta(applyDelta(base, d1), d2)[42 * SECTOR_BYTES]).toBe(0xa2);
  });
});
