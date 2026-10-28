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

/** Folders (dir, title, disk) first whatever the key; ties break by name ascending. A new array. */
export function sortFsEntries(entries: FsEntry[], sort: FilesSort): FsEntry[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    const fa = a.kind !== 'file', fb = b.kind !== 'file';
    if (fa !== fb) return fa ? -1 : 1;
    return sign * byKey(a, b, sort.key) || byName(a.name, b.name);
  });
}

/** A header click: the same key flips; a new key starts ascending, except date and size (biggest/newest first). */
export function nextSort(cur: FilesSort, key: FilesSortKey): FilesSort {
  if (cur.key === key) return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: key === 'date' || key === 'size' ? 'desc' : 'asc' };
}
