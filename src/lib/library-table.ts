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

export function tableRows<C, G>(view: LibraryView, collections: readonly C[], games: readonly G[]): TableRow<C, G>[] {
  const titles = games.map((game) => ({ kind: 'title', game }) as const);
  if (view.kind === 'uncategorized') {
    return [...collections.map((collection) => ({ kind: 'folder', collection }) as const), ...titles];
  }
  return [{ kind: 'up' }, ...titles];
}
