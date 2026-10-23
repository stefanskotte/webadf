// Finding an entry in a parsed AmigaDOS tree by its header block -- shared by
// the per-file route (files/[block]), the bulk route (files/bulk) and the zip.

import type { AdfEntry } from '@/lib/adffs';

/** Depth-first search for the entry at `block`, so its NAME can be used. */
export function findEntry(entries: AdfEntry[], block: number): AdfEntry | null {
  for (const e of entries) {
    if (e.block === block) return e;
    const found = findEntry(e.children, block);
    if (found) return found;
  }
  return null;
}

/**
 * Same walk as `findEntry`, but also returns the block the entry lives
 * directly under. `renameEntry` and `deleteEntry` both take the PARENT block
 * explicitly (spec D-3-5's block-addressing has no parent pointer of its
 * own to read back), so the only way to get it is to walk down from the
 * volume's root block and remember where each entry was found.
 */
export function findEntryWithParent(
  entries: AdfEntry[], block: number, parentBlock: number,
): { entry: AdfEntry; parentBlock: number } | null {
  for (const e of entries) {
    if (e.block === block) return { entry: e, parentBlock };
    const found = findEntryWithParent(e.children, block, e.block);
    if (found) return found;
  }
  return null;
}

/** True when `block` sits under a folder that is itself in `selected`. */
export function underSelected(root: AdfEntry[], block: number, selected: ReadonlySet<number>): boolean {
  const walk = (list: AdfEntry[], under: boolean): boolean | null => {
    for (const e of list) {
      if (e.block === block) return under;
      const found = walk(e.children, under || selected.has(e.block));
      if (found !== null) return found;
    }
    return null;
  };
  return walk(root, false) === true;
}
