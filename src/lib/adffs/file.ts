// File contents. This is the one place OFS and FFS genuinely diverge, and
// the one place an attacker-controlled length reaches an allocation.

import {
  BLOCK_BYTES, HASH_TABLE_SIZE, CHECKSUM_WORD, OFS_DATA_BYTES,
  T_HEADER, ST_FILE,
} from './constants';
import { blockAt, be32, i32, checksumOk } from './blocks';
import type { Filesystem } from './boot';

export interface FileBytes {
  bytes: Uint8Array;
  /** False when the header claimed more than the reachable blocks held. */
  complete: boolean;
  warnings: string[];
}

/** Every data block of a file, in order, following extension blocks. */
function dataBlocks(adf: Uint8Array, headerBlock: number, warnings: string[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>([headerBlock]);
  let current: number | null = headerBlock;

  while (current !== null) {
    const b = blockAt(adf, current);
    if (!b) { warnings.push(`block ${current} is out of range`); break; }

    // Pointers live at 24..307 in REVERSE order: the LAST slot is the FIRST
    // data block. Reading them forwards produces a file of the right length
    // with its contents shuffled, which no length check would catch.
    for (let i = HASH_TABLE_SIZE - 1; i >= 0; i--) {
      const ptr = be32(b, 24 + i * 4);
      if (ptr !== 0) out.push(ptr);
    }

    const next = be32(b, 504);
    if (next === 0) break;
    if (seen.has(next)) { warnings.push(`extension chain cycle at block ${next}`); break; }
    seen.add(next);
    current = next;
  }
  return out;
}

/**
 * Null when `headerBlock` is not a file header in this image.
 *
 * THE DECLARED SIZE IS NEVER USED TO ALLOCATE (spec section 5 guard 4). The
 * bytes actually reachable are collected first and the declared size only
 * ever TRIMS the result. A header claiming 800 KB with three data blocks
 * yields three blocks and `complete: false`.
 */
export function readFileBytes(
  adf: Uint8Array, headerBlock: number, filesystem: Filesystem,
): FileBytes | null {
  const header = blockAt(adf, headerBlock);
  if (!header) return null;
  if (be32(header, 0) !== T_HEADER) return null;
  if (i32(header, 508) !== ST_FILE) return null;
  if (!checksumOk(header, CHECKSUM_WORD)) return null;

  const warnings: string[] = [];
  const declared = be32(header, 324);
  const blocks = dataBlocks(adf, headerBlock, warnings);

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (const blk of blocks) {
    const b = blockAt(adf, blk);
    if (!b) { warnings.push(`data block ${blk} is out of range`); continue; }
    if (filesystem === 'OFS') {
      // The header's data_size field says how much of the 488 is real. It is
      // clamped: a crafted value must not read past the block.
      const size = Math.min(be32(b, 12), OFS_DATA_BYTES);
      chunks.push(b.subarray(24, 24 + size));
      total += size;
    } else {
      chunks.push(b.subarray(0, BLOCK_BYTES));
      total += BLOCK_BYTES;
    }
  }

  const length = Math.min(declared, total);
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    if (at >= length) break;
    const take = Math.min(c.length, length - at);
    bytes.set(c.subarray(0, take), at);
    at += take;
  }

  const complete = total >= declared && warnings.length === 0;
  if (!complete && total < declared) {
    warnings.push(`header claims ${declared} bytes but only ${total} are reachable`);
  }
  return { bytes, complete, warnings };
}
