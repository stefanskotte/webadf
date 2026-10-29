import { fmtSize } from '@/lib/format';
import type { GameListItem } from '@/lib/queries';
import type { LibraryView } from '@/lib/library-view';

/**
 * Which rows the library TABLE shows for a view: the table as a folder
 * listing (operator design 2026-10-21).
 *
 * Collections are flat, one level deep, so the folder structure has exactly
 * two levels. The library root -- the Uncategorized inbox -- lists every
 * collection as a folder, in the collections' own (rail) order, and then the
 * titles filed nowhere, the way a file manager lists folders before files.
 * Everywhere else ("All titles", or inside a collection) there are no
 * folders below, only a way back up to the root, and then the titles.
 *
 * Pure, and kept apart from the component, for the same reason as
 * resolveLibraryView: which rows appear where is a rule, not a layout.
 */
export type TableRow<C, G> =
  | { kind: 'up' }
  | { kind: 'folder'; collection: C }
  | { kind: 'title'; game: G };

// `firstPage` (library paging): the folders are listed on the first page only, as a file browser lists folders
// first; the up row is on every page, so the way out is always there.
export function tableRows<C, G>(
  view: LibraryView, collections: readonly C[], games: readonly G[], { firstPage = true }: { firstPage?: boolean } = {},
): TableRow<C, G>[] {
  const titles = games.map((game) => ({ kind: 'title', game }) as const);
  if (view.kind === 'uncategorized') {
    if (!firstPage) return [...titles];
    return [...collections.map((collection) => ({ kind: 'folder', collection }) as const), ...titles];
  }
  return [{ kind: 'up' }, ...titles];
}

/**
 * The line the table shows under its up row when a collection, or the whole
 * library in All titles, has no titles (final review M2): an up row alone
 * reads like a page that failed to load. Null at the root, where the folders
 * or the empty-library state already say what there is.
 */
export function emptyTableNote(view: LibraryView, titleCount: number): string | null {
  if (titleCount > 0 || view.kind === 'uncategorized') return null;
  return view.kind === 'collection'
    ? 'No titles in this collection yet. Drag one onto it in the list of collections.'
    : 'No titles yet. Drop disks anywhere on this page, or use Add disks.';
}

/**
 * A phone row's fact line (C7 spec §4.3, Ruling 17): the columns a row folds away below sm -- Type, Year, Publisher,
 * Disks, Size -- joined with " · ", unknown ones skipped.
 */
export function titleMeta(g: Pick<GameListItem, 'kind' | 'year' | 'publisher' | 'diskCount' | 'sizeBytes' | 'hasHd'>): string {
  return [
    g.kind,
    g.year != null ? String(g.year) : null,
    g.publisher,
    `${g.diskCount} ${g.diskCount === 1 ? 'disk' : 'disks'}`,
    `${fmtSize(g.sizeBytes)}${g.hasHd ? ' HD' : ''}`,
  ].filter((s): s is string => !!s).join(' · ');
}
