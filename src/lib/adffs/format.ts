// Formatting a blank AmigaDOS volume.
//
// THE FIRST WRITE PATH IN THIS MODULE. Everything beside it reads, and
// index.ts still says the module does not maintain bitmaps -- that sentence
// is now true of the READER only. Reading and writing are asymmetric in a way
// that matters here: the reader deliberately ignores the bitmap (a disk reads
// perfectly with a wrong one), so THE READER CANNOT CHECK THIS FILE'S MOST
// important output. That is why format.test.ts cross-checks against amitools'
// xdftool, an independent implementation, rather than only round-tripping
// through readVolume.
//
// Layout below was measured from a disk xdftool formatted, not taken from
// documentation -- same rule as constants.ts.

import {
  BLOCK_BYTES, BLOCK_COUNT, ROOT_BLOCK, HASH_TABLE_SIZE,
  CHECKSUM_WORD, T_HEADER, ST_ROOT,
} from './constants';
import { blockChecksum } from './blocks';
import type { Filesystem } from './boot';

/** Immediately after the root block, which is where a real format puts it. */
export const BITMAP_BLOCK = ROOT_BLOCK + 1;

/**
 * The bitmap covers blocks 2..1759 -- the two boot blocks are NOT in it.
 * xdftool's `info` reports 4 blocks used on a blank disk (boot x2, root,
 * bitmap) but only two of those are bits.
 */
const BITMAP_FIRST_BLOCK = 2;
const BITMAP_BITS = BLOCK_COUNT - BITMAP_FIRST_BLOCK;

const FLAG_FFS = 0x01;
const FLAG_INTL = 0x02;

export interface FormatOptions {
  filesystem: Filesystem;
  volumeName: string;
  /** International mode: changes the directory hash. Off unless asked for. */
  intl?: boolean;
  /**
   * Injectable so a test can assert exact bytes. Real callers leave it out
   * and get "now", which is what a format does.
   */
  now?: Date;
}

function putBe32(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

/**
 * AmigaDOS keeps dates as days since 1978-01-01 plus minutes plus ticks of
 * 1/50 s. Written into the three consecutive longs at `offset`.
 */
/** Exported so write.ts's `makeDirectory` can reuse it -- D-W-2: one implementation. */
export function putAmigaDate(buf: Uint8Array, offset: number, when: Date): void {
  const epoch = Date.UTC(1978, 0, 1);
  const ms = when.getTime() - epoch;
  const days = Math.floor(ms / 86_400_000);
  const restMs = ms - days * 86_400_000;
  const mins = Math.floor(restMs / 60_000);
  const ticks = Math.floor((restMs - mins * 60_000) / 20);
  putBe32(buf, offset, Math.max(0, days));
  putBe32(buf, offset + 4, Math.max(0, mins));
  putBe32(buf, offset + 8, Math.max(0, ticks));
}

/**
 * A BCPL string: one length byte, then the characters, unterminated.
 *
 * Truncated at 30 rather than rejected. AmigaDOS reserves 31 bytes for a
 * volume name and a person typing a long one wants a disk, not an error --
 * validation of what they MAY type belongs in the route, not in the format.
 */
export const MAX_VOLUME_NAME = 30;

function putBcpl(buf: Uint8Array, lengthOffset: number, value: string, max: number): void {
  const bytes: number[] = [];
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    // latin-1 only: the name lives in a fixed 31-byte field and an Amiga has
    // no notion of UTF-8. Anything outside the range becomes '_' rather than
    // being silently dropped, so a name never comes back shorter than typed.
    bytes.push(code <= 0xff ? code : 0x5f);
    if (bytes.length >= max) break;
  }
  buf[lengthOffset] = bytes.length;
  for (let i = 0; i < bytes.length; i++) buf[lengthOffset + 1 + i] = bytes[i];
}

/**
 * A freshly formatted, empty 880 KB volume.
 *
 * Byte-identical to `xdftool create + format`, except for the two timestamps
 * -- proven in format.test.ts by formatting both and diffing.
 */
export function formatVolume(opts: FormatOptions): Uint8Array {
  const adf = new Uint8Array(BLOCK_BYTES * BLOCK_COUNT);
  const when = opts.now ?? new Date();

  // --- boot block -------------------------------------------------------
  adf[0] = 0x44; adf[1] = 0x4f; adf[2] = 0x53;            // 'DOS'
  adf[3] = (opts.filesystem === 'FFS' ? FLAG_FFS : 0)
    | (opts.intl ? FLAG_INTL : 0);
  // Bytes 4..7 are the boot checksum and are left ZERO, which is what
  // xdftool writes for a formatted-but-not-bootable disk. readBoot does not
  // verify it (D-3-2: only 19 of 49 sound archive disks have a valid one),
  // and claiming a checksum for boot code that does not exist would be worse
  // than leaving it absent.
  putBe32(adf, 8, ROOT_BLOCK);

  // --- root block -------------------------------------------------------
  const root = ROOT_BLOCK * BLOCK_BYTES;
  putBe32(adf, root + 0, T_HEADER);
  // header_key and high_seq are 0 on a root block; hash table size is not.
  putBe32(adf, root + 12, HASH_TABLE_SIZE);
  // The hash table (72 longs from offset 24) stays zero: no entries yet.
  putBe32(adf, root + 312, 0xffffffff);                    // bm_flag: valid
  putBe32(adf, root + 316, BITMAP_BLOCK);                  // bm_pages[0]
  // THREE date triples, not one. Omitting any leaves it zero, which reads as
  // 1978-01-01 on an Amiga and differs from a real format.
  putAmigaDate(adf, root + 420, when);   // last change to the root DIRECTORY
  putBcpl(adf, root + 432, opts.volumeName, MAX_VOLUME_NAME);
  putAmigaDate(adf, root + 472, when);   // last change to the VOLUME
  putAmigaDate(adf, root + 484, when);   // volume created
  putBe32(adf, root + 508, ST_ROOT);
  putBe32(adf, root + CHECKSUM_WORD * 4,
    blockChecksum(adf.subarray(root, root + BLOCK_BYTES), CHECKSUM_WORD));

  // --- bitmap block -----------------------------------------------------
  //
  // A SET BIT MEANS FREE. This is the single most invertible fact in the
  // format and the one the reader cannot catch: a bitmap that is exactly
  // wrong still reads perfectly, and only corrupts when a real Amiga writes
  // to the disk and believes an occupied block is available.
  const bm = BITMAP_BLOCK * BLOCK_BYTES;
  // Every bit free to begin with, INCLUDING the trailing bits past block
  // 1759 -- xdftool leaves the whole remainder of the block 0xff, and
  // matching it keeps the two outputs diffable.
  adf.fill(0xff, bm + 4, bm + BLOCK_BYTES);
  for (const used of [ROOT_BLOCK, BITMAP_BLOCK]) {
    const bit = used - BITMAP_FIRST_BLOCK;
    const wordOffset = bm + 4 + (bit >>> 5) * 4;
    const mask = 1 << (bit & 31);
    // Read-modify-write big-endian, clearing the bit: allocated.
    const word = ((adf[wordOffset] << 24) | (adf[wordOffset + 1] << 16)
      | (adf[wordOffset + 2] << 8) | adf[wordOffset + 3]) >>> 0;
    putBe32(adf, wordOffset, (word & ~mask) >>> 0);
  }
  // The bitmap's checksum makes the sum of ALL 128 longs in the block zero,
  // and unlike every other block here the checksum sits at offset 0 rather
  // than word 5.
  putBe32(adf, bm, 0);
  let sum = 0;
  for (let o = bm; o < bm + BLOCK_BYTES; o += 4) {
    sum = (sum + (((adf[o] << 24) | (adf[o + 1] << 16) | (adf[o + 2] << 8) | adf[o + 3]) >>> 0)) >>> 0;
  }
  putBe32(adf, bm, (-sum >>> 0));

  return adf;
}

/** Blocks the bitmap says are in use. Exported for tests and future writes. */
export function usedBlocks(adf: Uint8Array): number[] {
  const bm = BITMAP_BLOCK * BLOCK_BYTES;
  const used: number[] = [];
  for (let bit = 0; bit < BITMAP_BITS; bit++) {
    const o = bm + 4 + (bit >>> 5) * 4;
    const word = ((adf[o] << 24) | (adf[o + 1] << 16) | (adf[o + 2] << 8) | adf[o + 3]) >>> 0;
    if ((word & (1 << (bit & 31))) === 0) used.push(bit + BITMAP_FIRST_BLOCK);
  }
  return used;
}

/**
 * Rename a volume in place, preserving everything on it.
 *
 * NOT a re-format. Re-formatting to change a name would silently erase every
 * file on the disk, and this has to be safe on a disk that already holds
 * something -- a person renaming a disk is not asking to empty it. Only the
 * root block's name field and its checksum change.
 *
 * Returns fresh bytes rather than mutating: `blobs` is content-addressed, so
 * a rename necessarily produces a DIFFERENT disk with a different sha-256.
 * There is no in-place edit anywhere in this system, and pretending otherwise
 * in this signature would invite a caller to write over a blob other tenants
 * may still be entitled to.
 */
export function setVolumeName(adf: Uint8Array, volumeName: string): Uint8Array {
  const out = adf.slice();
  const root = ROOT_BLOCK * BLOCK_BYTES;
  // Clear the whole 31-byte field first: a shorter name would otherwise leave
  // the tail of the previous one behind it, which the length byte hides from
  // our reader but a hex dump would not.
  out.fill(0, root + 432, root + 464);
  putBcpl(out, root + 432, volumeName, MAX_VOLUME_NAME);
  putBe32(out, root + CHECKSUM_WORD * 4, 0);
  putBe32(out, root + CHECKSUM_WORD * 4,
    blockChecksum(out.subarray(root, root + BLOCK_BYTES), CHECKSUM_WORD));
  return out;
}
