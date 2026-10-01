import { describe, it, expect } from 'vitest';
import { formatVolume } from '@/lib/adffs/format';
import { be32, blockAt, checksumOk } from '@/lib/adffs/blocks';
import { putBe32, recheck } from '@/lib/adffs/write-blocks';
import { CHECKSUM_WORD } from '@/lib/adffs/constants';
import { bumpVolumeDate } from './volume-date';

const CREATED = 484;
const DD_ROOT = 880;
const HD_ROOT = 1760;

function created(adf: Uint8Array, rootBlock = DD_ROOT): [number, number, number] {
  const root = blockAt(adf, rootBlock)!;
  return [be32(root, CREATED), be32(root, CREATED + 4), be32(root, CREATED + 8)];
}

function setCreated(adf: Uint8Array, d: number, m: number, t: number, rootBlock = DD_ROOT): Uint8Array {
  const o = rootBlock * 512 + CREATED;
  putBe32(adf, o, d); putBe32(adf, o + 4, m); putBe32(adf, o + 8, t);
  recheck(adf, rootBlock);
  return adf;
}

const disk = (density: 'dd' | 'hd' = 'dd') =>
  formatVolume({ filesystem: 'FFS', volumeName: 'Locale', density, now: new Date(Date.UTC(1993, 6, 15, 12, 0, 0)) });

describe('bumpVolumeDate', () => {
  it('moves the creation date one tick past the target, with a valid root checksum', () => {
    const target = setCreated(disk(), 5674, 720, 100);
    const out = bumpVolumeDate(target, target)!;
    expect(created(out)).toEqual([5674, 720, 101]);
    expect(checksumOk(blockAt(out, DD_ROOT)!, CHECKSUM_WORD)).toBe(true);
  });

  it('changes nothing but the ticks long and the root checksum', () => {
    const target = setCreated(disk(), 5674, 720, 100);
    const out = bumpVolumeDate(target, target)!;
    const changed: number[] = [];
    for (let i = 0; i < out.length; i++) if (out[i] !== target[i]) changed.push(i);
    const ticks = DD_ROOT * 512 + CREATED + 8;
    const sum = DD_ROOT * 512 + CHECKSUM_WORD * 4;
    for (const i of changed) {
      expect((i >= ticks && i < ticks + 4) || (i >= sum && i < sum + 4)).toBe(true);
    }
  });

  it('does not touch the input', () => {
    const target = setCreated(disk(), 5674, 720, 100);
    const copy = target.slice();
    bumpVolumeDate(target, target);
    expect(target).toEqual(copy);
  });

  it('goes past the HEAD when the head is later (restoring the same version twice never repeats a date)', () => {
    const target = setCreated(disk(), 5674, 720, 100);
    const head = setCreated(disk(), 5674, 720, 101); // an earlier restore of the same version
    expect(created(bumpVolumeDate(target, head)!)).toEqual([5674, 720, 102]);
  });

  it('ignores an earlier head', () => {
    const target = setCreated(disk(), 5674, 720, 100);
    const head = setCreated(disk(), 5000, 0, 0);
    expect(created(bumpVolumeDate(target, head)!)).toEqual([5674, 720, 101]);
  });

  it('carries ticks into minutes and minutes into days', () => {
    expect(created(bumpVolumeDate(setCreated(disk(), 10, 5, 2999), disk().fill(0))!)).toEqual([10, 6, 0]);
    expect(created(bumpVolumeDate(setCreated(disk(), 10, 1439, 2999), disk().fill(0))!)).toEqual([11, 0, 0]);
  });

  it('still produces a later date from out-of-range fields', () => {
    expect(created(bumpVolumeDate(setCreated(disk(), 10, 5, 70000), disk().fill(0))!)).toEqual([10, 6, 0]);
  });

  it('works on an HD disk (root at block 1760)', () => {
    const target = setCreated(disk('hd'), 5674, 720, 100, HD_ROOT);
    const out = bumpVolumeDate(target, target)!;
    expect(created(out, HD_ROOT)).toEqual([5674, 720, 101]);
    expect(checksumOk(blockAt(out, HD_ROOT)!, CHECKSUM_WORD)).toBe(true);
  });

  it('answers null for a disk with no AmigaDOS volume (nothing for the Amiga to remember)', () => {
    const ndos = disk(); ndos[0] = 0x4e; // 'NDOS'-style boot block
    expect(bumpVolumeDate(ndos, ndos)).toBeNull();
    const badRoot = disk(); badRoot[DD_ROOT * 512 + 100] ^= 0xff; // checksum now wrong
    expect(bumpVolumeDate(badRoot, badRoot)).toBeNull();
    expect(bumpVolumeDate(new Uint8Array(1000), new Uint8Array(1000))).toBeNull();
  });
});
