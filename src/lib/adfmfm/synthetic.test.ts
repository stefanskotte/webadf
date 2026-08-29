import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { syntheticAdf } from './synthetic';

const KINDS = ['zeros', 'ones', 'prng', 'bootblock'] as const;

// Amiga's boot-block/bitmap checksum folds each 512-byte block into a single
// longword, then an odd/even fold that isolates whether *any* bit differs
// across even/odd bit-pairs. It is exactly zero for a block of all-zero
// bytes, all-0xFF bytes, or (less obviously) any `i & 0xff` counter fill,
// because in all of those cases every 32-bit longword in the block is
// bit-identical or the XOR of the whole block cancels out to a value whose
// even and odd bits match. This is why `zeros` and `ones` cannot exercise a
// broken checksum implementation, and why the suite needs a disk that does.
function checksumFold(b: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < 512; i += 4) c ^= (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3];
  c >>>= 0;
  return ((c ^ (c >>> 1)) & 0x55555555) >>> 0;
}

// Pinned by running the generator once and pasting the result in (see
// task-1 fix-round-1 report). Any change to synthetic.ts's byte output --
// including a silent regression of the xorshift32 fill to something
// degenerate like a counter -- flips one of these.
const SHA256 = {
  zeros: 'df62f37da18a38aea318c9312b32b445901c0f16934f25259f758a50277bf7f0',
  ones: 'ec4951e33b0aa4bcc560cd1fa99e9f3cfd1f3133cf3a741e47fb77921e9f2b14',
  prng: '292eb98755e5755958f6f597984889704790234ce177cdb7af783a9be658edca',
  bootblock: 'ac7ca5598afb72c031430fb657303f9d1657d98ce54d59410ab425b678d1e19a',
} as const;

describe('syntheticAdf', () => {
  it.each(KINDS)('%s is exactly one ADF in length', (kind) => {
    expect(syntheticAdf(kind).length).toBe(901120);
  });

  it('zeros is all zero and ones is all 0xFF', () => {
    expect(syntheticAdf('zeros').every((b) => b === 0x00)).toBe(true);
    expect(syntheticAdf('ones').every((b) => b === 0xff)).toBe(true);
  });

  it('is deterministic across calls', () => {
    expect(syntheticAdf('prng')).toEqual(syntheticAdf('prng'));
  });

  it('prng is not degenerate: every byte value appears', () => {
    const seen = new Set(syntheticAdf('prng'));
    expect(seen.size).toBe(256);
  });

  it('bootblock opens with the AmigaDOS signature and root-block pointer', () => {
    const disk = syntheticAdf('bootblock');
    expect(Array.from(disk.slice(0, 4))).toEqual([0x44, 0x4f, 0x53, 0x00]);
    // Checksum field (bytes 4-7) is untouched by the generator: still zero.
    expect(Array.from(disk.slice(4, 8))).toEqual([0x00, 0x00, 0x00, 0x00]);
    // Root block pointer, big-endian 880: this is what the generator's own
    // comment calls out, so it must be asserted, not just the signature.
    expect(Array.from(disk.slice(8, 12))).toEqual([0x00, 0x00, 0x03, 0x70]);
  });

  it('the four disks are mutually distinct', () => {
    for (const a of KINDS) {
      for (const b of KINDS) {
        if (a === b) continue;
        expect(syntheticAdf(a), `${a} vs ${b}`).not.toEqual(syntheticAdf(b));
      }
    }
  });

  it.each(KINDS)('%s matches its pinned SHA-256', (kind) => {
    const hash = createHash('sha256').update(syntheticAdf(kind)).digest('hex');
    expect(hash).toBe(SHA256[kind]);
  });

  it('prng track 0 has at least one non-degenerate checksum-fold block, unlike zeros', () => {
    const prng = syntheticAdf('prng');
    const folds = [];
    for (let sector = 0; sector < 11; sector++) {
      const block = prng.subarray(sector * 512, sector * 512 + 512);
      folds.push(checksumFold(block));
    }
    expect(folds.some((f) => f !== 0)).toBe(true);

    const zeros = syntheticAdf('zeros');
    for (let sector = 0; sector < 11; sector++) {
      const block = zeros.subarray(sector * 512, sector * 512 + 512);
      expect(checksumFold(block)).toBe(0);
    }
  });
});
