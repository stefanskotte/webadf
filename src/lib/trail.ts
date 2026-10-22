// Where a person came from, carried through the links they followed.
//
// WHY THIS IS CARRIED RATHER THAN DERIVED. A game can be in many collections
// and `collection_games` is many-to-many by design, so /games/[id] cannot work
// out which one you opened it from -- there is no answer in the data. The only
// options are to carry it or to lie.
//
// AND WHY NOT THE BROWSER'S HISTORY, which is what "follow the history" would
// suggest: measured on production 2026-09-04, `document.referrer` is EMPTY
// after a Next client-side navigation from /library to /games/[id].
// history.length does increment, but browsers do not expose history entries to
// read, so nothing can name the place it would go back to. A `?from=` is the
// only mechanism that survives a reload, a shared link and a new tab, and the
// only one that can render the destination's NAME rather than just a Back
// button.

import type { Crumb } from '@/components/shell/breadcrumb';

export interface CollectionRef { id: string; name: string }

/**
 * Resolve an untrusted `?from=` against this org's OWN collections.
 *
 * Exactly the proof /library already performs on `?collection=`, and for the
 * same reason: `collection_games` carries no org_id (D-4-5), so an unchecked
 * id here would put another tenant's collection NAME on the page -- a
 * cross-tenant leak through a breadcrumb. An unknown or foreign id degrades to
 * "no collection", never a 404: a stale link should quietly show the library
 * rather than break.
 */
export function resolveFrom(
  from: string | undefined,
  collections: readonly CollectionRef[],
): CollectionRef | null {
  if (!from) return null;
  return collections.find((c) => c.id === from) ?? null;
}

/**
 * The library's grid or table, carried like the collection so the breadcrumb back keeps the view the person chose
 * with the toggle (library table final review M1, 2026-10-22). Null: not carried, the person's preference decides.
 */
export type TrailView = 'grid' | 'table' | null;

/** An untrusted `?view=` as a TrailView: grid or table, anything else is none. */
export function parseTrailView(raw: string | string[] | undefined): TrailView {
  return raw === 'grid' || raw === 'table' ? raw : null;
}

/** `?from=` (and `view=`) to append to a link, or '' when there is nothing to carry. */
export function fromQuery(collectionId: string | null | undefined, view: TrailView = null): string {
  const parts: string[] = [];
  if (collectionId) parts.push(`from=${encodeURIComponent(collectionId)}`);
  if (view) parts.push(`view=${view}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/**
 * The trail's leading crumbs: Library, then the collection when we know it.
 *
 * Library stays FIRST and stays a link even inside a collection. A collection
 * is a view of the library, not a replacement for it, and someone who filtered
 * their way in still wants the way out.
 */
export function libraryTrail(collection: CollectionRef | null, view: TrailView = null): Crumb[] {
  const crumbs: Crumb[] = [{ label: 'Library', href: libraryHref(null, view) }];
  if (collection) {
    crumbs.push({ label: collection.name, href: libraryHref(collection.id, view) });
  }
  return crumbs;
}

/**
 * Where "back to the library" goes, filtered to a collection when we know one.
 *
 * ONE place that knows the shape of that URL. `libraryTrail` renders it as a
 * crumb; DeleteDiskDialog navigates to it when the title you were looking at
 * stops existing. Those two must agree -- the destination of the redirect IS
 * the crumb the person can see -- and spelling the query string out twice is
 * how they would quietly stop agreeing.
 */
export function libraryHref(collectionId: string | null | undefined, view: TrailView = null): string {
  // `view` first, as the library's own toggle writes it (viewModeHref).
  const parts: string[] = [];
  if (view) parts.push(`view=${view}`);
  if (collectionId) parts.push(`collection=${encodeURIComponent(collectionId)}`);
  return parts.length ? `/library?${parts.join('&')}` : '/library';
}
