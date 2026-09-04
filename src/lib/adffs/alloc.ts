// The bitmap allocator: the only genuinely new filesystem code in this
// increment. Every other write operation (tasks 4-8) is built on top of
// allocate/free/isFree/bitmapPage.
//
// A SET BIT MEANS FREE. A CLEAR bit means allocated -- the single most
// invertible fact in the format, and the one bug class the reader cannot
// catch: usage.ts documents that a disk with a wrong bitmap still reads
// perfectly through readVolume, and only corrupts when a real Amiga writes
// to it believing an occupied block is free. See alloc.test.ts's mutation
// step, which deliberately inverts setBit and confirms the free-count
// assertions fail -- that is the test this file exists to pass.
//
// The bitmap covers blocks 2..1759 (BITMAP_FIRST_BLOCK..BLOCK_COUNT-1). The
// two boot blocks (0, 1) are outside it entirely and are never touched here.
// Block 880 (root) and the bitmap's own block are inside the bitmap's range
// but are always marked used and must never be handed out or freed.

import { BLOCK_BYTES, BLOCK_COUNT, ROOT_BLOCK } from './constants';
import { be32 } from './blocks';
import { putBe32 } from './write-blocks';
import { readUsage } from './usage';

const BITMAP_FIRST_BLOCK = 2;

/**
 * The trusted bitmap block, or null.
 *
 * readUsage IS the trust test (spec D-W-5): it already refuses a stale
 * bm_flag, an out-of-range bitmap pointer, and a bitmap that does not mark
 * its own block used. Duplicating those checks here would let the two
 * drift, so this reuses readUsage rather than re-deriving them.
 */
export function bitmapPage(adf: Uint8Array): number | null {
  if (readUsage(adf) === null) return null;
  return be32(adf, ROOT_BLOCK * BLOCK_BYTES + 316);
}

/**
 * True when the block is free according to the bitmap. SET means free.
 *
 * Routed through `bitmapPage()` rather than reading bm_pages[0] raw: per
 * spec D-W-5, "a disk whose bitmap readUsage() rejects is not writable"
 * binds every function here, not just `allocate`. Reading the pointer
 * without the trust gate let a corrupted bm_pages[0] be trusted anyway.
 *
 * Bounds/exclusion mirrors `free`'s guard exactly, and the two answers this
 * gives for anything outside its remit -- an untrusted bitmap, a block
 * outside 2..1759, or a protected block (root, bitmap page itself) -- are
 * both `false`. The bitmap block has 4064 addressable bits but only 1758
 * correspond to real blocks; format.ts leaves the padding past block 1759
 * set to 0xff ("free"), so an unguarded read of block 2000 would come back
 * `true` -- a plausible-looking but meaningless answer. `false` is the safe
 * direction here, matching `free`'s silent no-op on the same inputs: never
 * claim a block is available to use when this function isn't sure.
 */
export function isFree(adf: Uint8Array, block: number): boolean {
  const page = bitmapPage(adf);
  if (page === null) return false;
  if (block === ROOT_BLOCK || block === page || block < BITMAP_FIRST_BLOCK || block >= BLOCK_COUNT) return false;
  const bit = block - BITMAP_FIRST_BLOCK;
  const o = page * BLOCK_BYTES + 4 + (bit >>> 5) * 4;
  return (be32(adf, o) & (1 << (bit & 31))) !== 0;
}

/** Read-modify-write one bit. freeNow true sets the bit (free); false clears it (used). */
function setBit(adf: Uint8Array, page: number, block: number, freeNow: boolean): void {
  const bit = block - BITMAP_FIRST_BLOCK;
  const o = page * BLOCK_BYTES + 4 + (bit >>> 5) * 4;
  const word = be32(adf, o);
  putBe32(adf, o, (freeNow ? (word | (1 << (bit & 31))) : (word & ~(1 << (bit & 31)))) >>> 0);
}

/**
 * Recompute and store the bitmap block's checksum.
 *
 * Unlike every other block in this format, the bitmap's checksum sits at
 * OFFSET 0, not word 5 (CHECKSUM_WORD), and makes the sum of all 128 longs
 * in the block zero. Must run after every allocation and every free, or
 * readUsage (and a real Amiga) will reject the block as corrupt.
 */
function rechecksum(adf: Uint8Array, page: number): void {
  const bm = page * BLOCK_BYTES;
  putBe32(adf, bm, 0);
  let sum = 0;
  for (let o = bm; o < bm + BLOCK_BYTES; o += 4) sum = (sum + be32(adf, o)) >>> 0;
  putBe32(adf, bm, (-sum) >>> 0);
}

/**
 * Allocate n free blocks, marking them used. Returns the block numbers, or
 * null when the disk cannot satisfy the request.
 *
 * ALL OR NOTHING: on failure this takes nothing. A partial allocation would
 * leave blocks marked used that nothing will ever free -- a permanent leak
 * on a real Amiga, since the reader here never writes the bitmap on its own.
 */
export function allocate(adf: Uint8Array, n: number): number[] | null {
  const page = bitmapPage(adf);
  if (page === null) return null;
  const out: number[] = [];
  for (let b = BITMAP_FIRST_BLOCK; b < BLOCK_COUNT && out.length < n; b++) {
    if (b === ROOT_BLOCK || b === page) continue;
    if (isFree(adf, b)) out.push(b);
  }
  if (out.length < n) return null;
  for (const b of out) setBit(adf, page, b, false);
  rechecksum(adf, page);
  return out;
}

/**
 * Free previously allocated blocks, marking them free again.
 *
 * The root and bitmap blocks, and anything outside the bitmap's range, are
 * silently skipped rather than freed -- they must never read as available,
 * no matter what a caller passes in.
 *
 * Routed through `bitmapPage()` rather than reading bm_pages[0] raw (same
 * D-W-5 reasoning as `isFree`): when the bitmap cannot be trusted, `free`
 * does nothing at all -- no bit is touched and no checksum is written.
 * Reading the pointer raw had a concrete failure mode: if bm_pages[0] were
 * corrupted to equal ROOT_BLOCK (880), the old `b === page` guard degraded
 * to "skip anything equal to 880" and `rechecksum(adf, 880)` would have
 * written a checksum at offset 0 of the ROOT block itself, corrupting it.
 * `bitmapPage()` cannot return 880 -- `readUsage` already refuses a bitmap
 * pointer equal to ROOT_BLOCK -- so that path is now unreachable.
 */
export function free(adf: Uint8Array, blocks: number[]): void {
  const page = bitmapPage(adf);
  if (page === null) return;
  for (const b of blocks) {
    if (b === ROOT_BLOCK || b === page || b < BITMAP_FIRST_BLOCK || b >= BLOCK_COUNT) continue;
    setBit(adf, page, b, true);
  }
  rechecksum(adf, page);
}
