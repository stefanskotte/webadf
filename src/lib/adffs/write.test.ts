import { describe, it, expect } from 'vitest';
import { addFile, deleteEntry, renameEntry, replaceFile } from './write';
import { readVolume, readFile } from './index';
import { readUsage } from './usage';
import { readBoot } from './boot';
import { nameHash } from './hash';
import { syntheticVolume } from './synthetic';

const empty = (fs: 'OFS' | 'FFS' = 'FFS') =>
  syntheticVolume({ filesystem: fs, volumeName: 'AddVol' });

describe('addFile', () => {
  it('adds a file the reader can find and read back', () => {
    const bytes = new TextEncoder().encode('hello amiga');
    const r = addFile(empty(), 880, 'hello.txt', bytes);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const v = readVolume(r.adf);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.root.map(e => e.name)).toEqual(['hello.txt']);
    expect(v.root[0].sizeBytes).toBe(bytes.length);

    const back = readFile(r.adf, v.root[0].block);
    expect(back && Array.from(back.bytes)).toEqual(Array.from(bytes));
  });

  it('works on OFS, whose data blocks carry a 24-byte header', () => {
    const bytes = new Uint8Array(1200).fill(7);
    const r = addFile(empty('OFS'), 880, 'big.bin', bytes);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = readVolume(r.adf);
    if (!v.ok) return;
    expect(Array.from(readFile(r.adf, v.root[0].block)!.bytes)).toEqual(Array.from(bytes));
  });

  it('writes extension blocks past 72 data blocks', () => {
    // 73 FFS data blocks: one more than a header can point at.
    const bytes = new Uint8Array(73 * 512).fill(3);
    const r = addFile(empty(), 880, 'huge.bin', bytes);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = readVolume(r.adf);
    if (!v.ok) return;
    expect(readFile(r.adf, v.root[0].block)!.bytes.length).toBe(bytes.length);
  });

  it('does not mutate the input', () => {
    const adf = empty();
    const copy = adf.slice();
    addFile(adf, 880, 'x.txt', new Uint8Array([1]));
    expect(Array.from(adf)).toEqual(Array.from(copy));
  });

  it('refuses a duplicate name, a long name, and an untrusted bitmap', () => {
    const one = addFile(empty(), 880, 'a.txt', new Uint8Array([1]));
    if (!one.ok) throw new Error('setup failed');
    expect(addFile(one.adf, 880, 'a.txt', new Uint8Array([2]))).toEqual({ ok: false, reason: 'name-exists' });
    expect(addFile(empty(), 880, 'x'.repeat(31), new Uint8Array([1]))).toEqual({ ok: false, reason: 'name-too-long' });

    const bad = empty();
    bad[880 * 512 + 312] = 0;                       // bm_flag invalid
    expect(addFile(bad, 880, 'a.txt', new Uint8Array([1]))).toEqual({ ok: false, reason: 'bitmap-untrusted' });
  });

  it('leaves the bitmap untouched when it refuses', () => {
    const adf = empty();
    const before = readUsage(adf)!.freeBlocks;
    addFile(adf, 880, 'x'.repeat(31), new Uint8Array([1]));
    expect(readUsage(adf)!.freeBlocks).toBe(before);
  });
});

describe('deleteEntry', () => {
  it('deletes a file and frees every block it held', () => {
    const bytes = new Uint8Array(3000).fill(9);
    const added = addFile(empty(), 880, 'gone.bin', bytes);
    if (!added.ok) throw new Error('setup');
    const v0 = readVolume(added.adf);
    if (!v0.ok) return;
    const baseline = readUsage(empty())!.freeBlocks;

    const r = deleteEntry(added.adf, 880, v0.root[0].block);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = readVolume(r.adf);
    if (!v.ok) return;
    expect(v.root).toEqual([]);
    // EVERY block back, not most of them.
    expect(readUsage(r.adf)!.freeBlocks).toBe(baseline);
  });

  it('reports not-found for a block that is not in this directory', () => {
    expect(deleteEntry(empty(), 880, 500)).toEqual({ ok: false, reason: 'not-found' });
  });

  // Controller ruling R-2 overrides the brief's original second test: adding
  // 12 arbitrarily-named files and hoping two collide across 72 buckets
  // means, if none do, the relink is never exercised and the test passes
  // green while asserting nothing -- the exact defect class this task
  // exists to prevent. Instead, pick names PROVEN (asserted as a
  // precondition) to share one bucket, build a chain of exactly three, and
  // exercise both predecessor kinds a real deletion can hit: the chain
  // head (predecessor is the directory's hash slot) and a non-head
  // (predecessor is another entry's `next_hash`).
  describe('relinks a real hash-chain collision', () => {
    // Names chosen by brute force against `nameHash` with intl off (the
    // default `empty()` uses): all three land in bucket 26.
    const COLLIDING_NAMES = ['f0.txt', 'f52.txt', 'f96.txt'];

    function buildCollidingChain() {
      let adf = empty();
      const intl = readBoot(adf)!.intl;
      // Precondition, not an assumption: fail loudly here rather than
      // silently exercising nothing if the hash function ever changes.
      const buckets = new Set(COLLIDING_NAMES.map((n) => nameHash(n, intl)));
      expect(buckets.size).toBe(1);

      for (const n of COLLIDING_NAMES) {
        const r = addFile(adf, 880, n, new Uint8Array([1]));
        if (!r.ok) throw new Error('setup');
        adf = r.adf;
      }
      // linkIntoDirectory inserts at the HEAD, so the chain (head to tail)
      // is insertion order reversed: f96.txt -> f52.txt -> f0.txt.
      return adf;
    }

    it('deletes the chain head (predecessor is the bucket slot)', () => {
      const adf = buildCollidingChain();
      const v0 = readVolume(adf);
      if (!v0.ok) return;
      const head = v0.root.find((e) => e.name === 'f96.txt')!;

      const r = deleteEntry(adf, 880, head.block);
      if (!r.ok) throw new Error('delete failed');
      const v = readVolume(r.adf);
      if (!v.ok) return;
      expect(v.root.map((e) => e.name).sort()).toEqual(['f0.txt', 'f52.txt']);
    });

    it('deletes a non-head entry from the middle (predecessor is another entry)', () => {
      const adf = buildCollidingChain();
      const v0 = readVolume(adf);
      if (!v0.ok) return;
      const middle = v0.root.find((e) => e.name === 'f52.txt')!;

      const r = deleteEntry(adf, 880, middle.block);
      if (!r.ok) throw new Error('delete failed');
      const v = readVolume(r.adf);
      if (!v.ok) return;
      // THE POINT: exactly the middle entry is gone. f0.txt -- the entry
      // that was AFTER it in the chain -- is still reachable, proving the
      // relink patched the predecessor's pointer instead of truncating the
      // chain from f52.txt onward.
      expect(v.root.map((e) => e.name).sort()).toEqual(['f0.txt', 'f96.txt']);
    });
  });
});

describe('renameEntry', () => {
  it('renames into a different bucket', () => {
    const added = addFile(empty(), 880, 'before.txt', new Uint8Array([1]));
    if (!added.ok) throw new Error('setup');
    const v0 = readVolume(added.adf);
    if (!v0.ok) return;
    const r = renameEntry(added.adf, 880, v0.root[0].block, 'after.txt');
    if (!r.ok) throw new Error('rename failed');
    const v = readVolume(r.adf);
    if (!v.ok) return;
    expect(v.root.map(e => e.name)).toEqual(['after.txt']);
  });

  it('survives a rename that lands in the SAME bucket', () => {
    // Case-only change: nameHash is case-insensitive, so old and new collide.
    const added = addFile(empty(), 880, 'readme', new Uint8Array([1]));
    if (!added.ok) throw new Error('setup');
    const v0 = readVolume(added.adf);
    if (!v0.ok) return;
    const r = renameEntry(added.adf, 880, v0.root[0].block, 'README');
    if (!r.ok) throw new Error('rename failed');
    const v = readVolume(r.adf);
    if (!v.ok) return;
    // A self-referential pointer here would be CONTAINED by walkDirectory's
    // cycle guard, so assert the name AND that no warning was raised.
    expect(v.root.map(e => e.name)).toEqual(['README']);
    expect(v.warnings).toEqual([]);
  });

  it('refuses a name already in the directory', () => {
    let adf = empty();
    for (const n of ['a.txt', 'b.txt']) {
      const r = addFile(adf, 880, n, new Uint8Array([1]));
      if (!r.ok) throw new Error('setup');
      adf = r.adf;
    }
    const v0 = readVolume(adf);
    if (!v0.ok) return;
    const a = v0.root.find(e => e.name === 'a.txt')!;
    expect(renameEntry(adf, 880, a.block, 'b.txt')).toEqual({ ok: false, reason: 'name-exists' });
  });

  it('does not touch the bitmap: a rename allocates and frees nothing', () => {
    const added = addFile(empty(), 880, 'before.txt', new Uint8Array([1]));
    if (!added.ok) throw new Error('setup');
    const v0 = readVolume(added.adf);
    if (!v0.ok) return;
    const before = readUsage(added.adf)!.freeBlocks;

    const r = renameEntry(added.adf, 880, v0.root[0].block, 'after.txt');
    if (!r.ok) throw new Error('rename failed');
    expect(readUsage(r.adf)!.freeBlocks).toBe(before);
  });

  it('does not mutate the input', () => {
    const added = addFile(empty(), 880, 'before.txt', new Uint8Array([1]));
    if (!added.ok) throw new Error('setup');
    const v0 = readVolume(added.adf);
    if (!v0.ok) return;
    const copy = added.adf.slice();

    renameEntry(added.adf, 880, v0.root[0].block, 'after.txt');
    expect(Array.from(added.adf)).toEqual(Array.from(copy));
  });

  it('leaves no stale tail when the new name is shorter', () => {
    const added = addFile(empty(), 880, 'a-long-original-name.txt', new Uint8Array([1]));
    if (!added.ok) throw new Error('setup');
    const v0 = readVolume(added.adf);
    if (!v0.ok) return;

    const r = renameEntry(added.adf, 880, v0.root[0].block, 'x');
    if (!r.ok) throw new Error('rename failed');
    const hs = v0.root[0].block * 512;
    // Length byte says 1 char, and every byte after it in the 30-char field
    // must be zero -- not the leftover tail of the old, longer name.
    expect(r.adf[hs + 432]).toBe(1);
    expect(r.adf[hs + 433]).toBe('x'.charCodeAt(0));
    expect(Array.from(r.adf.subarray(hs + 434, hs + 463)).every(b => b === 0)).toBe(true);

    const v = readVolume(r.adf);
    if (!v.ok) return;
    expect(v.root.map(e => e.name)).toEqual(['x']);
  });

  it('reports not-found for a block that is not in this directory', () => {
    expect(renameEntry(empty(), 880, 500, 'x')).toEqual({ ok: false, reason: 'not-found' });
  });
});

describe('replaceFile', () => {
  it('replaces contents and KEEPS the header block', () => {
    const added = addFile(empty(), 880, 'cfg.txt', new TextEncoder().encode('old'));
    if (!added.ok) throw new Error('setup');
    const v0 = readVolume(added.adf);
    if (!v0.ok) return;
    const block = v0.root[0].block;

    const next = new TextEncoder().encode('a much longer replacement value');
    const r = replaceFile(added.adf, block, next);
    if (!r.ok) throw new Error('replace failed');
    const v = readVolume(r.adf);
    if (!v.ok) return;

    // D-W-6: the block number is the file's identity and the download route
    // addresses by it, so it must survive an edit.
    expect(v.root[0].block).toBe(block);
    expect(v.root[0].name).toBe('cfg.txt');
    expect(v.root[0].sizeBytes).toBe(next.length);
    expect(Array.from(readFile(r.adf, block)!.bytes)).toEqual(Array.from(next));
  });

  it('returns the old data blocks when the new contents are smaller', () => {
    const added = addFile(empty(), 880, 'shrink.bin', new Uint8Array(20 * 512).fill(1));
    if (!added.ok) throw new Error('setup');
    const v0 = readVolume(added.adf);
    if (!v0.ok) return;
    const before = readUsage(added.adf)!.freeBlocks;

    const r = replaceFile(added.adf, v0.root[0].block, new Uint8Array(512).fill(2));
    if (!r.ok) throw new Error('replace failed');
    expect(readUsage(r.adf)!.freeBlocks).toBeGreaterThan(before);
  });

  it('exercises a fresh extension chain when the replacement grows past 72 blocks', () => {
    const added = addFile(empty(), 880, 'grow.bin', new Uint8Array([9]));
    if (!added.ok) throw new Error('setup');
    const v0 = readVolume(added.adf);
    if (!v0.ok) return;

    const bytes = new Uint8Array(100 * 512).fill(5);   // 100 > 72: needs an extension block
    const r = replaceFile(added.adf, v0.root[0].block, bytes);
    if (!r.ok) throw new Error('replace failed');
    const v = readVolume(r.adf);
    if (!v.ok) return;
    expect(v.root[0].block).toBe(v0.root[0].block);
    expect(v.root[0].sizeBytes).toBe(bytes.length);
    const back = readFile(r.adf, v0.root[0].block)!;
    expect(back.complete).toBe(true);
    expect(Array.from(back.bytes)).toEqual(Array.from(bytes));
  });

  it('frees the OLD extension chain when shrinking from more than 72 blocks to fewer', () => {
    // Extension-block freeing has no other automated coverage in this
    // module -- the earlier task (block-collection walk) only proved it by
    // hand. This asserts the freed block COUNT exactly, not just "some
    // blocks came back": 1 header + 5 data blocks are the only ones that
    // should still be in use afterwards, so every one of the old file's 100
    // data blocks AND its extension block must be genuinely free again.
    const baseline = readUsage(empty())!.freeBlocks;
    const added = addFile(empty(), 880, 'big.bin', new Uint8Array(100 * 512).fill(4));
    if (!added.ok) throw new Error('setup');
    const v0 = readVolume(added.adf);
    if (!v0.ok) return;

    const small = new Uint8Array(5 * 512).fill(6);
    const r = replaceFile(added.adf, v0.root[0].block, small);
    if (!r.ok) throw new Error('replace failed');
    const v = readVolume(r.adf);
    if (!v.ok) return;
    expect(Array.from(readFile(r.adf, v0.root[0].block)!.bytes)).toEqual(Array.from(small));
    expect(readUsage(r.adf)!.freeBlocks).toBe(baseline - 6);
  });

  it('does not mutate the input', () => {
    const added = addFile(empty(), 880, 'x.txt', new Uint8Array(2000).fill(1));
    if (!added.ok) throw new Error('setup');
    const v0 = readVolume(added.adf);
    if (!v0.ok) return;
    const copy = added.adf.slice();

    replaceFile(added.adf, v0.root[0].block, new Uint8Array([9]));
    expect(Array.from(added.adf)).toEqual(Array.from(copy));
  });

  it('reports not-found for a block that is not a file header', () => {
    expect(replaceFile(empty(), 500, new Uint8Array([1]))).toEqual({ ok: false, reason: 'not-found' });
  });
});
