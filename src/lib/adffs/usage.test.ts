import { describe, it, expect } from 'vitest';
import { readUsage } from './usage';
import { formatVolume, BITMAP_BLOCK } from './format';
import { BLOCK_BYTES, BLOCK_COUNT, ROOT_BLOCK } from './constants';

const AT = new Date(Date.UTC(2026, 8, 3, 12, 0, 0));
const blank = () => formatVolume({ filesystem: 'FFS', volumeName: 'Blank', now: AT });
const putBe32 = (b: Uint8Array, o: number, v: number) => {
  b[o] = (v >>> 24) & 0xff; b[o+1] = (v >>> 16) & 0xff; b[o+2] = (v >>> 8) & 0xff; b[o+3] = v & 0xff;
};

describe('readUsage', () => {
  it('reports a freshly formatted disk as four blocks used', () => {
    // Two boot blocks, the root and the bitmap. This is also exactly what
    // xdftool's `info` reports for its own format, which is how the two were
    // reconciled in the first place.
    const u = readUsage(blank())!;
    expect(u.totalBlocks).toBe(BLOCK_COUNT);
    expect(u.usedBlocks).toBe(4);
    expect(u.freeBlocks).toBe(1756);
    expect(u.usedBlocks + u.freeBlocks).toBe(u.totalBlocks);
    expect(u.totalBytes).toBe(901_120);
    expect(u.usedBytes).toBe(4 * BLOCK_BYTES);
    expect(u.percentUsed).toBe(0);
  });

  it('counts a block that has been allocated', () => {
    const adf = blank();
    // Clear one bit: bit set = FREE, so clearing marks block 900 used.
    const bit = 900 - 2;
    const o = BITMAP_BLOCK * BLOCK_BYTES + 4 + (bit >>> 5) * 4;
    const word = ((adf[o] << 24) | (adf[o+1] << 16) | (adf[o+2] << 8) | adf[o+3]) >>> 0;
    putBe32(adf, o, (word & ~(1 << (bit & 31))) >>> 0);
    const u = readUsage(adf)!;
    expect(u.usedBlocks).toBe(5);
    expect(u.freeBlocks).toBe(1755);
  });

  it('refuses when the volume marks its own bitmap invalid', () => {
    // bm_flag != -1 means AmigaDOS considers the bitmap stale and would
    // rebuild it on mount, so any figure read from it is one the Amiga is
    // about to discard.
    const adf = blank();
    putBe32(adf, ROOT_BLOCK * BLOCK_BYTES + 312, 0);
    expect(readUsage(adf)).toBeNull();
  });

  it('refuses a bitmap pointer that cannot be one', () => {
    for (const page of [0, 1, ROOT_BLOCK, BLOCK_COUNT, 99_999]) {
      const adf = blank();
      putBe32(adf, ROOT_BLOCK * BLOCK_BYTES + 316, page);
      expect(readUsage(adf)).toBeNull();
    }
  });

  it('refuses a bitmap that says every block including itself is free', () => {
    // An all-ones bitmap is an uninitialised or misread block, and it would
    // tell someone an almost-full disk was empty -- the one figure where a
    // confident wrong answer does real harm.
    const adf = blank();
    adf.fill(0xff, BITMAP_BLOCK * BLOCK_BYTES + 4, (BITMAP_BLOCK + 1) * BLOCK_BYTES);
    expect(readUsage(adf)).toBeNull();
  });

  it('refuses anything that is not an 880 KB image', () => {
    expect(readUsage(new Uint8Array(1024))).toBeNull();
  });
});
