// Write operations: the first of which is `addFile` (spec section 3, D-W-1).
//
// Every operation here follows the same shape: validate everything first, so
// a refusal can never leak an allocated block (spec D-W-4); copy the input
// once and mutate only the copy, so the caller's Uint8Array is never touched
// (spec D-W-3); and return a discriminated union rather than throw.

import {
  BLOCK_BYTES, HASH_TABLE_SIZE, CHECKSUM_WORD, OFS_DATA_BYTES,
  OFS_DATA_CHECKSUM_WORD, T_HEADER, T_DATA, T_LIST, ST_FILE, ST_USERDIR,
  ROOT_BLOCK,
} from './constants';
import { blockAt, be32, i32, checksumOk, bcplString, blockChecksum } from './blocks';
import { putBe32, putName, recheck } from './write-blocks';
import { nameHash } from './hash';
import { allocate, free, bitmapPage } from './alloc';
import { readBoot, type Filesystem } from './boot';
import { walkDirectory, type AdfEntry } from './dir';
import { collectFileBlocks } from './file';
import { putAmigaDate } from './format';

export type WriteError =
  | 'disk-full' | 'name-too-long' | 'name-exists' | 'not-found'
  | 'not-a-directory' | 'bitmap-untrusted' | 'no-filesystem' | 'cycle';

export type WriteResult =
  | { ok: true; adf: Uint8Array }
  | { ok: false; reason: WriteError };

/**
 * One step of a batch upload (Task 6's drag-and-drop route): create a
 * directory, add a new file, or replace an existing one. Every op names its
 * parent by PATH rather than block number, because a directory created
 * earlier in the SAME batch has no block number the caller could possibly
 * have known when it built the list -- `applyBatch` is what resolves paths
 * to blocks as it goes.
 */
export type BatchOp =
  | { op: 'mkdir'; parentPath: string; name: string }
  // `protection` carries AmigaDOS bits an archive supplied. Optional, and
  // absent is not zero -- see addFile's parameter note.
  | { op: 'add'; parentPath: string; name: string; bytes: Uint8Array; protection?: number }
  | { op: 'replace'; parentPath: string; name: string; bytes: Uint8Array; protection?: number };

/**
 * Case-fold one character the same way `nameHash` does, so name comparison
 * and hash-bucket placement can never disagree about which two names match.
 */
function upperChar(c: number, intl: boolean): number {
  if (c >= 0x61 && c <= 0x7a) return c - 32;
  if (intl && c >= 0xe0 && c <= 0xfe && c !== 0xf7) return c - 32;
  return c;
}

/**
 * Case-insensitive name equality, folded the same way `nameHash` folds for
 * hash-bucket placement -- exported so `staging.ts` can detect collisions
 * before a write is ever attempted, using the identical rule rather than a
 * second one that could drift from it.
 */
export function sameName(a: string, b: string, intl: boolean): boolean {
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
  /** AmigaDOS protection bits, offset 320. See addFile's parameter note for
   *  why absent and zero mean the same bytes but not the same thing. */
  protection?: number,
): void {
  const hs = header * BLOCK_BYTES;
  putBe32(adf, hs, T_HEADER);
  putBe32(adf, hs + 4, header);
  putBe32(adf, hs + 8, first72.length);
  putBe32(adf, hs + 16, first72[0] ?? 0);
  // Written UNCONDITIONALLY, including the zero case. `allocate` can hand back
  // a block a previous delete freed and `free` never clears content, so a
  // recycled header may still carry another file's protection word -- the same
  // hazard the pointer-table clear below exists for. Defaulting to 0 here is
  // what makes "the archive said nothing" produce ----rwed rather than
  // whatever the last occupant happened to be.
  putBe32(adf, hs + 320, protection ?? 0);
  putBe32(adf, hs + 324, size);
  // Clear the whole pointer table before writing the new one. `allocate`
  // hands out any block whose bitmap bit is free, including one a previous
  // `deleteEntry`/`replaceFile` returned to the pool -- and `free` only
  // flips that bit, it never clears the block's old content. So this
  // block may already hold a LARGER file's pointer table (most directly
  // via `replaceFile` reusing this same header, spec D-W-6, but the
  // allocator gives `addFile` no guarantee of a zero block either).
  // `collectFileBlocks` treats any non-zero slot as a live pointer
  // regardless of `high_seq`, so a shorter `first72` left over a longer
  // one would resurrect already-freed blocks as if they still belonged to
  // this file.
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
  /**
   * AmigaDOS protection bits for the new file, as the file header block stores
   * them at offset 320 and as `protectionString` (dir.ts) reads them back.
   *
   * Optional, and undefined is NOT the same as 0. An archive that carries no
   * attribute header has said nothing about protection, so the file takes the
   * AmigaDOS default -- which happens to be the zero word, since the RWED bits
   * are clear-means-allowed. An archive that explicitly says 0 is saying the
   * same thing, so both land on the same bytes; the distinction matters at the
   * CALLER, which must not invent bits from, say, a Unix mode.
   */
  protection?: number,
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
  writeFileHeader(out, header, parentBlock, name, bytes.length, data.slice(0, HASH_TABLE_SIZE), exts[0] ?? 0, protection);
  writeExtensionBlocks(out, exts, data, header);
  linkIntoDirectory(out, parentBlock, header, name, boot.intl);
  return { ok: true, adf: out };
}

/**
 * Write a directory header block: `T_HEADER` / `ST_USERDIR`, a name, a date,
 * a parent pointer, and 72 EMPTY hash slots. No data blocks and no
 * extension blocks -- a directory's free set (see `collectSubtreeBlocks`) is
 * just its own block plus everything beneath it.
 *
 * The WHOLE block is zeroed first, not just the fields this function goes on
 * to set. `allocate` can hand back a block a previous `deleteEntry` or
 * `replaceFile` freed, and `free` never clears content (same lesson as
 * `writeFileHeader`'s doc comment, Task 7) -- so a reused block may still
 * carry another header's hash table, name, comment or size bytes. A directory
 * has no field that legitimately holds most of a file header's content, so
 * zeroing the entire 512 bytes is both simpler than field-by-field clearing
 * and the only way to guarantee the 72 hash slots read as empty regardless
 * of what the block held before.
 */
function writeDirectoryHeader(
  adf: Uint8Array, block: number, parent: number, name: string, when: Date,
): void {
  const bs = block * BLOCK_BYTES;
  adf.fill(0, bs, bs + BLOCK_BYTES);
  putBe32(adf, bs, T_HEADER);
  putBe32(adf, bs + 4, block);
  putAmigaDate(adf, bs + 420, when);
  putName(adf, bs, name);
  putBe32(adf, bs + 500, parent);
  putBe32(adf, bs + 508, ST_USERDIR);
  putBe32(adf, bs + CHECKSUM_WORD * 4,
    blockChecksum(adf.subarray(bs, bs + BLOCK_BYTES), CHECKSUM_WORD));
}

/**
 * Create a new, empty directory inside `parentBlock`.
 *
 * Allocates exactly one block and links it in exactly as `addFile` does --
 * same validation order (D-W-4), same duplicate-name check across BOTH
 * kinds of entry (`entryNamed` does not distinguish file from directory, so
 * a directory can't be named over an existing file or vice versa).
 */
export function makeDirectory(adf: Uint8Array, parentBlock: number, name: string): WriteResult {
  if (name.length === 0 || name.length > 30) return { ok: false, reason: 'name-too-long' };
  const boot = readBoot(adf);
  if (!boot) return { ok: false, reason: 'no-filesystem' };
  if (bitmapPage(adf) === null) return { ok: false, reason: 'bitmap-untrusted' };
  if (entryNamed(adf, parentBlock, name, boot.intl)) return { ok: false, reason: 'name-exists' };

  const out = adf.slice();                       // never mutate the input
  const blocks = allocate(out, 1);
  if (!blocks) return { ok: false, reason: 'disk-full' };
  const [dir] = blocks;

  writeDirectoryHeader(out, dir, parentBlock, name, new Date());
  linkIntoDirectory(out, parentBlock, dir, name, boot.intl);
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
 * Every block a directory subtree holds: the directory's own block, every
 * descendant directory's own block, and every descendant file's header,
 * data and extension blocks.
 *
 * REUSES `walkDirectory` rather than inventing a second traversal (Task 8's
 * controller ruling): `dirBlock` is passed as `walkDirectory`'s `start`, so
 * the SAME visited-set cycle guard, the SAME `MAX_DEPTH` bound, and the SAME
 * opinion of "what is a child of what" that the reader uses is what decides
 * what gets freed here. A second, independently-written traversal could
 * disagree with the reader's on a hostile image -- freeing a block the
 * reader still considers reachable, or leaking one it doesn't -- exactly the
 * bitmap-mistake class this function exists to avoid. File children are
 * then expanded through `collectFileBlocks`, the same one-implementation
 * block walk `deleteEntry`'s file case already used.
 */
function collectSubtreeBlocks(adf: Uint8Array, dirBlock: number, warnings: string[]): number[] {
  const { root, warnings: walkWarnings } = walkDirectory(adf, dirBlock);
  warnings.push(...walkWarnings);

  const blocks: number[] = [dirBlock];
  const visit = (entries: AdfEntry[]) => {
    for (const entry of entries) {
      if (entry.kind === 'dir') {
        blocks.push(entry.block);
        visit(entry.children);
      } else {
        const { data, extensions } = collectFileBlocks(adf, entry.block, warnings);
        blocks.push(entry.block, ...data, ...extensions);
      }
    }
  };
  visit(root);
  return blocks;
}

/**
 * Delete a file or directory: unlink its header from `parentBlock`'s hash
 * chain, then free every block it held.
 *
 * `entryBlock` must be a FILE or DIRECTORY header (checksum-valid, `ST_FILE`
 * or `ST_USERDIR`) that is actually `parentBlock`'s child and actually
 * reachable through its hash chain -- anything else is `not-found`, never a
 * throw and never a partial write (mirrors `addFile`'s D-W-4 ordering:
 * everything is validated before the first byte is copied or freed).
 *
 * A directory is unlinked exactly like a file -- one entry, one predecessor,
 * in `parentBlock`'s chain -- and then everything BENEATH it is freed via
 * `collectSubtreeBlocks` before the directory's own block is. Order doesn't
 * matter for correctness here (unlike `replaceFile`'s free-before-allocate):
 * this never allocates, so there is no "make room first" concern, only "free
 * every block exactly once."
 */
export function deleteEntry(adf: Uint8Array, parentBlock: number, entryBlock: number): WriteResult {
  const boot = readBoot(adf);
  if (!boot) return { ok: false, reason: 'no-filesystem' };
  if (bitmapPage(adf) === null) return { ok: false, reason: 'bitmap-untrusted' };

  const header = blockAt(adf, entryBlock);
  if (!header) return { ok: false, reason: 'not-found' };
  if (be32(header, 0) !== T_HEADER) return { ok: false, reason: 'not-found' };
  if (!checksumOk(header, CHECKSUM_WORD)) return { ok: false, reason: 'not-found' };
  const secondary = i32(header, 508);
  if (secondary !== ST_FILE && secondary !== ST_USERDIR) return { ok: false, reason: 'not-found' };
  if (be32(header, 500) !== parentBlock) return { ok: false, reason: 'not-found' };

  const name = bcplString(header, 432, 30);
  const pred = predecessorOf(adf, parentBlock, entryBlock, name, boot.intl);
  if (!pred) return { ok: false, reason: 'not-found' };

  const nextHash = be32(header, 496);
  const out = adf.slice();                       // never mutate the input
  putBe32(out, pred.offset, nextHash);
  recheck(out, pred.kind === 'slot' ? parentBlock : pred.block);

  const warnings: string[] = [];
  let toFree: number[];
  if (secondary === ST_USERDIR) {
    toFree = collectSubtreeBlocks(out, entryBlock, warnings);
  } else {
    const { data, extensions } = collectFileBlocks(out, entryBlock, warnings);
    toFree = [entryBlock, ...data, ...extensions];
  }
  free(out, toFree);
  return { ok: true, adf: out };
}

/**
 * Rename a file OR a directory: unlink its header from `parentBlock`'s hash
 * chain, write the new name, then link it back in under the bucket the new
 * name hashes to. Allocates and frees nothing, so unlike
 * `addFile`/`deleteEntry`/`makeDirectory` it never touches the bitmap at
 * all.
 *
 * ACCEPTS `ST_USERDIR` AS WELL AS `ST_FILE` (controller ruling R-4): the
 * spec's scope and section 5 describe rename with no file/directory
 * qualifier, and the tree in Task 11's UI puts a rename control on every
 * row, directories included. Nothing else in this function is
 * kind-specific -- a directory header's name, hash-chain linkage and
 * predecessor shape are identical to a file header's, so accepting the
 * second secondary type is the entire change.
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
  const secondary = i32(header, 508);
  if (secondary !== ST_FILE && secondary !== ST_USERDIR) return { ok: false, reason: 'not-found' };
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

/**
 * Every block from `entry` up to the root, following each header's parent.
 *
 * Bounded by `seen` ALONE, deliberately not by a depth cap. `seen` is
 * sufficient on its own: an 880K image has exactly BLOCK_COUNT (1,760)
 * blocks, each admitted here at most once, so this cannot spin even on an
 * image that is already cyclic. A `MAX_DEPTH`-style cap would be actively
 * WRONG here, not merely redundant: `walkDirectory` itself admits entries
 * up to `MAX_DEPTH` deep, so climbing from one of those back to the root
 * can take more than `MAX_DEPTH` links, and a matching cap would exit the
 * loop before reaching `ROOT_BLOCK` (or a repeat) -- returning a
 * TRUNCATED chain that silently omits a real ancestor. Since the caller
 * only asks "is `entryBlock` in this chain", a truncated chain answers
 * "no" to what should be "yes": a wrongful ALLOWANCE of exactly the cycle
 * this function exists to catch. Termination and completeness cannot both
 * be had from a step count here, so this uses the bound that gives both.
 */
function ancestryOf(adf: Uint8Array, entry: number): number[] {
  const chain: number[] = [];
  const seen = new Set<number>();
  let cur = entry;
  while (cur !== 0 && !seen.has(cur)) {
    chain.push(cur);
    seen.add(cur);
    if (cur === ROOT_BLOCK) break;
    cur = be32(adf, cur * BLOCK_BYTES + 500);
  }
  return chain;
}

/**
 * Move an entry (file or directory) from `fromParent`'s hash chain into
 * `toParent`'s: unlink it exactly as `deleteEntry` does, reparent it, then
 * link it back in under its (unchanged) name -- same shape as
 * `renameEntry`'s unlink-then-relink, except the bucket that changes is the
 * DIRECTORY, not the name's hash.
 *
 * Relinks pointers only: no block is allocated or freed, so the bitmap is
 * never touched (verified by a test that snapshots `readUsage`'s free count
 * before and after).
 *
 * THE CHECK THAT MATTERS: moving a directory into one of its own
 * descendants (or into itself) would make the destination's ancestry chain
 * loop back through `entryBlock` -- a cycle in the directory tree. This is
 * WORSE than `walkDirectory`'s cycle guard merely containing a loop and
 * reporting a plausible listing: measured directly (comment out the
 * `ancestryOf` check below and read the result), the moved subtree
 * unlinks from the real root's chain onto its own descendant, so
 * `readVolume` from `ROOT_BLOCK` sees `{ warnings: [], root: [] }` -- no
 * warning, no error, the corrupted directory just isn't there. The disk
 * reads as empty and healthy; the only way to see the cycle at all is to
 * start a walk AT the orphaned block directly, which is not something any
 * normal read path does. Same class of invisibility as `renameEntry`'s
 * self-referencing chain, but one level up (a directory instead of a hash
 * bucket) and with no diagnostic left behind. Checked BEFORE the name
 * collision so a drag onto a descendant reports `cycle` rather than the
 * misleading `name-exists`.
 */
export function moveEntry(
  adf: Uint8Array, fromParent: number, entryBlock: number, toParent: number,
): WriteResult {
  const boot = readBoot(adf);
  if (!boot) return { ok: false, reason: 'no-filesystem' };
  if (bitmapPage(adf) === null) return { ok: false, reason: 'bitmap-untrusted' };

  // Fix round 1: "move it into the directory it is already in" is not a
  // cycle (an entry's own parent is not its own ANCESTOR, so `ancestryOf`
  // below never catches this) and it is not a real name collision either --
  // but `entryNamed` below runs against the ORIGINAL, still-linked array,
  // so it walks `toParent`, finds the entry's own still-present link under
  // this exact name, and reports `name-exists`. That is surfaced to a
  // person as "Something with that name already exists here", which is
  // only true of the entry itself: actively misleading for an operation
  // that changes nothing. `renameEntry` has the analogous case (a
  // case-only rename landing back in its own bucket) and solves it by
  // passing `entryBlock` as `entryNamed`'s `exclude` -- that repairs the
  // check but still re-links the entry into the destination bucket, which
  // for a rename is correct (the NAME changed) but for a move back into
  // the SAME parent under the SAME name would just reorder that bucket's
  // chain for no reason, producing a different but equally valid disk
  // image where an unchanged one was expected (and the caller would hash
  // and store a new blob for bytes that didn't need to change). Short-
  // circuiting here instead -- before the header/dest/cycle/name checks
  // below, all of which exist for an ACTUAL move -- returns the input
  // completely untouched, which is what "drop it where it already is"
  // means to the person doing it.
  if (toParent === fromParent) return { ok: true, adf };

  // Same trust as `deleteEntry`/`renameEntry`, and for the same reason
  // (root.ts): type and secondary type alone are two 32-bit comparisons
  // that ordinary game data can pass by chance. `fromParent`, `entryBlock`
  // and `toParent` all arrive here as raw numbers from the PATCH route, so
  // this is a trust boundary, not an internal helper -- the checksum is
  // what actually distinguishes a filesystem block from a coincidence.
  const header = blockAt(adf, entryBlock);
  if (!header) return { ok: false, reason: 'not-found' };
  if (be32(header, 0) !== T_HEADER) return { ok: false, reason: 'not-found' };
  if (!checksumOk(header, CHECKSUM_WORD)) return { ok: false, reason: 'not-found' };
  const secondary = i32(header, 508);
  if (secondary !== ST_FILE && secondary !== ST_USERDIR) return { ok: false, reason: 'not-found' };
  if (be32(header, 500) !== fromParent) return { ok: false, reason: 'not-found' };

  // THE DESTINATION GETS THE SAME TRUST AS THE SOURCE (fix: the reviewer's
  // finding). A zeroed block with only 0x00000002 (ST_USERDIR) at offset 508
  // used to pass -- no T_HEADER at offset 0, no valid checksum -- because the
  // old check only compared the secondary type. Accepting that let an entry
  // be reparented onto a non-header block: `linkIntoDirectory` then stamps a
  // checksum over four bytes of it and the moved subtree becomes unreachable
  // while still marked allocated. `T_HEADER` and `checksumOk` are exactly
  // the two checks the SOURCE header already gets above; the root block
  // passes both (it IS a T_HEADER block with a real checksum, see root.ts),
  // so this adds no new restriction on moving into the root.
  const dest = blockAt(adf, toParent);
  if (!dest) return { ok: false, reason: 'not-found' };
  if (be32(dest, 0) !== T_HEADER) return { ok: false, reason: 'not-found' };
  if (!checksumOk(dest, CHECKSUM_WORD)) return { ok: false, reason: 'not-found' };
  const destKind = i32(dest, 508);
  if (toParent !== ROOT_BLOCK && destKind !== ST_USERDIR) {
    return { ok: false, reason: 'not-a-directory' };
  }

  // D-DD-6, and the order matters: check the cycle BEFORE the name, so
  // dragging a folder into itself reports why rather than "name-exists".
  if (ancestryOf(adf, toParent).includes(entryBlock)) return { ok: false, reason: 'cycle' };

  const name = bcplString(header, 432, 30);
  if (entryNamed(adf, toParent, name, boot.intl)) return { ok: false, reason: 'name-exists' };

  const out = adf.slice();
  const pred = predecessorOf(out, fromParent, entryBlock, name, boot.intl);
  if (!pred) return { ok: false, reason: 'not-found' };

  const nextHash = be32(out, entryBlock * BLOCK_BYTES + 496);
  putBe32(out, pred.offset, nextHash);
  if (pred.kind === 'slot') recheck(out, fromParent); else recheck(out, pred.block);

  putBe32(out, entryBlock * BLOCK_BYTES + 500, toParent);   // reparent
  putBe32(out, entryBlock * BLOCK_BYTES + 496, 0);          // clear stale next
  linkIntoDirectory(out, toParent, entryBlock, name, boot.intl);
  return { ok: true, adf: out };
}

/**
 * The block number of `parent`'s direct child named `name`, or null when
 * there isn't one.
 *
 * REUSES `walkDirectory` (the same traversal `entryNamed` and
 * `collectSubtreeBlocks` already rely on) rather than a second hash-chain
 * walk -- one opinion of "what is a child of what", same as everywhere else
 * in this file. `applyBatch` calls this right after `makeDirectory` so the
 * new directory's block becomes addressable to later operations in the same
 * batch that name it as their parent.
 */
function findChildBlock(adf: Uint8Array, parent: number, name: string): number | null {
  const { root } = walkDirectory(adf, parent);
  const boot = readBoot(adf);
  const child = root.find((e) => sameName(e.name, name, boot?.intl ?? false));
  return child ? child.block : null;
}

/**
 * Resolve the entry named `name` inside `parent` and overwrite its contents
 * via `replaceFile`, which already knows how to keep the same header block
 * and hash-chain position (D-W-6). `not-found` covers both "no such name"
 * and "that name isn't a file" -- `replaceFile` itself refuses anything
 * whose secondary type isn't `ST_FILE`.
 */
function replaceExisting(adf: Uint8Array, parent: number, name: string, bytes: Uint8Array): WriteResult {
  const block = findChildBlock(adf, parent, name);
  if (block === null) return { ok: false, reason: 'not-found' };
  return replaceFile(adf, block, bytes);
}

/**
 * Resolve a batch-relative path to the block number it names, walking
 * segment by segment from `ROOT_BLOCK` through directories ALREADY on the
 * disk when `dirs` (the batch's own cache, seeded `['', ROOT_BLOCK]`) has no
 * entry for it yet.
 *
 * THE GAP THIS CLOSES: `dirs` used to be populated ONLY by a successful
 * `mkdir` earlier in the same batch (see `applyBatch` below), so dropping a
 * folder onto a directory that already exists on the disk had no path to
 * success at all -- `dirs.get(op.parentPath)` missed, the batch refused
 * `not-found` before writing anything; emitting an `mkdir` for it instead
 * just traded that refusal for `name-exists`. Resolving each segment with
 * `findChildBlock` (the same "what is `parent`'s child named `name`"
 * question `applyBatch` already asks after every `mkdir`) is what makes
 * "commit into a folder that's already there" work at all.
 *
 * Each segment is checked for `ST_USERDIR` (via `blockAt` + `i32`, not just
 * membership in the tree) before being trusted as a directory to search
 * inside: a dropped path running through a pre-existing FILE (`Docs/Notes`
 * where "Docs" is a file, not a folder) must refuse `not-a-directory`
 * rather than silently treating the file's header block as if it had a hash
 * table. A missing segment anywhere along the way is `not-found`, exactly
 * what a miss against `dirs` alone used to mean.
 *
 * Every segment resolved this way is cached into `dirs` under its own
 * partial path, not just the final one -- so a later op in the same batch
 * naming an intermediate directory (or this same one again) resolves in
 * O(1) rather than re-walking from the root, and so it lines up with the
 * caching an `mkdir` result already gets.
 */
function resolveParentPath(
  adf: Uint8Array, dirs: Map<string, number>, path: string,
): { ok: true; block: number } | { ok: false; reason: WriteError } {
  const cached = dirs.get(path);
  if (cached !== undefined) return { ok: true, block: cached };

  const slash = path.lastIndexOf('/');
  const parentPath = slash === -1 ? '' : path.slice(0, slash);
  const name = slash === -1 ? path : path.slice(slash + 1);

  const parent = resolveParentPath(adf, dirs, parentPath);
  if (!parent.ok) return parent;

  const block = findChildBlock(adf, parent.block, name);
  if (block === null) return { ok: false, reason: 'not-found' };

  const header = blockAt(adf, block);
  if (!header || i32(header, 508) !== ST_USERDIR) {
    return { ok: false, reason: 'not-a-directory' };
  }

  dirs.set(path, block);
  return { ok: true, block };
}

/**
 * Turn a list of `BatchOp`s into a single edit function, so a whole folder
 * drop is ONE `applyDiskEdit` call -- one new blob -- rather than one per
 * file (see this task's brief, D-DD-3). `applyDiskEdit` itself is untouched:
 * a batch is just an edit function like any other, applying many operations
 * to one in-memory copy before returning it.
 *
 * ONE copy for the whole batch: `cur` walks forward through each op's
 * result, so the array is copied once per op (each write function already
 * does its own `.slice()`) rather than once per call from outside. A
 * failure anywhere returns that op's own `WriteResult` immediately and
 * `cur` is simply dropped -- the caller's original `adf` was never mutated
 * (every op here follows D-W-3), so the failed batch leaves no trace and
 * needs no transaction or rollback concept.
 *
 * `dirs` maps a batch-relative path to the block number that path resolved
 * to, seeded with the root so `parentPath: ''` always means `ROOT_BLOCK`.
 * Every time an `mkdir` succeeds, its new block is looked up with
 * `findChildBlock` and recorded under its path, which is what lets a LATER
 * op in the same batch address a directory this batch itself just created.
 * `resolveParentPath` is what handles the other case -- a parent that was
 * never created by THIS batch because it was already on the disk.
 *
 * Ordering is the CALLER's job: operations are applied exactly as given, in
 * order, with no sorting here. Task 6 sorts its op list by path depth
 * before calling this, so a parent always exists by the time a child names
 * it -- a batch that silently reordered its own input would be untestable.
 */
export function applyBatch(ops: readonly BatchOp[]): (adf: Uint8Array) => WriteResult {
  return (adf) => {
    let cur = adf;
    const dirs = new Map<string, number>([['', ROOT_BLOCK]]);

    for (const op of ops) {
      const resolved = resolveParentPath(cur, dirs, op.parentPath);
      if (!resolved.ok) return resolved;
      const parent = resolved.block;

      const r = op.op === 'mkdir' ? makeDirectory(cur, parent, op.name)
        : op.op === 'add' ? addFile(cur, parent, op.name, op.bytes, op.protection)
        : replaceExisting(cur, parent, op.name, op.bytes);
      if (!r.ok) return r;
      cur = r.adf;

      if (op.op === 'mkdir') {
        const made = findChildBlock(cur, parent, op.name);
        if (made === null) return { ok: false, reason: 'not-found' };
        dirs.set(op.parentPath ? `${op.parentPath}/${op.name}` : op.name, made);
      }
    }
    return { ok: true, adf: cur };
  };
}
