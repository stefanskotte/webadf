// Shared block-writing primitives.
//
// Moved out of the fixture builder (synthetic.ts) so fixtures and production
// write paths share one implementation of the on-disk format -- see spec
// D-W-2. Module-internal helpers stay here and are imported by name; only
// `recheck` is also needed directly by tests (see its doc comment).

import { BLOCK_BYTES, CHECKSUM_WORD } from './constants';
import { blockChecksum } from './blocks';

export function putBe32(a: Uint8Array, off: number, v: number): void {
  a[off] = (v >>> 24) & 0xff; a[off + 1] = (v >>> 16) & 0xff;
  a[off + 2] = (v >>> 8) & 0xff; a[off + 3] = v & 0xff;
}

export function putName(a: Uint8Array, blockStart: number, name: string): void {
  const n = name.slice(0, 30);
  a[blockStart + 432] = n.length;
  for (let i = 0; i < n.length; i++) a[blockStart + 433 + i] = n.charCodeAt(i) & 0xff;
}

/**
 * Recompute and store a block's checksum.
 *
 * Exported because TESTS need it too: any test that patches a byte into a
 * block the reader checksums must call this afterwards, or the reader
 * rejects the block as corrupt and the test passes for the wrong reason --
 * exercising the corruption path instead of the pointer or size guard it
 * was written for.
 */
export function recheck(adf: Uint8Array, block: number): void {
  const start = block * BLOCK_BYTES;
  const view = adf.subarray(start, start + BLOCK_BYTES);
  putBe32(adf, start + CHECKSUM_WORD * 4, blockChecksum(view, CHECKSUM_WORD));
}
