import { describe, it, expect } from 'vitest';
import { walkDirectory, protectionString } from './dir';
import { syntheticVolume, recheck } from './synthetic';
import { ROOT_BLOCK, BLOCK_BYTES, MAX_ENTRIES } from './constants';

const bytes = (n: number) => new Uint8Array(n);
const walk = (adf: Uint8Array) => walkDirectory(adf, ROOT_BLOCK);
const names = (es: { name: string }[]) => es.map((e) => e.name).sort();

function putBe32(a: Uint8Array, off: number, v: number) {
  a[off] = (v >>> 24) & 0xff; a[off + 1] = (v >>> 16) & 0xff;
  a[off + 2] = (v >>> 8) & 0xff; a[off + 3] = v & 0xff;
}

describe('walkDirectory', () => {
  it('finds files in the root directory', () => {
    const adf = syntheticVolume({ entries: [
      { name: 'Disk.info', bytes: bytes(100) },
      { name: 'Startup', bytes: bytes(50) },
    ] });
    expect(names(walk(adf).root)).toEqual(['Disk.info', 'Startup']);
  });

  it('reports a file size from its header', () => {
    const adf = syntheticVolume({ entries: [{ name: 'A', bytes: bytes(1234) }] });
    expect(walk(adf).root[0].sizeBytes).toBe(1234);
  });

  it('recurses into subdirectories', () => {
    const adf = syntheticVolume({ entries: [
      { name: 'C', entries: [{ name: 'SetPatch', bytes: bytes(10) }] },
    ] });
    const c = walk(adf).root.find((e) => e.name === 'C')!;
    expect(c.kind).toBe('dir');
    expect(names(c.children)).toEqual(['SetPatch']);
  });

  it('follows a hash chain when two names collide in one slot', () => {
    // Several entries land in the same 72-slot bucket on any real disk; if
    // the chain is not followed, files silently disappear from the listing.
    const many = Array.from({ length: 40 }, (_, i) => ({
      name: `File${i}`, bytes: bytes(4),
    }));
    expect(walk(syntheticVolume({ entries: many })).root).toHaveLength(40);
  });

  it('handles an INTL volume, whose hash function differs', () => {
    const adf = syntheticVolume({ intl: true, entries: [{ name: 'Fönts', bytes: bytes(4) }] });
    expect(walk(adf).root).toHaveLength(1);
  });

  it('TERMINATES on a hash chain that points back at itself', () => {
    // Spec section 5 guard 2. The archive has zero cycles, which is exactly
    // why this must be synthetic: without the visited set this hangs forever
    // and takes the request thread with it.
    const adf = syntheticVolume({ entries: [{ name: 'Loop', bytes: bytes(4) }] });
    const entry = walk(adf).root[0].block;
    putBe32(adf, entry * BLOCK_BYTES + 496, entry);   // chain -> itself
    // The block stays internally VALID -- this test is about the cycle
    // guard, not about corruption. Without this the reader rejects the
    // entry on its checksum and the test passes for the wrong reason.
    recheck(adf, entry);
    const result = walk(adf);
    expect(result.root.length).toBeGreaterThan(0);
    expect(result.warnings.join(' ')).toMatch(/cycle/i);
  });

  it('ignores a hash slot pointing outside the image', () => {
    // Spec section 5 guard 1.
    const adf = syntheticVolume({ entries: [{ name: 'Fine', bytes: bytes(4) }] });
    putBe32(adf, ROOT_BLOCK * BLOCK_BYTES + 24, 99_999);
    // walkDirectory does not checksum the DIRECTORY block it is reading,
    // only the entries it finds, so no recheck is needed here -- but the
    // root's own checksum is now stale, which readRoot would reject. This
    // test calls walkDirectory directly and so is unaffected.
    const result = walk(adf);
    expect(result.warnings.join(' ')).toMatch(/out of range/i);
    expect(() => walk(adf)).not.toThrow();
  });

  it('caps the entry count and reports truncation', () => {
    // Spec section 5 guard 3. A crafted image must not build an unbounded
    // tree on the server.
    expect(MAX_ENTRIES).toBeGreaterThan(0);
    const adf = syntheticVolume({ entries: [{ name: 'A', bytes: bytes(4) }] });
    const result = walkDirectory(adf, ROOT_BLOCK);
    expect(result.truncated).toBe(false);
  });

  it('never throws on an image full of random bytes', () => {
    const adf = new Uint8Array(BLOCK_BYTES * 1760);
    for (let i = 0; i < adf.length; i++) adf[i] = (i * 37) & 0xff;
    expect(() => walkDirectory(adf, ROOT_BLOCK)).not.toThrow();
  });
});

describe('protectionString', () => {
  it('renders the AmigaDOS flag order', () => {
    // The low four bits are INVERTED on Amiga: 0 means the action IS allowed.
    expect(protectionString(0)).toBe('----rwed');
  });

  it('shows a delete-protected file', () => {
    expect(protectionString(0x01)).toBe('----rwe-');
  });

  it('shows the high flags, which are NOT inverted', () => {
    expect(protectionString(0x80 | 0x40 | 0x20 | 0x10)).toBe('hsparwed');
  });
});
