// Directory traversal: hash tables, chains, and every guard from spec
// section 5. This file is where a hostile image is contained.

import {
  HASH_TABLE_SIZE, CHECKSUM_WORD, MAX_ENTRIES, MAX_DEPTH,
  T_HEADER, ST_USERDIR, ST_FILE,
} from './constants';
import { blockAt, be32, i32, checksumOk, bcplString, amigaDate } from './blocks';

export interface AdfEntry {
  name: string;
  kind: 'file' | 'dir';
  /** Block number: the entry's identity within this image (design D-3-5). */
  block: number;
  sizeBytes: number;
  modifiedAt: Date | null;
  protection: string;
  comment: string | null;
  children: AdfEntry[];
}

export interface WalkResult {
  root: AdfEntry[];
  truncated: boolean;
  warnings: string[];
}

/**
 * "hsparwed", as AmigaDOS `list` prints it.
 *
 * The low four bits (rwed) are INVERTED: a SET bit means the action is
 * FORBIDDEN. Reading them the obvious way reports every ordinary file as
 * having no permissions at all.
 */
export function protectionString(bits: number): string {
  const high = [
    [0x80, 'h'], [0x40, 's'], [0x20, 'p'], [0x10, 'a'],
  ] as const;
  const low = [
    [0x08, 'r'], [0x04, 'w'], [0x02, 'e'], [0x01, 'd'],
  ] as const;
  return high.map(([m, c]) => (bits & m ? c : '-')).join('')
    + low.map(([m, c]) => (bits & m ? '-' : c)).join('');
}

export function walkDirectory(
  adf: Uint8Array, start: number, maxEntries: number = MAX_ENTRIES,
): WalkResult {
  const warnings: string[] = [];
  const visited = new Set<number>([start]);
  let count = 0;
  let truncated = false;

  const warn = (m: string) => { if (warnings.length < 50) warnings.push(m); };

  function readEntry(block: number, depth: number): AdfEntry | null {
    const b = blockAt(adf, block);
    if (!b) { warn(`block ${block} is out of range`); return null; }
    if (be32(b, 0) !== T_HEADER) { warn(`block ${block} is not a header`); return null; }
    // A corrupt entry block is skipped rather than trusted: its name and size
    // fields would otherwise be read out of arbitrary bytes.
    if (!checksumOk(b, CHECKSUM_WORD)) { warn(`block ${block} has a bad checksum`); return null; }

    const secondary = i32(b, 508);
    const isDir = secondary === ST_USERDIR;
    const isFile = secondary === ST_FILE;
    if (!isDir && !isFile) return null;

    const entry: AdfEntry = {
      name: bcplString(b, 432, 30),
      kind: isDir ? 'dir' : 'file',
      block,
      sizeBytes: isFile ? be32(b, 324) : 0,
      modifiedAt: amigaDate(b, 420),
      protection: protectionString(be32(b, 320)),
      comment: bcplString(b, 328, 79) || null,
      children: [],
    };

    if (isDir) {
      if (depth >= MAX_DEPTH) {
        warn(`directory nesting deeper than ${MAX_DEPTH} at block ${block}`);
      } else {
        entry.children = readTable(block, depth + 1);
      }
    }
    return entry;
  }

  function readTable(dirBlock: number, depth: number): AdfEntry[] {
    const dir = blockAt(adf, dirBlock);
    if (!dir) return [];
    const out: AdfEntry[] = [];

    for (let slot = 0; slot < HASH_TABLE_SIZE; slot++) {
      let ptr = be32(dir, 24 + slot * 4);
      while (ptr !== 0) {
        if (count >= maxEntries) { truncated = true; return out; }
        // Guard 2: a chain that revisits a block would otherwise spin
        // forever and take the request thread with it.
        if (visited.has(ptr)) { warn(`hash chain cycle at block ${ptr}`); break; }
        visited.add(ptr);

        const next = blockAt(adf, ptr);
        if (!next) { warn(`hash chain points to block ${ptr}, out of range`); break; }

        count++;
        const entry = readEntry(ptr, depth);
        if (entry) out.push(entry);
        ptr = be32(next, 496);
      }
    }
    return out;
  }

  const root = readTable(start, 0);
  return { root, truncated, warnings };
}
