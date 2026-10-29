// Sorting for the Files panes. Client-safe: types only.
import type { FsEntry } from './types';

export type FilesSortKey = 'name' | 'size' | 'protection' | 'date';
export type FilesSort = { key: FilesSortKey; dir: 'asc' | 'desc' };

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

function byKey(a: FsEntry, b: FsEntry, key: FilesSortKey): number {
  switch (key) {
    case 'name': return byName(a.name, b.name);
    case 'size': return (a.size ?? -1) - (b.size ?? -1);
    case 'protection': return (a.protection ?? '').localeCompare(b.protection ?? '');
    case 'date': return (a.date ? Date.parse(a.date) : -Infinity) - (b.date ? Date.parse(b.date) : -Infinity) || 0;
  }
}

/** An archive is a file here: it opens as a folder, but it sorts with the files (increment 2 ruling 7). */
const isFolder = (e: FsEntry) => e.kind !== 'file' && e.kind !== 'archive';

/** Folders (dir, title, disk) first whatever the key; ties break by name ascending. A new array. */
export function sortFsEntries(entries: FsEntry[], sort: FilesSort): FsEntry[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    const fa = isFolder(a), fb = isFolder(b);
    if (fa !== fb) return fa ? -1 : 1;
    return sign * byKey(a, b, sort.key) || byName(a.name, b.name);
  });
}

/** The phone's one sort button (Files Task 10): below lg only Name is a column, so a tap steps through these. */
export const PHONE_SORTS: readonly FilesSort[] = [
  { key: 'name', dir: 'asc' }, { key: 'name', dir: 'desc' }, { key: 'date', dir: 'desc' },
  { key: 'date', dir: 'asc' }, { key: 'size', dir: 'desc' }, { key: 'size', dir: 'asc' },
];

/** The order after `cur` in PHONE_SORTS; one not in it (Protection, set on a desktop) goes back to Name ▲. */
export function phoneSortAfter(cur: FilesSort): FilesSort {
  const i = PHONE_SORTS.findIndex((s) => s.key === cur.key && s.dir === cur.dir);
  return PHONE_SORTS[i < 0 ? 0 : (i + 1) % PHONE_SORTS.length];
}

/** A header click: the same key flips; a new key starts ascending, except date and size (biggest/newest first). */
export function nextSort(cur: FilesSort, key: FilesSortKey): FilesSort {
  if (cur.key === key) return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: key === 'date' || key === 'size' ? 'desc' : 'asc' };
}
