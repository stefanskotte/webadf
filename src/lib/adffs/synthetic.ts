// Deterministic synthetic volumes, built in memory for tests.
//
// Mirrors adfmfm/synthetic.ts and exists for the same reason (parent spec
// section 14): no real disk image, and nothing derived from one, belongs in
// this repository. Everything here writes CORRECT checksums unless a test
// asks for a broken one, so a fixture is something a real Amiga would mount.

import {
  BLOCK_BYTES, BLOCK_COUNT, ROOT_BLOCK, HASH_TABLE_SIZE, CHECKSUM_WORD,
  OFS_DATA_BYTES, T_HEADER, ST_ROOT, ST_USERDIR,
} from './constants';
import { blockChecksum } from './blocks';
import type { Filesystem } from './boot';
import { nameHash } from './hash';
import { putBe32, putName, recheck } from './write-blocks';
import { writeDataBlocks, writeFileHeader, writeExtensionBlocks } from './write';

// Re-exported: synthetic.test.ts, dir.test.ts and file.test.ts import these
// by name from here rather than from hash.ts / write-blocks.ts directly.
export { nameHash } from './hash';
export { recheck } from './write-blocks';

export interface SyntheticFile { name: string; bytes: Uint8Array }
export interface SyntheticDir { name: string; entries: SyntheticEntry[] }
export type SyntheticEntry = SyntheticFile | SyntheticDir;

export interface SyntheticOptions {
  filesystem?: Filesystem;
  intl?: boolean;
  dirc?: boolean;
  volumeName?: string;
  entries?: SyntheticEntry[];
  breakRootChecksum?: boolean;
  breakBootChecksum?: boolean;
  noSignature?: boolean;
}

const isDir = (e: SyntheticEntry): e is SyntheticDir =>
  Array.isArray((e as SyntheticDir).entries);

/**
 * Bitmap block. Written LAST, once every allocation is known.
 *
 * Copied from format.ts's `--- bitmap block ---` section, already verified
 * against xdftool -- do not invent a second version of this arithmetic.
 * A SET bit means FREE, and the checksum sits at offset 0 rather than word 5.
 */
function writeBitmap(adf: Uint8Array, used: number[], page: number) {
  const bm = page * BLOCK_BYTES;
  adf.fill(0xff, bm + 4, bm + BLOCK_BYTES);   // every bit FREE to begin with
  for (const block of [...used, page]) {
    const bit = block - 2;                     // bitmap covers 2..1759
    const o = bm + 4 + (bit >>> 5) * 4;
    const word = ((adf[o] << 24) | (adf[o + 1] << 16) | (adf[o + 2] << 8) | adf[o + 3]) >>> 0;
    putBe32(adf, o, (word & ~(1 << (bit & 31))) >>> 0);   // CLEAR means used
  }
  putBe32(adf, bm, 0);
  let sum = 0;
  for (let o = bm; o < bm + BLOCK_BYTES; o += 4) {
    sum = (sum + (((adf[o] << 24) | (adf[o + 1] << 16) | (adf[o + 2] << 8) | adf[o + 3]) >>> 0)) >>> 0;
  }
  putBe32(adf, bm, (-sum >>> 0));
}

export function syntheticVolume(opts: SyntheticOptions = {}): Uint8Array {
  const {
    filesystem = 'OFS', intl = false, dirc = false,
    volumeName = 'TestVol', entries = [],
    breakRootChecksum = false, breakBootChecksum = false, noSignature = false,
  } = opts;

  const adf = new Uint8Array(BLOCK_BYTES * BLOCK_COUNT);

  // ---- boot block ----
  if (!noSignature) {
    adf.set([0x44, 0x4f, 0x53], 0);
    adf[3] = (filesystem === 'FFS' ? 1 : 0) | (intl ? 2 : 0) | (dirc ? 4 : 0);
    putBe32(adf, 8, ROOT_BLOCK);
  }

  let nextData = ROOT_BLOCK + 2;   // data blocks grow upward from 882
  let nextMeta = ROOT_BLOCK - 1;   // dir/file headers grow downward from 879
  const allocated: number[] = [ROOT_BLOCK];
  const allocData = () => { const b = nextData++; allocated.push(b); return b; };
  const allocMeta = () => { const b = nextMeta--; allocated.push(b); return b; };

  /**
   * Write one file's data blocks and its header; returns the header block.
   *
   * Lays blocks out with ITS OWN strategy (data upward via allocData,
   * metadata -- header and extensions -- downward via allocMeta) and hands
   * the resulting block numbers to write.ts's shared writers, which own the
   * one implementation of the on-disk format (spec D-W-2, Ruling R-1).
   */
  function writeFile(name: string, bytes: Uint8Array, parent: number): number {
    const perBlock = filesystem === 'OFS' ? OFS_DATA_BYTES : BLOCK_BYTES;
    const dataCount = Math.max(1, Math.ceil(bytes.length / perBlock));
    const dataBlocks = Array.from({ length: dataCount }, allocData);
    const header = allocMeta();

    // Extension blocks for anything beyond 72 data blocks. 112 real files
    // need this, so it is exercised, not theoretical. Allocated in the same
    // order (header, then each extension in chain order) as before, so
    // fixtures built here still occupy the same block numbers.
    const extCount = Math.max(0, Math.ceil((dataCount - HASH_TABLE_SIZE) / HASH_TABLE_SIZE));
    const exts = Array.from({ length: extCount }, allocMeta);

    writeDataBlocks(adf, dataBlocks, bytes, header, filesystem, perBlock);
    writeFileHeader(adf, header, parent, name, bytes.length, dataBlocks.slice(0, HASH_TABLE_SIZE), exts[0] ?? 0);
    writeExtensionBlocks(adf, exts, dataBlocks, header);
    return header;
  }

  /**
   * Link a child into a parent directory's hash chain.
   *
   * The child's checksum is RECOMPUTED afterwards, and that is not optional:
   * writeFile and writeDir have already checksummed the child by the time
   * this runs, and writing its hash-chain pointer at offset 496 invalidates
   * that checksum. walkDirectory rejects entry blocks whose checksum fails,
   * so without this every synthetic volume lists as empty -- looking exactly
   * like a traversal bug rather than a fixture bug.
   */
  function link(parent: number, child: number, name: string) {
    const slot = nameHash(name, intl);
    const ps = parent * BLOCK_BYTES;
    const head = (adf[ps + 24 + slot * 4] << 24 | adf[ps + 24 + slot * 4 + 1] << 16
      | adf[ps + 24 + slot * 4 + 2] << 8 | adf[ps + 24 + slot * 4 + 3]) >>> 0;
    putBe32(adf, child * BLOCK_BYTES + 496, head);
    putBe32(adf, ps + 24 + slot * 4, child);
    recheck(adf, child);
  }

  function writeDir(name: string, list: SyntheticEntry[], parent: number): number {
    const dir = allocMeta();
    const ds = dir * BLOCK_BYTES;
    putBe32(adf, ds, T_HEADER);
    putBe32(adf, ds + 4, dir);
    putName(adf, ds, name);
    putBe32(adf, ds + 500, parent);
    putBe32(adf, ds + 508, ST_USERDIR);
    fill(dir, list);
    putBe32(adf, ds + CHECKSUM_WORD * 4,
      blockChecksum(adf.subarray(ds, ds + BLOCK_BYTES), CHECKSUM_WORD));
    return dir;
  }

  function fill(parent: number, list: SyntheticEntry[]) {
    for (const e of list) {
      const child = isDir(e)
        ? writeDir(e.name, e.entries, parent)
        : writeFile(e.name, e.bytes, parent);
      link(parent, child, e.name);
    }
  }

  // ---- root block ----
  const rs = ROOT_BLOCK * BLOCK_BYTES;
  putBe32(adf, rs, T_HEADER);
  putBe32(adf, rs + 12, HASH_TABLE_SIZE);
  putBe32(adf, rs + 508, ST_ROOT);
  putName(adf, rs, volumeName);
  putBe32(adf, rs + 16, 1);   // days: a non-zero date so amigaDate returns one
  putBe32(adf, rs + 420, 1);
  putBe32(adf, rs + 312, 0xffffffff);   // bm_flag: valid
  putBe32(adf, rs + 316, 881);          // bm_pages[0]
  fill(ROOT_BLOCK, entries);

  // The counters must not collide with block 881: nextData starts at 882, so
  // it does not, but this is asserted rather than trusted.
  if (allocated.includes(881)) throw new Error('synthetic allocator collided with the bitmap block');
  writeBitmap(adf, allocated, 881);

  putBe32(adf, rs + CHECKSUM_WORD * 4,
    blockChecksum(adf.subarray(rs, rs + BLOCK_BYTES), CHECKSUM_WORD));

  // Reproduces the Project-X shape: structurally plausible, checksum bogus.
  if (breakRootChecksum) putBe32(adf, rs + CHECKSUM_WORD * 4, 0x31313131);
  if (breakBootChecksum) putBe32(adf, 4, 0xdeadbeef);

  return adf;
}
