import { describe, it, expect } from 'vitest';
import { ADF_BYTES } from '@/lib/adfmfm';
import {
  replayPlan, materialise, nextKind, deltasSinceSnapshot,
  MAX_CHAIN_DEPTH, type VersionEntry,
} from './chain';
import { buildDelta, encodeDelta, SECTOR_BYTES, SECTORS_PER_DISK } from './delta';

function noise(seed: number): Uint8Array {
  const out = new Uint8Array(ADF_BYTES);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < ADF_BYTES; i++) {
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
function firstDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return -2;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}
const SAME = -1;

/** A history, plus a blob store to read it back from. */
function makeHistory(writes: number, snapshotAt: number[] = []) {
  const blobs = new Map<string, Uint8Array>();
  const entries: VersionEntry[] = [];
  const states: Uint8Array[] = [noise(42)];
  let n = 0;
  const put = (b: Uint8Array) => { const k = `b${n++}`; blobs.set(k, b); return k; };

  entries.push({ seq: 0, kind: 'snapshot', blobSha256: put(states[0]), imageSha256: 'i0' });
  for (let s = 1; s <= writes; s++) {
    const next = withSector(states[s - 1], (s * 37) % SECTORS_PER_DISK, s & 0xff);
    states.push(next);
    if (snapshotAt.includes(s)) {
      entries.push({ seq: s, kind: 'snapshot', blobSha256: put(next), imageSha256: `i${s}` });
    } else {
      const enc = encodeDelta(buildDelta(states[s - 1], next));
      entries.push({ seq: s, kind: 'delta', blobSha256: put(enc), imageSha256: `i${s}` });
    }
  }
  const read = async (k: string) => {
    const b = blobs.get(k);
    if (!b) throw new Error(`no blob ${k}`);
    return b;
  };
  return { entries, states, read };
}

describe('replayPlan', () => {
  it('reads only back to the nearest snapshot', () => {
    const { entries } = makeHistory(10, [6]);
    const plan = replayPlan(entries, 9);
    expect(plan.map((e) => e.seq)).toEqual([6, 7, 8, 9]);
    expect(plan[0].kind).toBe('snapshot');
  });

  it('is just the snapshot when the target IS one', () => {
    const { entries } = makeHistory(10, [6]);
    expect(replayPlan(entries, 6).map((e) => e.seq)).toEqual([6]);
  });

  it('falls back to version 0, which is always a snapshot', () => {
    const { entries } = makeHistory(5);
    expect(replayPlan(entries, 5).map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('refuses a version that does not exist', () => {
    const { entries } = makeHistory(3);
    expect(() => replayPlan(entries, 9)).toThrow(/no version 9/);
  });

  it('refuses a history with no snapshot to start from', () => {
    // A chain rooted in a delta cannot be reconstructed at all. Saying so
    // beats returning an image built from the wrong starting point, which
    // would look like a disk and be wrong.
    const { entries } = makeHistory(3);
    const headless = entries.slice(1);
    expect(() => replayPlan(headless, 3)).toThrow(/no snapshot/);
  });

  it('refuses a history with a hole in it', () => {
    // A version deleted from the middle silently changes what every later
    // version reconstructs to.
    const { entries } = makeHistory(5);
    const holed = entries.filter((e) => e.seq !== 3);
    expect(() => replayPlan(holed, 5)).toThrow(/not contiguous/);
  });
});

describe('materialise', () => {
  it('reproduces the disk exactly as it stood at every point in its history', async () => {
    // The requirement, stated as a test: rewind.
    const { entries, states, read } = makeHistory(12, [5, 9]);
    for (let k = 0; k <= 12; k++) {
      expect(firstDiff(await materialise(entries, k, read), states[k])).toBe(SAME);
    }
  });

  it('reads at most one snapshot plus the deltas after it', async () => {
    const { entries, read } = makeHistory(20, [16]);
    const seen: string[] = [];
    await materialise(entries, 19, async (k) => { seen.push(k); return read(k); });
    expect(seen.length).toBe(4);          // snapshot 16 + deltas 17, 18, 19
  });

  it('rejects a snapshot blob that is not a disk image', async () => {
    const { entries, read } = makeHistory(3);
    const bad = async (k: string) =>
      k === entries[0].blobSha256 ? new Uint8Array(100) : read(k);
    await expect(materialise(entries, 3, bad)).rejects.toThrow(/not a disk image/);
  });

  it('rejects a delta blob that is not a delta', async () => {
    const { entries, read } = makeHistory(3);
    const bad = async (k: string) =>
      k === entries[2].blobSha256 ? new Uint8Array(64) : read(k);
    await expect(materialise(entries, 3, bad)).rejects.toThrow(/not a disk delta/);
  });
});

describe('nextKind', () => {
  it('keeps an ordinary write as a delta', () => {
    expect(nextKind(11, 0)).toBe('delta');        // one Amiga track
    expect(nextKind(11, 5)).toBe('delta');
  });

  it('snapshots once the chain would make a rewind slow', () => {
    // Bounds the READ cost of rewinding, which is the whole point of
    // snapshots -- a disk that has been written to a thousand times is
    // exactly the one someone wants to step back through.
    expect(nextKind(11, MAX_CHAIN_DEPTH)).toBe('snapshot');
    expect(nextKind(11, MAX_CHAIN_DEPTH - 1)).toBe('delta');
  });

  it('snapshots a write that rewrites most of the disk', () => {
    // A format or a big install: both the worst case for replay depth and
    // the point where a delta costs as much as the image.
    expect(nextKind(SECTORS_PER_DISK, 0)).toBe('snapshot');
  });
});

describe('deltasSinceSnapshot', () => {
  it('counts back to the most recent snapshot', () => {
    const { entries } = makeHistory(10, [7]);
    expect(deltasSinceSnapshot(entries)).toBe(3);            // 8, 9, 10
    expect(deltasSinceSnapshot(entries.slice(0, 8))).toBe(0); // ends AT the snapshot
  });
});
