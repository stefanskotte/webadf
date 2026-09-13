import { describe, it, expect } from 'vitest';
import { readFileBytes } from './file';
import { walkDirectory } from './dir';
import { syntheticVolume, recheck } from './synthetic';
import { ROOT_BLOCK, BLOCK_BYTES, BLOCK_COUNT, OFS_DATA_BYTES } from './constants';

function putBe32(a: Uint8Array, off: number, v: number) {
  a[off] = (v >>> 24) & 0xff; a[off + 1] = (v >>> 16) & 0xff;
  a[off + 2] = (v >>> 8) & 0xff; a[off + 3] = v & 0xff;
}

function getBe32(a: Uint8Array, off: number): number {
  return ((a[off] << 24) | (a[off + 1] << 16) | (a[off + 2] << 8) | a[off + 3]) >>> 0;
}

/** Deterministic content, so a wrong offset shows up as wrong bytes. */
const payload = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7) & 0xff);

function firstFile(adf: Uint8Array) {
  return walkDirectory(adf, ROOT_BLOCK).root.find((e) => e.kind === 'file')!;
}

describe('readFileBytes', () => {
  it('reports a block list that holds MORE than the header claims', () => {
    /*
     * Both directions of this mismatch are damage. Only the "too few" case was
     * reported; "too many" was silently truncated and the file marked complete,
     * so a damaged disk read as healthy in the browser.
     *
     * Found on the operator's real Workbench 3.1 disk 2026-09-13, where
     * L/PPaint/Animations/PPaint.anim lists 64 data blocks for a declared size
     * of 24,576 bytes. xdftool refuses the whole image over it; this library
     * showed it as a normal file -- the worst of the three answers, since the
     * disk was about to be trusted on real hardware.
     */
    const want = payload(BLOCK_BYTES * 4);
    const adf = syntheticVolume({ filesystem: 'FFS', entries: [{ name: 'A', bytes: want }] });
    const header = firstFile(adf).block;

    // Shrink the DECLARED size by two blocks, leaving the block list intact --
    // exactly the shape of the real damage.
    const declaredOff = header * BLOCK_BYTES + 324;
    expect(getBe32(adf, declaredOff)).toBe(BLOCK_BYTES * 4);
    putBe32(adf, declaredOff, BLOCK_BYTES * 2);
    recheck(adf, header);

    const got = readFileBytes(adf, header, 'FFS')!;
    expect(got.warnings.join(' ')).toMatch(/block list holds/);
    expect(got.warnings.join(' ')).toMatch(/2 block\(s\) too many/);
    expect(got.complete).toBe(false);
    // The bytes it does return are still the declared length, not the excess.
    expect(got.bytes.length).toBe(BLOCK_BYTES * 2);
  });

  it('stays quiet when the block list matches the declared size', () => {
    // The guard above must not fire on healthy files: FFS rounds a file up to
    // whole blocks, so a partial last block is normal and is NOT damage.
    const adf = syntheticVolume({ filesystem: 'FFS', entries: [{ name: 'A', bytes: payload(BLOCK_BYTES + 7) }] });
    const got = readFileBytes(adf, firstFile(adf).block, 'FFS')!;
    expect(got.warnings).toEqual([]);
    expect(got.complete).toBe(true);
  });

  it('reads a small OFS file, skipping the 24-byte data-block header', () => {
    const want = payload(100);
    const adf = syntheticVolume({ filesystem: 'OFS', entries: [{ name: 'A', bytes: want }] });
    const got = readFileBytes(adf, firstFile(adf).block, 'OFS')!;
    expect(got.bytes).toEqual(want);
    expect(got.complete).toBe(true);
  });

  it('reads a small FFS file, whose blocks are raw', () => {
    const want = payload(100);
    const adf = syntheticVolume({ filesystem: 'FFS', entries: [{ name: 'A', bytes: want }] });
    expect(readFileBytes(adf, firstFile(adf).block, 'FFS')!.bytes).toEqual(want);
  });

  it('reads a file spanning several blocks in the right ORDER', () => {
    // Data pointers are stored in REVERSE order in the header. Reading them
    // forwards yields a file whose blocks are shuffled -- which still has the
    // right length, so only content comparison catches it.
    const want = payload(OFS_DATA_BYTES * 3 + 17);
    const adf = syntheticVolume({ filesystem: 'OFS', entries: [{ name: 'A', bytes: want }] });
    expect(readFileBytes(adf, firstFile(adf).block, 'OFS')!.bytes).toEqual(want);
  });

  it('follows extension blocks past the 72 pointers a header holds', () => {
    // 112 real files need this. An FFS file of 80 blocks is ~41 KB.
    const want = payload(BLOCK_BYTES * 80);
    const adf = syntheticVolume({ filesystem: 'FFS', entries: [{ name: 'Big', bytes: want }] });
    const got = readFileBytes(adf, firstFile(adf).block, 'FFS')!;
    expect(got.bytes.length).toBe(want.length);
    expect(got.bytes).toEqual(want);
  });

  it('reads an empty file as zero bytes', () => {
    const adf = syntheticVolume({ entries: [{ name: 'Empty', bytes: new Uint8Array(0) }] });
    expect(readFileBytes(adf, firstFile(adf).block, 'OFS')!.bytes.length).toBe(0);
  });

  it('does NOT trust a size larger than the blocks it can reach', () => {
    // Spec section 5 guard 4. The size field is attacker-controlled; a
    // buffer must never be allocated from it.
    const adf = syntheticVolume({ filesystem: 'FFS', entries: [{ name: 'Liar', bytes: payload(100) }] });
    const block = firstFile(adf).block;
    putBe32(adf, block * BLOCK_BYTES + 324, 800_000);
    // readFileBytes checksums the file header, so the fixture must stay
    // valid: this test is about the size guard, not about corruption.
    recheck(adf, block);
    const got = readFileBytes(adf, block, 'FFS')!;
    expect(got.bytes.length).toBeLessThan(1000);
    expect(got.complete).toBe(false);
  });

  it('TERMINATES on an extension chain that points back at itself', () => {
    // Spec section 5 guard 2, the extension-chain half.
    const want = payload(BLOCK_BYTES * 80);
    const adf = syntheticVolume({ filesystem: 'FFS', entries: [{ name: 'Big', bytes: want }] });
    const block = firstFile(adf).block;
    const ext = ((adf[block * BLOCK_BYTES + 504] << 24)
      | (adf[block * BLOCK_BYTES + 505] << 16)
      | (adf[block * BLOCK_BYTES + 506] << 8)
      | adf[block * BLOCK_BYTES + 507]) >>> 0;
    putBe32(adf, ext * BLOCK_BYTES + 504, ext);   // extension -> itself
    const got = readFileBytes(adf, block, 'FFS')!;
    expect(got.warnings.join(' ')).toMatch(/cycle/i);
  });

  it('ignores a data pointer outside the image', () => {
    const adf = syntheticVolume({ filesystem: 'FFS', entries: [{ name: 'A', bytes: payload(2000) }] });
    const block = firstFile(adf).block;
    putBe32(adf, block * BLOCK_BYTES + 24 + 71 * 4, 99_999);
    recheck(adf, block);
    const got = readFileBytes(adf, block, 'FFS')!;
    expect(got.complete).toBe(false);
    expect(got.warnings.length).toBeGreaterThan(0);
  });

  it('returns null when the block is not a file header', () => {
    const adf = syntheticVolume({ entries: [{ name: 'A', bytes: payload(10) }] });
    expect(readFileBytes(adf, ROOT_BLOCK, 'OFS')).toBeNull();
  });

  it('caps the collected pointer list so a re-listed data block cannot amplify output', () => {
    // The extension CHAIN is bounded by `seen`, but nothing bounded the
    // POINTER LIST each link contributes -- and the same data block can be
    // listed by many links. On a crafted 901,120-byte image this produced
    // 64,770,560 bytes of output in 42 ms, a 72x amplification. This builds
    // a smaller version of the same shape: one real data block, re-listed
    // by enough extension blocks that the naive (uncapped) pointer count
    // would exceed BLOCK_COUNT, and proves collection stops at BLOCK_COUNT
    // instead.
    const adf = syntheticVolume({ filesystem: 'FFS', entries: [{ name: 'A', bytes: payload(10) }] });
    const block = firstFile(adf).block;

    // The file's one data block, in the header's last pointer slot (24 +
    // 71 * 4 -- see the "REVERSE order" comment in file.ts).
    const dataBlock = getBe32(adf, block * BLOCK_BYTES + 24 + 71 * 4);

    // A run of extension blocks in an area syntheticVolume never allocates
    // into (metadata grows down from 879, data grows up from 882), each
    // relisting the SAME data block across all 72 of its pointer slots.
    // 26 * 72 + 1 (the header's own pointer) = 1,873, comfortably past
    // BLOCK_COUNT (1,760).
    const EXT_START = 1700;
    const EXT_COUNT = 26;
    putBe32(adf, block * BLOCK_BYTES + 504, EXT_START);
    for (let e = 0; e < EXT_COUNT; e++) {
      const es = (EXT_START + e) * BLOCK_BYTES;
      for (let i = 0; i < 72; i++) putBe32(adf, es + 24 + i * 4, dataBlock);
      putBe32(adf, es + 504, e + 1 < EXT_COUNT ? EXT_START + e + 1 : 0);
    }

    // A declared size big enough that the size guard (the OTHER test above)
    // is never what trims the result -- only the pointer-list cap should be.
    putBe32(adf, block * BLOCK_BYTES + 324, 999_999_999);
    recheck(adf, block);

    const got = readFileBytes(adf, block, 'FFS')!;
    expect(got.bytes.length).toBeLessThanOrEqual(BLOCK_COUNT * BLOCK_BYTES);
    expect(got.warnings.join(' ')).toMatch(/exceeds/i);
    expect(got.complete).toBe(false);
  });
});
