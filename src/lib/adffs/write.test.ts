import { describe, it, expect } from 'vitest';
import { addFile } from './write';
import { readVolume, readFile } from './index';
import { readUsage } from './usage';
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
