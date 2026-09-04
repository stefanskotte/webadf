// Write operations: the first of which is `addFile` (spec section 3, D-W-1).
//
// Every operation here follows the same shape: validate everything first, so
// a refusal can never leak an allocated block (spec D-W-4); copy the input
// once and mutate only the copy, so the caller's Uint8Array is never touched
// (spec D-W-3); and return a discriminated union rather than throw.

import {
  BLOCK_BYTES, HASH_TABLE_SIZE, CHECKSUM_WORD, OFS_DATA_BYTES,
  OFS_DATA_CHECKSUM_WORD, T_HEADER, T_DATA, T_LIST, ST_FILE,
} from './constants';
import { blockAt, be32, i32, checksumOk, bcplString, blockChecksum } from './blocks';
import { putBe32, putName, recheck } from './write-blocks';
import { nameHash } from './hash';
import { allocate, free, bitmapPage } from './alloc';
import { readBoot, type Filesystem } from './boot';
import { walkDirectory } from './dir';
import { collectFileBlocks } from './file';

export type WriteError =
  | 'disk-full' | 'name-too-long' | 'name-exists' | 'not-found'
  | 'not-a-directory' | 'bitmap-untrusted' | 'no-filesystem';

export type WriteResult =
  | { ok: true; adf: Uint8Array }
  | { ok: false; reason: WriteError };

/**
 * Case-fold one character the same way `nameHash` does, so name comparison
 * and hash-bucket placement can never disagree about which two names match.
 */
function upperChar(c: number, intl: boolean): number {
  if (c >= 0x61 && c <= 0x7a) return c - 32;
  if (intl && c >= 0xe0 && c <= 0xfe && c !== 0xf7) return c - 32;
  return c;
}

function sameName(a: string, b: string, intl: boolean): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (upperChar(a.charCodeAt(i), intl) !== upperChar(b.charCodeAt(i), intl)) return false;
  }
  return true;
}

/**
 * True when `dir` already has an entry (of any kind) named `name`.
 *
 * `exclude`, when given, skips that one entry block -- so a rename can ask
 * "does anything ELSE already have this name" without tripping over its own
 * current name. `sameName` is case-insensitive (matching `nameHash`), so
 * without this a case-only rename ('readme' -> 'README') would see its own
 * entry as a collision and refuse itself.
 */
function entryNamed(adf: Uint8Array, dir: number, name: string, intl: boolean, exclude?: number): boolean {
  const { root } = walkDirectory(adf, dir);
  return root.some((e) => e.block !== exclude && sameName(e.name, name, intl));
}

/**
 * Write every data block of a file's contents.
 *
 * Shared by `addFile` and the fixture builder (`synthetic.ts`, spec D-W-2):
 * moved here so there is exactly one implementation of the on-disk format.
 * Takes an EXPLICIT list of block numbers rather than an allocator callback
 * (Ruling R-1) -- `synthetic.ts` lays blocks out with its own strategy (data
 * upward from 882, metadata downward from 879) and only needs this function
 * to know where to put the bytes, not how the numbers were chosen.
 */
export function writeDataBlocks(
  adf: Uint8Array, dataBlocks: number[], bytes: Uint8Array, header: number,
  filesystem: Filesystem, perBlock: number,
): void {
  dataBlocks.forEach((blk, i) => {
    const start = blk * BLOCK_BYTES;
    const chunk = bytes.subarray(i * perBlock, (i + 1) * perBlock);
    if (filesystem === 'OFS') {
      putBe32(adf, start, T_DATA);
      putBe32(adf, start + 4, header);
      putBe32(adf, start + 8, i + 1);                       // sequence number, 1-based
      putBe32(adf, start + 12, chunk.length);
      putBe32(adf, start + 16, dataBlocks[i + 1] ?? 0);
      adf.set(chunk, start + 24);
      putBe32(adf, start + OFS_DATA_CHECKSUM_WORD * 4,
        blockChecksum(adf.subarray(start, start + BLOCK_BYTES), OFS_DATA_CHECKSUM_WORD));
    } else {
      adf.set(chunk, start);
    }
  });
}

/**
 * Write a file header block: data pointers, size, name and the pointer to
 * its first extension block (0 when there is none). Data pointers go into
 * the header in REVERSE order at offset 24, matching how `file.ts` reads
 * them. `first72` is capped at `HASH_TABLE_SIZE` by every caller, so its
 * length IS `min(totalDataBlocks, HASH_TABLE_SIZE)` -- the value the on-disk
 * "high_seq" field wants.
 */
export function writeFileHeader(
  adf: Uint8Array, header: number, parent: number, name: string, size: number,
  first72: number[], firstExtension: number,
): void {
  const hs = header * BLOCK_BYTES;
  putBe32(adf, hs, T_HEADER);
  putBe32(adf, hs + 4, header);
  putBe32(adf, hs + 8, first72.length);
  putBe32(adf, hs + 16, first72[0] ?? 0);
  putBe32(adf, hs + 324, size);
  // Clear the whole pointer table before writing the new one: `replaceFile`
  // (spec D-W-6) reuses this SAME header block for a smaller file, and a
  // fresh `addFile` block is already zero -- but a reused one is not. Every
  // reader here (`collectFileBlocks`) treats any non-zero slot as a live
  // pointer regardless of `high_seq`, so a shorter `first72` left over a
  // longer one would resurrect already-freed blocks as if they still
  // belonged to this file.
  adf.fill(0, hs + 24, hs + 24 + HASH_TABLE_SIZE * 4);
  first72.forEach((blk, i) => {
    putBe32(adf, hs + 24 + (HASH_TABLE_SIZE - 1 - i) * 4, blk);
  });
  putBe32(adf, hs + 504, firstExtension);
  putName(adf, hs, name);
  putBe32(adf, hs + 500, parent);
  putBe32(adf, hs + 508, ST_FILE >>> 0);
  putBe32(adf, hs + CHECKSUM_WORD * 4,
    blockChecksum(adf.subarray(hs, hs + BLOCK_BYTES), CHECKSUM_WORD));
}

/**
 * Write the T_LIST extension blocks a file needs beyond its header's 72
 * data pointers. `data` is the FULL data-block list; the first
 * `HASH_TABLE_SIZE` of them already live in the header and are skipped here.
 *
 * Every extension block's own checksum is final the first time it is
 * written: unlike the incremental fixture builder this replaced, the full
 * chain of block numbers (`exts`) is known upfront, so each block's "next"
 * pointer is written before its checksum, and no `recheck()` pass is
 * needed afterwards.
 */
export function writeExtensionBlocks(
  adf: Uint8Array, exts: number[], data: number[], header: number,
): void {
  const rest = data.slice(HASH_TABLE_SIZE);
  exts.forEach((ext, j) => {
    const es = ext * BLOCK_BYTES;
    const take = rest.slice(j * HASH_TABLE_SIZE, (j + 1) * HASH_TABLE_SIZE);
    putBe32(adf, es, T_LIST);
    putBe32(adf, es + 4, ext);
    putBe32(adf, es + 8, take.length);
    putBe32(adf, es + 500, header);
    // Same reasoning as `writeFileHeader`: a recycled block may carry a
    // fuller pointer table from whatever it held before it was freed.
    adf.fill(0, es + 24, es + 24 + HASH_TABLE_SIZE * 4);
    take.forEach((blk, i) => {
      putBe32(adf, es + 24 + (HASH_TABLE_SIZE - 1 - i) * 4, blk);
    });
    putBe32(adf, es + 504, exts[j + 1] ?? 0);
    putBe32(adf, es + 508, ST_FILE >>> 0);
    putBe32(adf, es + CHECKSUM_WORD * 4,
      blockChecksum(adf.subarray(es, es + BLOCK_BYTES), CHECKSUM_WORD));
  });
}

/**
 * Insert `entry` at the HEAD of `dir`'s hash-chain bucket for `name`.
 *
 * The entry's checksum is recomputed afterwards, and that is not optional:
 * by the time this runs the entry (a file or directory header) has already
 * been checksummed, and writing its hash-chain pointer at offset 496
 * invalidates that checksum. `walkDirectory` rejects entry blocks whose
 * checksum fails, so without this the new entry would be invisible to every
 * reader -- looking like a traversal bug rather than a linking bug.
 */
function linkIntoDirectory(adf: Uint8Array, dir: number, entry: number, name: string, intl: boolean) {
  const slot = dir * BLOCK_BYTES + 24 + nameHash(name, intl) * 4;
  putBe32(adf, entry * BLOCK_BYTES + 496, be32(adf, slot));   // old head becomes our next
  putBe32(adf, slot, entry);
  recheck(adf, entry);
  recheck(adf, dir);
}

/**
 * Add a new file into `parentBlock`, allocating its header, data and any
 * extension blocks from the bitmap.
 *
 * Validated in this order, before anything is allocated (spec D-W-4): name
 * length, filesystem presence, bitmap trust (D-W-5), then the duplicate-name
 * check -- each of those can refuse without having touched the bitmap at
 * all. Only `allocate` itself can fail past that point (`disk-full`), and it
 * is all-or-nothing, so a refusal there leaks nothing either.
 */
export function addFile(
  adf: Uint8Array, parentBlock: number, name: string, bytes: Uint8Array,
): WriteResult {
  if (name.length === 0 || name.length > 30) return { ok: false, reason: 'name-too-long' };
  const boot = readBoot(adf);
  if (!boot) return { ok: false, reason: 'no-filesystem' };
  if (bitmapPage(adf) === null) return { ok: false, reason: 'bitmap-untrusted' };
  if (entryNamed(adf, parentBlock, name, boot.intl)) return { ok: false, reason: 'name-exists' };

  const out = adf.slice();                       // never mutate the input
  const perBlock = boot.filesystem === 'OFS' ? OFS_DATA_BYTES : BLOCK_BYTES;
  const dataCount = Math.max(1, Math.ceil(bytes.length / perBlock));
  const extCount = Math.max(0, Math.ceil((dataCount - HASH_TABLE_SIZE) / HASH_TABLE_SIZE));

  const blocks = allocate(out, 1 + dataCount + extCount);
  if (!blocks) return { ok: false, reason: 'disk-full' };
  const [header, ...rest] = blocks;
  const data = rest.slice(0, dataCount);
  const exts = rest.slice(dataCount);

  writeDataBlocks(out, data, bytes, header, boot.filesystem, perBlock);
  writeFileHeader(out, header, parentBlock, name, bytes.length, data.slice(0, HASH_TABLE_SIZE), exts[0] ?? 0);
  writeExtensionBlocks(out, exts, data, header);
  linkIntoDirectory(out, parentBlock, header, name, boot.intl);
  return { ok: true, adf: out };
}

/**
 * The slot or entry that points AT `entry`, so it can be relinked around.
 *
 * `entry`'s bucket is a singly-linked chain, and its predecessor is one of
 * two shapes: the bucket SLOT itself (`dir + 24 + bucket*4`, when `entry`
 * is the chain head), or another entry's `next_hash` field (`predecessor +
 * 496`, otherwise). Relinking the wrong one loses every entry AFTER the
 * deleted one -- `walkDirectory` reports the shorter list without any
 * complaint, since a truncated chain still looks like a well-formed one.
 *
 * Guarded against a chain cycle the same way `walkDirectory` is (a `seen`
 * set): a hostile chain that never reaches `entry` must terminate this scan
 * rather than loop forever. Returns null both when the chain genuinely
 * doesn't contain `entry` and when a cycle prevented finding out --
 * `deleteEntry` treats both as `not-found`.
 */
function predecessorOf(adf: Uint8Array, dir: number, entry: number, name: string, intl: boolean):
  { kind: 'slot'; offset: number } | { kind: 'entry'; offset: number; block: number } | null {
  const slotOffset = dir * BLOCK_BYTES + 24 + nameHash(name, intl) * 4;
  let ptr = be32(adf, slotOffset);
  if (ptr === entry) return { kind: 'slot', offset: slotOffset };
  const seen = new Set<number>();
  while (ptr !== 0 && !seen.has(ptr)) {
    seen.add(ptr);
    const nextOffset = ptr * BLOCK_BYTES + 496;
    if (be32(adf, nextOffset) === entry) return { kind: 'entry', offset: nextOffset, block: ptr };
    ptr = be32(adf, nextOffset);
  }
  return null;
}

/**
 * Delete a file: unlink its header from `parentBlock`'s hash chain, then
 * free the header plus every data and extension block it held.
 *
 * `entryBlock` must be a FILE header (checksum-valid, `ST_FILE`) that is
 * actually `parentBlock`'s child and actually reachable through its hash
 * chain -- anything else is `not-found`, never a throw and never a partial
 * write (mirrors `addFile`'s D-W-4 ordering: everything is validated before
 * the first byte is copied or freed).
 *
 * Directories are refused here (also `not-found`) rather than handled: Task
 * 8 extends this to recurse into a directory's own entries before freeing
 * it. Reusing the file walk from `file.ts` for block collection keeps that
 * extension a matter of adding a second case, not rewriting this one.
 */
export function deleteEntry(adf: Uint8Array, parentBlock: number, entryBlock: number): WriteResult {
  const boot = readBoot(adf);
  if (!boot) return { ok: false, reason: 'no-filesystem' };
  if (bitmapPage(adf) === null) return { ok: false, reason: 'bitmap-untrusted' };

  const header = blockAt(adf, entryBlock);
  if (!header) return { ok: false, reason: 'not-found' };
  if (be32(header, 0) !== T_HEADER) return { ok: false, reason: 'not-found' };
  if (!checksumOk(header, CHECKSUM_WORD)) return { ok: false, reason: 'not-found' };
  if (i32(header, 508) !== ST_FILE) return { ok: false, reason: 'not-found' };
  if (be32(header, 500) !== parentBlock) return { ok: false, reason: 'not-found' };

  const name = bcplString(header, 432, 30);
  const pred = predecessorOf(adf, parentBlock, entryBlock, name, boot.intl);
  if (!pred) return { ok: false, reason: 'not-found' };

  const nextHash = be32(header, 496);
  const out = adf.slice();                       // never mutate the input
  putBe32(out, pred.offset, nextHash);
  recheck(out, pred.kind === 'slot' ? parentBlock : pred.block);

  const warnings: string[] = [];
  const { data, extensions } = collectFileBlocks(out, entryBlock, warnings);
  free(out, [entryBlock, ...data, ...extensions]);
  return { ok: true, adf: out };
}

/**
 * Rename a file: unlink its header from `parentBlock`'s hash chain, write
 * the new name, then link it back in under the bucket the new name hashes
 * to. Allocates and frees nothing, so unlike `addFile`/`deleteEntry` it
 * never touches the bitmap at all.
 *
 * THE CASE THAT DEFINES THIS FUNCTION: `nameHash` upper-cases before
 * hashing, so a case-only rename ('readme' -> 'README') lands in the SAME
 * bucket it just left. The entry is unlinked FULLY -- its predecessor's
 * pointer patched, exactly as `deleteEntry` does -- before the new name is
 * written or it is linked back in. That turns the same-bucket case into an
 * ordinary insert into a chain the entry is no longer part of. Doing this
 * carelessly (e.g. linking before fully unlinking) can make the entry point
 * at itself; `walkDirectory`'s cycle guard would silently CONTAIN that on
 * read, making a corrupted disk look like a normal listing.
 */
export function renameEntry(
  adf: Uint8Array, parentBlock: number, entryBlock: number, newName: string,
): WriteResult {
  if (newName.length === 0 || newName.length > 30) return { ok: false, reason: 'name-too-long' };
  const boot = readBoot(adf);
  if (!boot) return { ok: false, reason: 'no-filesystem' };
  if (bitmapPage(adf) === null) return { ok: false, reason: 'bitmap-untrusted' };

  const header = blockAt(adf, entryBlock);
  if (!header) return { ok: false, reason: 'not-found' };
  if (be32(header, 0) !== T_HEADER) return { ok: false, reason: 'not-found' };
  if (!checksumOk(header, CHECKSUM_WORD)) return { ok: false, reason: 'not-found' };
  if (i32(header, 508) !== ST_FILE) return { ok: false, reason: 'not-found' };
  if (be32(header, 500) !== parentBlock) return { ok: false, reason: 'not-found' };

  const oldName = bcplString(header, 432, 30);
  const pred = predecessorOf(adf, parentBlock, entryBlock, oldName, boot.intl);
  if (!pred) return { ok: false, reason: 'not-found' };
  if (entryNamed(adf, parentBlock, newName, boot.intl, entryBlock)) return { ok: false, reason: 'name-exists' };

  const out = adf.slice();                       // never mutate the input

  // Unlink fully first (same relink as deleteEntry): the chain no longer
  // contains this entry before anything about the new name is written.
  const nextHash = be32(header, 496);
  putBe32(out, pred.offset, nextHash);
  recheck(out, pred.kind === 'slot' ? parentBlock : pred.block);

  // Clear the whole name field before writing the new one: a shorter name
  // must not leave the tail of the old one behind it (same reasoning as
  // `setVolumeName` in format.ts).
  const hs = entryBlock * BLOCK_BYTES;
  out.fill(0, hs + 432, hs + 463);
  putName(out, hs, newName);

  linkIntoDirectory(out, parentBlock, entryBlock, newName, boot.intl);
  return { ok: true, adf: out };
}

/**
 * Replace a file's contents in place: same header block, same name, same
 * hash-chain bucket. Only the data, its size, and (when the block count
 * crosses the header's 72-pointer capacity either way) its extension chain
 * change.
 *
 * D-W-6: the header block IS the file's identity -- the download route
 * addresses a file by it -- so this NEVER allocates a new header, unlike
 * `addFile`. Nothing about the hash chain is touched either (no unlink, no
 * relink): the header stays exactly where `linkIntoDirectory` first put it.
 *
 * ORDER MATTERS: the old data and extension blocks (found via the same
 * `collectFileBlocks` walk `deleteEntry` uses, so there is one opinion of
 * what a file's blocks are) are freed BEFORE the replacement's blocks are
 * allocated. Allocating first would make a same-size or shrinking replace
 * fail with `disk-full` on a full-ish disk, when freeing the old blocks
 * first would have made room. This can still never hand back a
 * partially-rewritten disk: everything that doesn't touch the bitmap is
 * validated up front against the pristine `adf` (same D-W-4 shape as
 * `deleteEntry`/`renameEntry`), and if `allocate` fails after the free, the
 * mutated working copy (`out`) is simply never returned -- the caller's
 * `adf` was never written to, so `disk-full` here is as clean a refusal as
 * one that never freed anything.
 */
export function replaceFile(adf: Uint8Array, entryBlock: number, bytes: Uint8Array): WriteResult {
  const boot = readBoot(adf);
  if (!boot) return { ok: false, reason: 'no-filesystem' };
  if (bitmapPage(adf) === null) return { ok: false, reason: 'bitmap-untrusted' };

  const header = blockAt(adf, entryBlock);
  if (!header) return { ok: false, reason: 'not-found' };
  if (be32(header, 0) !== T_HEADER) return { ok: false, reason: 'not-found' };
  if (!checksumOk(header, CHECKSUM_WORD)) return { ok: false, reason: 'not-found' };
  if (i32(header, 508) !== ST_FILE) return { ok: false, reason: 'not-found' };

  const parentBlock = be32(header, 500);
  const name = bcplString(header, 432, 30);

  const out = adf.slice();                       // never mutate the input; discarded whole on disk-full

  const warnings: string[] = [];
  const { data: oldData, extensions: oldExtensions } = collectFileBlocks(out, entryBlock, warnings);
  free(out, [...oldData, ...oldExtensions]);      // free BEFORE allocating -- see doc comment

  const perBlock = boot.filesystem === 'OFS' ? OFS_DATA_BYTES : BLOCK_BYTES;
  const dataCount = Math.max(1, Math.ceil(bytes.length / perBlock));
  const extCount = Math.max(0, Math.ceil((dataCount - HASH_TABLE_SIZE) / HASH_TABLE_SIZE));

  const blocks = allocate(out, dataCount + extCount);
  if (!blocks) return { ok: false, reason: 'disk-full' };   // `out` is discarded here, unreturned
  const data = blocks.slice(0, dataCount);
  const exts = blocks.slice(dataCount);

  writeDataBlocks(out, data, bytes, entryBlock, boot.filesystem, perBlock);
  writeFileHeader(out, entryBlock, parentBlock, name, bytes.length, data.slice(0, HASH_TABLE_SIZE), exts[0] ?? 0);
  writeExtensionBlocks(out, exts, data, entryBlock);
  return { ok: true, adf: out };
}
