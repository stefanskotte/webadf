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
  allocate(adf, 10);
  expect(readUsage(adf)).not.toBeNull();
  free(adf, [900]);
  expect(readUsage(adf)).not.toBeNull();
});

it('refuses a disk whose bitmap cannot be trusted', () => {
  const adf = vol();
  adf[880 * 512 + 312] = 0x00;      // bm_flag no longer -1
  expect(bitmapPage(adf)).toBeNull();
  expect(allocate(adf, 1)).toBeNull();
});
