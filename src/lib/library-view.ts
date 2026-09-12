/**
 * Which slice of the library /library is showing, decided from the query
 * string alone.
 *
 * Pure and separate from the page because the rules are not obvious and they
 * are the kind of thing that quietly rots: what an absent parameter means,
 * what a stale link does, and which of the three view kinds a given string
 * resolves to. A page component is a bad place to have to re-derive that.
 *
 * THE LANDING IS "UNCATEGORIZED", NOT "ALL TITLES". The library works as an
 * inbox: newly ingested titles belong to no collection, so they arrive here,
 * and filing one into a collection takes it off this page. That is the whole
 * point -- an inbox that never empties is just a second copy of the library.
 * "All titles" is still one click away at the bottom of the rail.
 */

/** The two reserved values of ?collection=. Neither can collide with a real
 *  collection: ids are server-generated UUIDs (randomUUID in
 *  src/lib/collections.ts) and no user input reaches them, so there is no
 *  creation-time check to add here -- the id is simply never chosen by
 *  anyone. If that ever changes, this list is what a check would use. */
export const UNCATEGORIZED = 'uncategorized';
export const ALL_TITLES = 'all';
export const RESERVED_COLLECTION_IDS: readonly string[] = [UNCATEGORIZED, ALL_TITLES];

export type LibraryView =
  | { kind: 'uncategorized' }
  | { kind: 'all' }
  | { kind: 'collection'; id: string };

/**
 * `raw` is untrusted: it comes straight off the query string. A collection id
 * is only ever returned when it appears in `knownIds` -- this org's own
 * collections -- because collection_games carries no org_id of its own, so
 * every caller downstream trusts that this check happened.
 */
export function resolveLibraryView(
  raw: string | string[] | undefined,
  knownIds: readonly string[],
): LibraryView {
  const value = typeof raw === 'string' ? raw : undefined;
  if (value === undefined || value === UNCATEGORIZED) return { kind: 'uncategorized' };
  if (value === ALL_TITLES) return { kind: 'all' };
  if (knownIds.includes(value)) return { kind: 'collection', id: value };
  // An unknown id -- a deleted collection, a bookmark from another tenant --
  // shows the whole library rather than 404ing or silently landing somewhere
  // that looks like a filtered view of it. A stale link should be harmless,
  // and "harmless" here means obviously showing everything.
  return { kind: 'all' };
}

/** The inverse: the query value that selects a view. Null means "no
 *  parameter", which is the landing. */
export function viewParam(view: LibraryView): string | null {
  if (view.kind === 'uncategorized') return null;
  if (view.kind === 'all') return ALL_TITLES;
  return view.id;
}

export function viewHref(view: LibraryView, params?: URLSearchParams): string {
  const next = new URLSearchParams(params?.toString() ?? '');
  const v = viewParam(view);
  if (v === null) next.delete('collection');
  else next.set('collection', v);
  const qs = next.toString();
  return qs ? `/library?${qs}` : '/library';
}

/** True when the rail row for `candidate` should render as selected. */
export function isCurrentView(view: LibraryView, candidate: LibraryView): boolean {
  if (view.kind !== candidate.kind) return false;
  return view.kind !== 'collection' || view.id === (candidate as { id: string }).id;
}
