import { describe, it, expect } from 'vitest';
import { readFileBytes } from './file';
import { walkDirectory } from './dir';
import { syntheticVolume, recheck } from './synthetic';
import { ROOT_BLOCK, BLOCK_BYTES, OFS_DATA_BYTES } from './constants';

function putBe32(a: Uint8Array, off: number, v: number) {
  a[off] = (v >>> 24) & 0xff; a[off + 1] = (v >>> 16) & 0xff;
  a[off + 2] = (v >>> 8) & 0xff; a[off + 3] = v & 0xff;
}

/** Deterministic content, so a wrong offset shows up as wrong bytes. */
const payload = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7) & 0xff);

function firstFile(adf: Uint8Array) {
  return walkDirectory(adf, ROOT_BLOCK).root.find((e) => e.kind === 'file')!;
}

describe('readFileBytes', () => {
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
});
