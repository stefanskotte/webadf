// src/lib/files/view.ts
// What a pane draws and says (Files increment 4: settings and the filter). CLIENT-SAFE: types and pure functions only.
// The Pane and the manager both draw rows through paneRows, so a row index names the same entry in both.
import type { FilesCommentMode, UserPrefs } from '@/lib/user-prefs-schema';
import { sortFsEntries, type FilesSort } from './sort';
import type { Selection } from './selection';
import { parsePath } from './path';
import type { FsEntry, Listing } from './types';

/** The filter text (this pane's, R6) and Show .info (both panes, R7). */
export type PaneView = { filter: string; hideInfo: boolean };

/** A Workbench icon FILE: "Disk.info", "ReadMe.INFO". */
export const isInfoName = (e: Pick<FsEntry, 'kind' | 'name'>) => e.kind === 'file' && e.name.toLowerCase().endsWith('.info');

function matches(view: PaneView) {
  const q = view.filter.trim().toLowerCase();
  return (e: FsEntry) => !q || e.name.toLowerCase().includes(q);
}

function visible(view: PaneView) {
  const m = matches(view);
  return (e: FsEntry) => !(view.hideInfo && isInfoName(e)) && m(e);
}

/** The rows a pane draws, in the order it draws them. */
export function paneRows(entries: FsEntry[], sort: FilesSort, view: PaneView): FsEntry[] {
  return sortFsEntries(entries, sort).filter(visible(view));
}

export function viewCounts(entries: FsEntry[], view: PaneView): { total: number; shown: number; infoHidden: number } {
  return {
    total: entries.length,
    shown: entries.filter(visible(view)).length,
    // Only the .info files the text filter would keep: the foot never blames Show .info for what the filter hides.
    infoHidden: view.hideInfo ? entries.filter((e) => isInfoName(e) && matches(view)(e)).length : 0,
  };
}

/** The same place drawn another way (a sort, a filter, a fresh listing): picks and the cursor follow their entries; a hidden one is let go. */
export function remapSelection(before: FsEntry[], after: FsEntry[], sel: Selection): Selection {
  const at = new Map(after.map((e, i) => [e.path, i]));
  const map = (i: number | null) => (i === null || !before[i] ? null : at.get(before[i].path) ?? null);
  const picked = new Set<number>();
  for (const i of sel.picked) { const j = map(i); if (j !== null) picked.add(j); }
  return { anchor: map(sel.anchor), cursor: map(sel.cursor) ?? 0, picked };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The foot: the selection, else "N of M shown" when rows are hidden, else the pane's own words (`base`). */
export function paneFoot(a: { base: string; shown: number; total: number; infoHidden: number; picked: number; pickedSize: string }): string {
  if (a.picked > 0) return `${a.picked} of ${a.shown} selected · ${a.pickedSize}`;
  if (a.shown < a.total) return `${a.shown} of ${a.total} shown${a.infoHidden ? ` · ${plural(a.infoHidden, '.info file')} hidden` : ''}`;
  return a.base;
}

/** R3: 'auto' shows the Comment column in STASH: only (increment 2 ruling 9). */
export function showsComment(mode: FilesCommentMode, path: string): boolean {
  return mode === 'always' || (mode === 'auto' && parsePath(path)?.device === 'STASH');
}

/** R2: with the setting off, only a delete inside a disk (versioned, Undo) skips the confirm. */
export function deleteAsks(confirmDelete: boolean, l: Listing | null): boolean {
  return confirmDelete || !l?.disk;
}

/** R5: the panes a bare /files opens with. */
export function paneDefaults(p: UserPrefs['files']['panes']): { left: string; right: string } {
  return { left: `${p.left}:`, right: `${p.right}:` };
}

/** R9: the "?" in a pane's header. */
export function paneHelpTopic(path: string): 'files' | 'stash-net' {
  const d = parsePath(path)?.device;
  return d === 'STASH' || d === 'NET' ? 'stash-net' : 'files';
}
