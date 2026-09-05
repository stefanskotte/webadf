import { describe, it, expect } from 'vitest';
import { blocksForFile, blocksForPlan } from './capacity';
import { syntheticVolume } from './synthetic';
import { addFile } from './write';
import { readUsage } from './usage';

describe('blocksForFile', () => {
  it('costs a small file as one header plus one data block', () => {
    expect(blocksForFile(10, 'FFS')).toBe(2);
    expect(blocksForFile(10, 'OFS')).toBe(2);
  });

  it('costs an EMPTY file as one header plus one data block', () => {
    // AmigaDOS still gives a zero-length file a data block; addFile allocates
    // Math.max(1, ...) and this must agree with it or the estimate drifts.
    expect(blocksForFile(0, 'FFS')).toBe(2);
  });

  it('uses 488 payload bytes on OFS and 512 on FFS', () => {
    expect(blocksForFile(512, 'FFS')).toBe(2);      // 1 data block exactly
    expect(blocksForFile(512, 'OFS')).toBe(3);      // 512 > 488, so two
  });

  it('adds an extension block past 72 data blocks', () => {
    expect(blocksForFile(72 * 512, 'FFS')).toBe(73);        // header + 72, no ext
    expect(blocksForFile(73 * 512, 'FFS')).toBe(75);        // header + 73 + 1 ext
    expect(blocksForFile(144 * 512, 'FFS')).toBe(146);      // header + 144 + 1
    expect(blocksForFile(145 * 512, 'FFS')).toBe(148);      // header + 145 + 2
  });
});

describe('blocksForPlan', () => {
  it('costs a directory as one block, and sums a plan', () => {
    expect(blocksForPlan([{ kind: 'dir', sizeBytes: 0 }], 'FFS')).toBe(1);
    // THE POINT OF THIS MODULE: a hundred 1KB files is ~100KB of content and
    // ~300 blocks (150KB) of disk, so bytes would say it fits when it does not.
    const many = Array.from({ length: 100 }, () => ({ kind: 'file' as const, sizeBytes: 1024 }));
    expect(blocksForPlan(many, 'FFS')).toBe(300);   // each: 1 header + 2 data
  });
});

describe('blocksForFile vs real writer', () => {
  it('agrees with what addFile actually allocates', () => {
    const start = syntheticVolume({ filesystem: 'FFS', volumeName: 'Cost' });
    const before = readUsage(start)!.freeBlocks;
    const bytes = new Uint8Array(73 * 512).fill(1);   // forces an extension block
    const r = addFile(start, 880, 'big.bin', bytes);
    if (!r.ok) throw new Error('add');
    const spent = before - readUsage(r.adf)!.freeBlocks;
    expect(spent).toBe(blocksForFile(bytes.length, 'FFS'));
  });
});
