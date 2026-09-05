import { describe, it, expect } from 'vitest';
import { addFile, deleteEntry, renameEntry, replaceFile, makeDirectory, moveEntry } from './write';
import { readVolume, readFile } from './index';
import { readUsage } from './usage';
import { readBoot } from './boot';
import { nameHash } from './hash';
import { syntheticVolume } from './synthetic';
import { blockAt, be32 } from './blocks';
import { HASH_TABLE_SIZE, ROOT_BLOCK } from './constants';
import { walkDirectory } from './dir';

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

describe('makeDirectory', () => {
  it('creates a directory you can add a file into', () => {
    const d = makeDirectory(empty(), 880, 'tools');
    if (!d.ok) throw new Error('mkdir failed');
    const v0 = readVolume(d.adf);
    if (!v0.ok) return;
    expect(v0.root[0].kind).toBe('dir');

    const f = addFile(d.adf, v0.root[0].block, 'inside.txt', new Uint8Array([1]));
    if (!f.ok) throw new Error('add failed');
    const v = readVolume(f.adf);
    if (!v.ok) return;
    expect(v.root[0].children.map(c => c.name)).toEqual(['inside.txt']);
  });

  it('refuses a duplicate name (against a file OR a directory), a long name, and an untrusted bitmap', () => {
    const one = makeDirectory(empty(), 880, 'a');
    if (!one.ok) throw new Error('setup failed');
    expect(makeDirectory(one.adf, 880, 'a')).toEqual({ ok: false, reason: 'name-exists' });

    const withFile = addFile(empty(), 880, 'b.txt', new Uint8Array([1]));
    if (!withFile.ok) throw new Error('setup failed');
    expect(makeDirectory(withFile.adf, 880, 'b.txt')).toEqual({ ok: false, reason: 'name-exists' });

    expect(makeDirectory(empty(), 880, 'x'.repeat(31))).toEqual({ ok: false, reason: 'name-too-long' });

    const bad = empty();
    bad[880 * 512 + 312] = 0;                       // bm_flag invalid
    expect(makeDirectory(bad, 880, 'a')).toEqual({ ok: false, reason: 'bitmap-untrusted' });
  });

  it('does not mutate the input', () => {
    const adf = empty();
    const copy = adf.slice();
    makeDirectory(adf, 880, 'tools');
    expect(Array.from(adf)).toEqual(Array.from(copy));
  });

  // Task 7's stale-pointer lesson extended to directories: `allocate` can
  // hand `makeDirectory` a block a previous `deleteEntry` freed, and `free`
  // never clears content. A file with exactly 72 data blocks leaves its
  // header's 72-slot pointer table (offset 24, the SAME offset range a
  // directory's hash table occupies) fully populated with non-zero
  // pointers. If that block is reused for a directory and the new header
  // only clears fields it explicitly writes, those 72 stale pointers would
  // be read straight back by walkDirectory as if they were live hash-chain
  // heads.
  it('zeroes a reused block\'s hash slots instead of leaving a stale file pointer table', () => {
    const filler = addFile(empty(), 880, 'filler.bin', new Uint8Array(HASH_TABLE_SIZE * 512).fill(9));
    if (!filler.ok) throw new Error('setup');
    const v0 = readVolume(filler.adf);
    if (!v0.ok) return;
    const fillerBlock = v0.root[0].block;

    // Precondition: the header's pointer table really is fully populated,
    // not just plausible-looking -- otherwise this test would pass for the
    // wrong reason.
    const before = blockAt(filler.adf, fillerBlock)!;
    expect(Array.from(before.subarray(24, 24 + HASH_TABLE_SIZE * 4)).some((b) => b !== 0)).toBe(true);

    const del = deleteEntry(filler.adf, 880, fillerBlock);
    if (!del.ok) throw new Error('delete failed');

    const d = makeDirectory(del.adf, 880, 'reused');
    if (!d.ok) throw new Error('mkdir failed');
    const v = readVolume(d.adf);
    if (!v.ok) return;
    const dirBlock = v.root[0].block;
    // Proves this really IS the reused block, not a coincidentally-clean one.
    expect(dirBlock).toBe(fillerBlock);

    const header = blockAt(d.adf, dirBlock)!;
    for (let i = 0; i < HASH_TABLE_SIZE; i++) {
      expect(be32(header, 24 + i * 4)).toBe(0);
    }
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

  describe('on a directory', () => {
    it('deletes a non-empty directory and frees everything under it', () => {
      const baseline = readUsage(empty())!.freeBlocks;
      const d = makeDirectory(empty(), 880, 'tools');
      if (!d.ok) throw new Error('mkdir');
      const v0 = readVolume(d.adf);
      if (!v0.ok) return;
      const dir = v0.root[0].block;
      let adf = d.adf;
      for (const n of ['a.txt', 'b.txt']) {
        const r = addFile(adf, dir, n, new Uint8Array(1000).fill(4));
        if (!r.ok) throw new Error('add');
        adf = r.adf;
      }

      const r = deleteEntry(adf, 880, dir);
      if (!r.ok) throw new Error('rmdir failed');
      const v = readVolume(r.adf);
      if (!v.ok) return;
      expect(v.root).toEqual([]);
      expect(readUsage(r.adf)!.freeBlocks).toBe(baseline);
    });

    // Recursion must genuinely descend, not just free the immediate
    // children: a directory nested inside the deleted directory, itself
    // holding a file, proves depth > 1 is handled and that
    // `collectSubtreeBlocks` reuses `walkDirectory`'s own recursive
    // traversal rather than a shallow, one-level-only walk.
    it('recurses into nested directories, not just immediate children', () => {
      const baseline = readUsage(empty())!.freeBlocks;
      let adf = empty();

      const outer = makeDirectory(adf, 880, 'outer');
      if (!outer.ok) throw new Error('mkdir outer');
      adf = outer.adf;
      const v1 = readVolume(adf);
      if (!v1.ok) return;
      const outerBlock = v1.root[0].block;

      const inner = makeDirectory(adf, outerBlock, 'inner');
      if (!inner.ok) throw new Error('mkdir inner');
      adf = inner.adf;
      const v2 = readVolume(adf);
      if (!v2.ok) return;
      const innerBlock = v2.root[0].children[0].block;

      const withFile = addFile(adf, innerBlock, 'deep.txt', new Uint8Array(600).fill(2));
      if (!withFile.ok) throw new Error('add deep');
      adf = withFile.adf;

      const v3 = readVolume(adf);
      if (!v3.ok) return;
      expect(v3.root[0].children[0].children.map((c) => c.name)).toEqual(['deep.txt']);

      const r = deleteEntry(adf, 880, outerBlock);
      if (!r.ok) throw new Error('rmdir failed');
      const v = readVolume(r.adf);
      if (!v.ok) return;
      expect(v.root).toEqual([]);
      expect(readUsage(r.adf)!.freeBlocks).toBe(baseline);
    });

    it('does not mutate the input', () => {
      const d = makeDirectory(empty(), 880, 'tools');
      if (!d.ok) throw new Error('mkdir');
      const v0 = readVolume(d.adf);
      if (!v0.ok) return;
      const added = addFile(d.adf, v0.root[0].block, 'a.txt', new Uint8Array([1]));
      if (!added.ok) throw new Error('add');
      const copy = added.adf.slice();

      deleteEntry(added.adf, 880, v0.root[0].block);
      expect(Array.from(added.adf)).toEqual(Array.from(copy));
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

  // Controller ruling R-4: the spec describes rename with no file/directory
  // qualifier, and Task 11's UI puts a rename control on every row of a
  // tree that includes directories. `renameEntry` originally accepted only
  // `ST_FILE`; these prove the `ST_USERDIR` branch works, including the
  // same case-only, same-bucket scenario the file tests above cover, since
  // a directory header's hash-chain linkage is unlinked and relinked
  // through the exact same code path as a file's.
  describe('on a directory', () => {
    it('renames into a different bucket, keeping its children reachable', () => {
      const d = makeDirectory(empty(), 880, 'before');
      if (!d.ok) throw new Error('mkdir');
      const v0 = readVolume(d.adf);
      if (!v0.ok) return;
      const dirBlock = v0.root[0].block;
      const withFile = addFile(d.adf, dirBlock, 'inside.txt', new Uint8Array([1]));
      if (!withFile.ok) throw new Error('add');

      const r = renameEntry(withFile.adf, 880, dirBlock, 'after');
      if (!r.ok) throw new Error('rename failed');
      const v = readVolume(r.adf);
      if (!v.ok) return;
      expect(v.root.map((e) => e.name)).toEqual(['after']);
      expect(v.root[0].block).toBe(dirBlock);
      expect(v.root[0].children.map((c) => c.name)).toEqual(['inside.txt']);
    });

    it('survives a rename that lands in the SAME bucket', () => {
      // Case-only change: nameHash is case-insensitive, so old and new collide.
      const d = makeDirectory(empty(), 880, 'readme');
      if (!d.ok) throw new Error('mkdir');
      const v0 = readVolume(d.adf);
      if (!v0.ok) return;

      const r = renameEntry(d.adf, 880, v0.root[0].block, 'README');
      if (!r.ok) throw new Error('rename failed');
      const v = readVolume(r.adf);
      if (!v.ok) return;
      // A self-referential pointer here would be CONTAINED by
      // walkDirectory's cycle guard, so assert the name AND that no
      // warning was raised.
      expect(v.root.map((e) => e.name)).toEqual(['README']);
      expect(v.root[0].kind).toBe('dir');
      expect(v.warnings).toEqual([]);
    });

    it('refuses a name already in the directory', () => {
      let adf = empty();
      const d = makeDirectory(adf, 880, 'a');
      if (!d.ok) throw new Error('mkdir');
      adf = d.adf;
      const withFile = addFile(adf, 880, 'b.txt', new Uint8Array([1]));
      if (!withFile.ok) throw new Error('setup');
      adf = withFile.adf;

      const v0 = readVolume(adf);
      if (!v0.ok) return;
      const dir = v0.root.find((e) => e.name === 'a')!;
      expect(renameEntry(adf, 880, dir.block, 'b.txt')).toEqual({ ok: false, reason: 'name-exists' });
    });
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

  // Regression test for the stale-pointer bug the shrink case above exposed
  // (fix round 1, finding 1): `readFileBytes` walks pointer slots from
  // index 71 DOWN to 0, and the new pointers after a shrink land in the
  // LAST slots -- so a byte-length or free-count assertion can pass
  // identically whether or not the earlier, now-unreachable slots were
  // ever cleared. Only inspecting the raw header bytes catches it.
  it('leaves no stale pointer bytes in the header after a shrink from >72 blocks', () => {
    const added = addFile(empty(), 880, 'stale.bin', new Uint8Array(100 * 512).fill(4));
    if (!added.ok) throw new Error('setup');
    const v0 = readVolume(added.adf);
    if (!v0.ok) return;

    const small = new Uint8Array(5 * 512).fill(6);
    const r = replaceFile(added.adf, v0.root[0].block, small);
    if (!r.ok) throw new Error('replace failed');

    const header = blockAt(r.adf, v0.root[0].block)!;
    // 5 new pointers occupy the LAST 5 slots (reverse order from offset
    // 24); every slot before that must be zero, not a leftover pointer
    // from the 100-block file this header used to describe.
    for (let i = 0; i < HASH_TABLE_SIZE - 5; i++) {
      expect(be32(header, 24 + i * 4)).toBe(0);
    }
  });

  // Fix round 2, finding 1 (carried): the header test above gives NO
  // coverage to `writeExtensionBlocks`'s own table-clearing line -- its
  // shrink never allocates an extension block at all (extCount stays 0).
  // This closes that gap the same way `replaceFile` itself would trigger
  // it: an extension block that used to be FULLY populated (72 real
  // pointers) gets reused, via the bitmap, for a new extension block that
  // only needs a few. Built with addFile/deleteEntry/addFile rather than
  // replaceFile because that's the deterministic way to land a SPECIFIC
  // reused block address:
  //   1. big2.bin needs exactly 144 data blocks -- exactly enough for ONE
  //      extension block, and that block ends up FULLY populated (72 of
  //      72 slots), because rest.length is exactly 72.
  //   2. Deleting it frees its header, data and that one extension block.
  //   3. filler.bin (68 data blocks, no extension) consumes the low end of
  //      the freed range, so it does NOT reuse big2.bin's extension block.
  //   4. small2.bin (75 data blocks) then needs exactly one extension
  //      block of its own, with only 3 pointers in it -- and `allocate`
  //      scans lowest-free-first, so the next free block after filler.bin
  //      is exactly the block big2.bin's full extension used to occupy.
  // The actual block number is read back from the written header (`hs +
  // 504`), not assumed, per the "verify by reading it back" instruction.
  it('leaves no stale pointer bytes in a REUSED extension block', () => {
    let adf: Uint8Array = empty();

    const big = addFile(adf, 880, 'big2.bin', new Uint8Array(144 * 512).fill(3));
    if (!big.ok) throw new Error('setup');
    adf = big.adf;
    const vBig = readVolume(adf);
    if (!vBig.ok) return;
    const bigBlock = vBig.root.find((e) => e.name === 'big2.bin')!.block;

    const del = deleteEntry(adf, 880, bigBlock);
    if (!del.ok) throw new Error('setup');
    adf = del.adf;

    const filler = addFile(adf, 880, 'filler.bin', new Uint8Array(68 * 512).fill(1));
    if (!filler.ok) throw new Error('setup');
    adf = filler.adf;

    const small = addFile(adf, 880, 'small2.bin', new Uint8Array(75 * 512).fill(2));
    if (!small.ok) throw new Error('setup');
    adf = small.adf;

    const v = readVolume(adf);
    if (!v.ok) return;
    const smallBlock = v.root.find((e) => e.name === 'small2.bin')!.block;
    const header = blockAt(adf, smallBlock)!;
    const extBlock = be32(header, 504);
    expect(extBlock).not.toBe(0);

    const ext = blockAt(adf, extBlock)!;
    expect(be32(ext, 8)).toBe(3);            // high_seq: 3 real pointers in this block
    // Those 3 pointers occupy the LAST 3 slots (reverse order, offset 24);
    // every slot before that must be zero -- not one of big2.bin's 72 old
    // pointers left over from before this block was freed and recycled.
    for (let i = 0; i < HASH_TABLE_SIZE - 3; i++) {
      expect(be32(ext, 24 + i * 4)).toBe(0);
    }
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

describe('moveEntry', () => {
  it('moves a file into a subdirectory and out again', () => {
    const d = makeDirectory(empty(), 880, 'tools');
    if (!d.ok) throw new Error('mkdir');
    const v0 = readVolume(d.adf);
    if (!v0.ok) return;
    const dir = v0.root[0].block;

    const withFile = addFile(d.adf, 880, 'move.txt', new TextEncoder().encode('hi'));
    if (!withFile.ok) throw new Error('add');
    const v1 = readVolume(withFile.adf);
    if (!v1.ok) return;
    const file = v1.root.find((e) => e.name === 'move.txt')!;

    const moved = moveEntry(withFile.adf, 880, file.block, dir);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const v2 = readVolume(moved.adf);
    if (!v2.ok) return;
    // Gone from the root, present in the directory, SAME block number.
    expect(v2.root.map((e) => e.name)).toEqual(['tools']);
    expect(v2.root[0].children.map((e) => e.name)).toEqual(['move.txt']);
    expect(v2.root[0].children[0].block).toBe(file.block);
    expect(v2.warnings).toEqual([]);

    // ...and back to the root.
    const back = moveEntry(moved.adf, dir, file.block, 880);
    if (!back.ok) throw new Error('move back');
    const v3 = readVolume(back.adf);
    if (!v3.ok) return;
    expect(v3.root.map((e) => e.name).sort()).toEqual(['move.txt', 'tools']);
  });

  it('REFUSES moving a directory into its own descendant', () => {
    // THE CORRUPTION THIS EXISTS TO PREVENT. Measured directly (comment out
    // moveEntry's ancestryOf check and rerun): the moved directory unlinks
    // from the real root's chain onto its own descendant, so `readVolume`
    // from ROOT_BLOCK reports `{ warnings: [], root: [] }` -- no warning, no
    // error, the corrupted subtree just isn't there. The disk reads as
    // empty and healthy while being unwalkable on a real Amiga; only a walk
    // rooted AT the orphaned block itself would ever see the cycle.
    let adf = empty();
    const outer = makeDirectory(adf, 880, 'outer');
    if (!outer.ok) throw new Error('mkdir');
    adf = outer.adf;
    const vo = readVolume(adf);
    if (!vo.ok) return;
    const outerBlock = vo.root[0].block;

    const inner = makeDirectory(adf, outerBlock, 'inner');
    if (!inner.ok) throw new Error('mkdir inner');
    adf = inner.adf;
    const vi = readVolume(adf);
    if (!vi.ok) return;
    const innerBlock = vi.root[0].children[0].block;

    expect(moveEntry(adf, 880, outerBlock, innerBlock)).toEqual({ ok: false, reason: 'cycle' });
    // ...and into ITSELF.
    expect(moveEntry(adf, 880, outerBlock, outerBlock)).toEqual({ ok: false, reason: 'cycle' });
  });

  it('refuses moving an ancestor into a descendant deeper than MAX_DEPTH', () => {
    // Regression for a step-capped `ancestryOf`: walkDirectory itself admits
    // entries up to MAX_DEPTH (32) deep, so an ancestor chain climbing from
    // a descendant at that depth back to the root can need MORE than
    // MAX_DEPTH links. A depth-capped ancestryOf would give up before ever
    // reaching the ancestor being moved, wrongly conclude "not a
    // descendant", and let this exact drag build a cycle.
    const DEPTH = 40;   // deeper than MAX_DEPTH -- the old cap would truncate
    let node: { name: string; entries: unknown[] } = { name: `D${DEPTH - 1}`, entries: [] };
    for (let i = DEPTH - 2; i >= 0; i--) {
      node = { name: `D${i}`, entries: [node] };
    }
    const adf = syntheticVolume({ entries: [node as never] });

    // Descend one level at a time: each walkDirectory call here only looks
    // at the immediate children of `cur`, so it never itself hits
    // MAX_DEPTH regardless of how deep the full chain goes.
    let outerBlock = -1;
    let deepestBlock = -1;
    let cur = ROOT_BLOCK;
    for (let i = 0; i < DEPTH; i++) {
      const child = walkDirectory(adf, cur).root[0];
      if (i === 0) outerBlock = child.block;
      cur = child.block;
      deepestBlock = child.block;
    }

    expect(moveEntry(adf, 880, outerBlock, deepestBlock)).toEqual({ ok: false, reason: 'cycle' });
  });

  it('refuses a name already taken in the destination', () => {
    const d = makeDirectory(empty(), 880, 'tools');
    if (!d.ok) throw new Error('mkdir');
    const v0 = readVolume(d.adf);
    if (!v0.ok) return;
    const dir = v0.root[0].block;

    let adf = d.adf;
    for (const parent of [880, dir]) {
      const r = addFile(adf, parent, 'same.txt', new Uint8Array([1]));
      if (!r.ok) throw new Error('add');
      adf = r.adf;
    }
    const v1 = readVolume(adf);
    if (!v1.ok) return;
    const atRoot = v1.root.find((e) => e.name === 'same.txt')!;
    expect(moveEntry(adf, 880, atRoot.block, dir)).toEqual({ ok: false, reason: 'name-exists' });
  });

  it('touches neither the bitmap nor the input', () => {
    const d = makeDirectory(empty(), 880, 'tools');
    if (!d.ok) throw new Error('mkdir');
    const v0 = readVolume(d.adf);
    if (!v0.ok) return;
    const withFile = addFile(d.adf, 880, 'x.txt', new Uint8Array([1]));
    if (!withFile.ok) throw new Error('add');
    const v1 = readVolume(withFile.adf);
    if (!v1.ok) return;
    const file = v1.root.find((e) => e.name === 'x.txt')!;

    const before = readUsage(withFile.adf)!.freeBlocks;
    const copy = withFile.adf.slice();
    const moved = moveEntry(withFile.adf, 880, file.block, v0.root[0].block);
    if (!moved.ok) throw new Error('move');
    // A move relinks pointers; it allocates and frees nothing.
    expect(readUsage(moved.adf)!.freeBlocks).toBe(before);
    expect(Array.from(withFile.adf)).toEqual(Array.from(copy));
  });
});
