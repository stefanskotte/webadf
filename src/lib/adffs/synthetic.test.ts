import { describe, it, expect } from 'vitest';
import { syntheticVolume, nameHash } from './synthetic';
import { blockAt, be32, checksumOk } from './blocks';
import { BLOCK_BYTES, ROOT_BLOCK, CHECKSUM_WORD } from './constants';
import { readUsage } from './usage';
import { usedBlocks } from './format';

describe('syntheticVolume bitmap', () => {
  it('builds a volume whose bitmap an Amiga would believe', () => {
    const adf = syntheticVolume({
      filesystem: 'FFS',
      volumeName: 'BitmapVol',
      entries: [{ name: 'a.txt', bytes: new TextEncoder().encode('hello') }],
    });

    // readUsage returns null for any bitmap it cannot trust, so a non-null
    // answer IS the trust test -- the same one the writer will use.
    const usage = readUsage(adf);
    expect(usage).not.toBeNull();

    // Root, bitmap, the file's header and its one data block are used. The
    // two boot blocks are outside the bitmap but count as used space.
    const used = usedBlocks(adf);
    expect(used).toContain(880);
    expect(used).toContain(881);
    // Nothing may be marked used that the builder never handed out.
    expect(used.length).toBe(4);
  });
});

describe('syntheticVolume extension blocks', () => {
  it('leaves every extension block in a long file chain with a valid checksum', () => {
    // 145 data blocks needs two extension blocks: 72 pointers fit in the file
    // header, 72 more in the first extension block, and the last 1 in a
    // second extension block. Regression for the same failure shape as
    // link(): chaining a new extension block onto a PREVIOUS extension block
    // writes that block's +504 pointer after its checksum was already
    // stored, invalidating it unless the previous block is rechecked.
    const bytes = new Uint8Array(145 * BLOCK_BYTES);
    const adf = syntheticVolume({ filesystem: 'FFS', entries: [{ name: 'big.bin', bytes }] });

    const root = blockAt(adf, ROOT_BLOCK)!;
    const slot = nameHash('big.bin', false);
    const header = be32(root, 24 + slot * 4);
    expect(header).not.toBe(0);

    const headerBlock = blockAt(adf, header)!;
    let ext = be32(headerBlock, 504);
    const chain: number[] = [];
    while (ext !== 0) {
      chain.push(ext);
      const block = blockAt(adf, ext)!;
      expect(checksumOk(block, CHECKSUM_WORD)).toBe(true);
      ext = be32(block, 504);
    }
    // Confirms the fixture actually exercises 2+ extension blocks, not just 1.
    expect(chain.length).toBeGreaterThanOrEqual(2);
  });
});
