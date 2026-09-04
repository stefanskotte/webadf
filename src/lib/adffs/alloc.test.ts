import { it, expect } from 'vitest';
import { syntheticVolume } from './synthetic';
import { readUsage } from './usage';
import { allocate, free, isFree, bitmapPage } from './alloc';

const vol = () => syntheticVolume({ filesystem: 'FFS', volumeName: 'Alloc' });

it('hands out free blocks and marks them used', () => {
  const adf = vol();
  const before = readUsage(adf)!.freeBlocks;
  const got = allocate(adf, 3)!;
  expect(got).toHaveLength(3);
  expect(new Set(got).size).toBe(3);              // no duplicates
  expect(readUsage(adf)!.freeBlocks).toBe(before - 3);
  for (const b of got) expect(isFree(adf, b)).toBe(false);
});

it('never hands out the boot, root or bitmap blocks', () => {
  const adf = vol();
  const got = allocate(adf, 1700)!;
  for (const forbidden of [0, 1, 880, 881]) expect(got).not.toContain(forbidden);
});

it('returns null rather than a short list when the disk is full', () => {
  const adf = vol();
  expect(allocate(adf, 5000)).toBeNull();
  // AND it must not have taken anything on the way to failing.
  expect(readUsage(adf)!.freeBlocks).toBe(readUsage(vol())!.freeBlocks);
});

it('free puts blocks back', () => {
  const adf = vol();
  const got = allocate(adf, 4)!;
  free(adf, got);
  for (const b of got) expect(isFree(adf, b)).toBe(true);
  expect(readUsage(adf)!.freeBlocks).toBe(readUsage(vol())!.freeBlocks);
});

it('keeps the bitmap checksum correct, or readUsage would reject it', () => {
  const adf = vol();
  const page = bitmapPage(adf)!;
  // readUsage never reads the checksum field -- it only checks bm_flag, the
  // bitmap-pointer range, and the self-bit -- so asserting on readUsage's
  // result here would pass even with rechecksum deleted entirely. Check the
  // actual property instead: the bitmap's checksum makes the sum of all 128
  // big-endian longs in the block zero (offset 0, not word 5, unlike every
  // other block).
  const sumOfLongs = () => {
    const bm = page * 512;
    let sum = 0;
    for (let o = bm; o < bm + 512; o += 4) {
      sum = (sum + (((adf[o] << 24) | (adf[o + 1] << 16) | (adf[o + 2] << 8) | adf[o + 3]) >>> 0)) >>> 0;
    }
    return sum;
  };
  allocate(adf, 10);
  expect(sumOfLongs()).toBe(0);
  free(adf, [900]);
  expect(sumOfLongs()).toBe(0);
});

it('refuses a disk whose bitmap cannot be trusted', () => {
  const adf = vol();
  adf[880 * 512 + 312] = 0x00;      // bm_flag no longer -1
  expect(bitmapPage(adf)).toBeNull();
  expect(allocate(adf, 1)).toBeNull();
});

it('isFree gives a safe answer for a block outside the bitmap\'s real range', () => {
  const adf = vol();
  // Block 2000 falls within the bitmap block's 4064 addressable bits but
  // past the 1758 real blocks (2..1759); format.ts leaves that padding set
  // to 0xff ("free"). An unguarded read would say true -- a plausible but
  // meaningless answer for a block that isn't part of the disk.
  expect(isFree(adf, 2000)).toBe(false);
});

it('isFree and free refuse a disk whose bitmap cannot be trusted', () => {
  const adf = vol();
  adf[880 * 512 + 312] = 0x00;      // bm_flag no longer -1
  expect(isFree(adf, 900)).toBe(false);
  const before = adf.slice();
  free(adf, [900]);
  expect(adf).toEqual(before);      // untouched: free is a no-op when untrusted
});

it('does not corrupt the root block when bm_pages[0] is corrupted to point at it', () => {
  const adf = vol();
  // Corrupt the bitmap pointer (root+316) to equal ROOT_BLOCK (880 =
  // 0x00000370) itself -- the concrete path that used to make free's only
  // guard ("b === page") degenerate to "skip anything equal to 880" and
  // then write a bitmap-style checksum at offset 0 of the ROOT block.
  const off = 880 * 512 + 316;
  adf[off] = 0x00; adf[off + 1] = 0x00; adf[off + 2] = 0x03; adf[off + 3] = 0x70;
  expect(bitmapPage(adf)).toBeNull();   // readUsage already refuses page === ROOT_BLOCK
  const before = adf.slice();
  free(adf, [900]);
  expect(adf).toEqual(before);
});
