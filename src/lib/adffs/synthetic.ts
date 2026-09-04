// Deterministic synthetic volumes, built in memory for tests.
//
// Mirrors adfmfm/synthetic.ts and exists for the same reason (parent spec
// section 14): no real disk image, and nothing derived from one, belongs in
// this repository. Everything here writes CORRECT checksums unless a test
// asks for a broken one, so a fixture is something a real Amiga would mount.

import {
  BLOCK_BYTES, BLOCK_COUNT, ROOT_BLOCK, HASH_TABLE_SIZE, CHECKSUM_WORD,
  OFS_DATA_CHECKSUM_WORD, OFS_DATA_BYTES, T_HEADER, T_DATA, T_LIST,
  ST_ROOT, ST_USERDIR, ST_FILE,
} from './constants';
import { blockChecksum } from './blocks';
import type { Filesystem } from './boot';

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

function putBe32(a: Uint8Array, off: number, v: number) {
  a[off] = (v >>> 24) & 0xff; a[off + 1] = (v >>> 16) & 0xff;
  a[off + 2] = (v >>> 8) & 0xff; a[off + 3] = v & 0xff;
}

function putName(a: Uint8Array, blockStart: number, name: string) {
  const n = name.slice(0, 30);
  a[blockStart + 432] = n.length;
  for (let i = 0; i < n.length; i++) a[blockStart + 433 + i] = n.charCodeAt(i) & 0xff;
}

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

/**
 * The AmigaDOS directory hash. INTL folds the extended Latin range as well as
 * ASCII, which is why 6 archive disks need the second variant.
 */
export function nameHash(name: string, intl: boolean): number {
  let hash = name.length;
  for (const ch of name) {
    const c = ch.charCodeAt(0);
    const upper = intl
      ? ((c >= 0x61 && c <= 0x7a) || (c >= 0xe0 && c <= 0xfe && c !== 0xf7) ? c - 32 : c)
      : (c >= 0x61 && c <= 0x7a ? c - 32 : c);
    hash = ((hash * 13) + upper) >>> 0;
    hash = hash & 0x7ff;
  }
  return hash % HASH_TABLE_SIZE;
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

  /** Write one file's data blocks and its header; returns the header block. */
  function writeFile(name: string, bytes: Uint8Array, parent: number): number {
    const perBlock = filesystem === 'OFS' ? OFS_DATA_BYTES : BLOCK_BYTES;
    const dataBlocks: number[] = [];
    for (let off = 0; off < Math.max(bytes.length, 1); off += perBlock) {
      dataBlocks.push(allocData());
      if (bytes.length === 0) break;
    }
    const header = allocMeta();

    // Data blocks.
    dataBlocks.forEach((blk, i) => {
      const start = blk * BLOCK_BYTES;
      const chunk = bytes.subarray(i * perBlock, (i + 1) * perBlock);
      if (filesystem === 'OFS') {
        putBe32(adf, start, T_DATA);
        putBe32(adf, start + 4, header);
        putBe32(adf, start + 8, i + 1);              // sequence number, 1-based
        putBe32(adf, start + 12, chunk.length);
        putBe32(adf, start + 16, dataBlocks[i + 1] ?? 0);
        adf.set(chunk, start + 24);
        putBe32(adf, start + OFS_DATA_CHECKSUM_WORD * 4,
          blockChecksum(adf.subarray(start, start + BLOCK_BYTES), OFS_DATA_CHECKSUM_WORD));
      } else {
        adf.set(chunk, start);
      }
    });

    // File header. Data pointers live at 24..307 in REVERSE order.
    const hs = header * BLOCK_BYTES;
    putBe32(adf, hs, T_HEADER);
    putBe32(adf, hs + 4, header);
    putBe32(adf, hs + 8, Math.min(dataBlocks.length, HASH_TABLE_SIZE));
    putBe32(adf, hs + 16, dataBlocks[0] ?? 0);
    putBe32(adf, hs + 324, bytes.length);
    const inHeader = dataBlocks.slice(0, HASH_TABLE_SIZE);
    inHeader.forEach((blk, i) => {
      putBe32(adf, hs + 24 + (HASH_TABLE_SIZE - 1 - i) * 4, blk);
    });

    // Extension blocks for anything beyond 72 data blocks. 112 real files
    // need this, so it is exercised, not theoretical.
    //
    // Chaining a new extension block onto a PREVIOUS extension block writes
    // that block's +504 pointer AFTER its checksum was already stored, which
    // invalidates it -- the same failure shape link() below guards against
    // for the hash-chain pointer. recheck() fixes it. The file header itself
    // is exempt: it is checksummed after this loop runs, so the +504 write
    // into it here still happens before its checksum is taken.
    let remaining = dataBlocks.slice(HASH_TABLE_SIZE);
    let prevBlock = header;
    while (remaining.length > 0) {
      const ext = allocMeta();
      putBe32(adf, prevBlock * BLOCK_BYTES + 504, ext);
      if (prevBlock !== header) recheck(adf, prevBlock);
      const es = ext * BLOCK_BYTES;
      const take = remaining.slice(0, HASH_TABLE_SIZE);
      putBe32(adf, es, T_LIST);
      putBe32(adf, es + 4, ext);
      putBe32(adf, es + 8, take.length);
      putBe32(adf, es + 500, header);
      take.forEach((blk, i) => {
        putBe32(adf, es + 24 + (HASH_TABLE_SIZE - 1 - i) * 4, blk);
      });
      putBe32(adf, es + 508, ST_FILE);
      putBe32(adf, es + CHECKSUM_WORD * 4,
        blockChecksum(adf.subarray(es, es + BLOCK_BYTES), CHECKSUM_WORD));
      remaining = remaining.slice(HASH_TABLE_SIZE);
      prevBlock = ext;
    }

    putName(adf, hs, name);
    putBe32(adf, hs + 500, parent);
    putBe32(adf, hs + 508, ST_FILE >>> 0);
    putBe32(adf, hs + CHECKSUM_WORD * 4,
      blockChecksum(adf.subarray(hs, hs + BLOCK_BYTES), CHECKSUM_WORD));
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
