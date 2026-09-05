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

/** `?from=` to append to a link, or '' when there is nothing to carry. */
export function fromQuery(collectionId: string | null | undefined): string {
  return collectionId ? `?from=${encodeURIComponent(collectionId)}` : '';
}

/**
 * The trail's leading crumbs: Library, then the collection when we know it.
 *
 * Library stays FIRST and stays a link even inside a collection. A collection
 * is a view of the library, not a replacement for it, and someone who filtered
 * their way in still wants the way out.
 */
export function libraryTrail(collection: CollectionRef | null): Crumb[] {
  const crumbs: Crumb[] = [{ label: 'Library', href: '/library' }];
  if (collection) {
    crumbs.push({ label: collection.name, href: libraryHref(collection.id) });
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
export function libraryHref(collectionId: string | null | undefined): string {
  return collectionId
    ? `/library?collection=${encodeURIComponent(collectionId)}`
    : '/library';
}
