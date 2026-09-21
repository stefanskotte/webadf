// Every read and write for user-defined collections.
//
// A collection is per-tenant (src/db/schema/collections.ts), and every
// function below resolves the collection through orgFilter() BEFORE touching
// collection_games -- which carries no org_id of its own by design (D-4-5).
// A membership write must never be reachable by collection id alone.
//
// `false` (or, for the two reorder functions, `null`) means "not this org's
// collection", never a thrown error: every route turns that into 404 without
// distinguishing "absent" from "someone else's" (src/db/scope.ts's own
// comment on orgFilter makes the same point about an empty org id).

import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { getDb } from '@/db';
import { games } from '@/db/schema/catalog';
import { collections, collectionGames } from '@/db/schema/collections';
import { orgFilter } from '@/db/scope';
import { planReorder, type ReorderResult } from '@/lib/collection-order';
import { coverUrlsForGames } from '@/lib/queries';
import { chooseMosaic, mosaicCandidates, MOSAIC_TILES } from '@/lib/collection-mosaic';

export interface CollectionListItem { id: string; name: string; sortKey: number; gameCount: number }

/**
 * Up to four cover URLs for each of `collectionIds`, in the collection's own
 * membership order -- what its card tiles as a preview of what is inside it.
 *
 * The CHOOSING lives in `collection-mosaic.ts` and is tested without a
 * database; this function is the query that feeds it.
 *
 * Collections with nothing to show are ABSENT from the map rather than
 * present-and-empty: the card renders its gradient then, and "no covers" and
 * "no games" are meant to look the same.
 *
 * SCOPE: `collection_games` carries no org_id of its own (D-4-5), so both
 * sides are joined and BOTH are org-scoped -- the collection and the game.
 * Neither predicate is redundant: the caller proves the collection ids, and
 * the game side stops a membership row pointing at another tenant's game (the
 * table has no foreign key that would prevent one) from putting that tenant's
 * cover art on this page. `listDevices` carries the same predicate for the
 * same reason, and there is a live production case behind it.
 *
 * Cost: two queries whatever the number of collections, never one per card.
 * `mosaicCandidates` is what bounds the second one.
 */
export async function collectionMosaics(
  orgId: string, collectionIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (collectionIds.length === 0) return out;

  const rows = await getDb()
    .select({ collectionId: collectionGames.collectionId, gameId: collectionGames.gameId })
    .from(collectionGames)
    .innerJoin(collections, and(
      eq(collections.id, collectionGames.collectionId),
      eq(collections.orgId, orgId),
    ))
    .innerJoin(games, and(
      eq(games.id, collectionGames.gameId),
      eq(games.orgId, orgId),
    ))
    .where(inArray(collectionGames.collectionId, collectionIds))
    // The grid's own order (collection-order.ts), so the mosaic previews the
    // titles a person sees FIRST when they open the collection. Tie-broken by
    // game id for the same reason listCollections orders by (sortKey, id):
    // sortKey is not unique, and a non-total order reshuffles between renders.
    .orderBy(collectionGames.sortKey, collectionGames.gameId);

  const candidates = mosaicCandidates(rows);
  const coverUrls = await coverUrlsForGames(orgId, [...new Set([...candidates.values()].flat())]);

  for (const [collectionId, gameIds] of candidates) {
    const urls = chooseMosaic(gameIds, (id) => coverUrls.get(id), MOSAIC_TILES);
    if (urls.length > 0) out.set(collectionId, urls);
  }
  return out;
}

/**
 * A tenant's collections with their member counts.
 *
 * Ordered by (sortKey, id), never sortKey alone: sortKey is not unique --
 * every new collection can share one with another (createCollection assigns
 * the next one, but nothing stops two from being created in the same
 * millisecond before either write lands) -- and admin-queries.ts's
 * adminListUsers documents this exact bug class: a non-unique ORDER BY paired
 * with pagination or a first-row pick reshuffles between renders. id, as the
 * primary key, makes the order total.
 */
export async function listCollections(orgId: string): Promise<CollectionListItem[]> {
  const db = getDb();
  return db
    .select({
      id: collections.id,
      name: collections.name,
      sortKey: collections.sortKey,
      gameCount: sql<number>`(
        select count(*)::int from collection_games
        where collection_games.collection_id = ${collections.id}
      )`,
    })
    .from(collections)
    .where(orgFilter(collections, orgId))
    .orderBy(collections.sortKey, collections.id);
}

/**
 * How many titles are in no collection at all.
 *
 * Its own query rather than a number derived on the page, because the rail
 * shows it next to every other collection's count and the two have to be
 * counted the same way -- from the database, at the same moment. Scoped
 * through `collections`, since collection_games carries no org_id: a title
 * filed in another tenant's collection is uncategorized HERE.
 */
export async function countUncategorized(orgId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(games)
    .where(and(orgFilter(games, orgId), sql`not exists (
      select 1 from collection_games cg
      join collections co on co.id = cg.collection_id
      where cg.game_id = ${games.id} and co.org_id = ${orgId}
    )`));
  return row?.n ?? 0;
}

/** Lands at the end of this org's list: sortKey is max(sortKey) + 1, or 0 for the first collection. */
export async function createCollection(orgId: string, name: string): Promise<CollectionListItem> {
  const db = getDb();
  const [{ maxSort }] = await db
    .select({ maxSort: sql<number>`coalesce(max(${collections.sortKey}), -1)::int` })
    .from(collections)
    .where(orgFilter(collections, orgId));

  const id = randomUUID();
  const sortKey = maxSort + 1;
  await db.insert(collections).values({ id, orgId, name, sortKey });
  return { id, name, sortKey, gameCount: 0 };
}

export async function renameCollection(orgId: string, id: string, name: string): Promise<boolean> {
  const db = getDb();
  const owned = await db.select({ id: collections.id }).from(collections)
    .where(orgFilter(collections, orgId, eq(collections.id, id))).limit(1);
  if (owned.length === 0) return false;

  await db.update(collections).set({ name }).where(eq(collections.id, id));
  return true;
}

/** collection_games cascades via ON DELETE CASCADE (src/db/schema/collections.ts) -- no separate cleanup needed. */
export async function deleteCollection(orgId: string, id: string): Promise<boolean> {
  const db = getDb();
  const owned = await db.select({ id: collections.id }).from(collections)
    .where(orgFilter(collections, orgId, eq(collections.id, id))).limit(1);
  if (owned.length === 0) return false;

  await db.delete(collections).where(eq(collections.id, id));
  return true;
}

/**
 * Re-adding a game already in the collection is a NO-OP, not an error: a
 * person dragging a card they already filed should see nothing happen, not a
 * failure. `.onConflictDoNothing()` relies on collection_games' composite
 * primary key (collectionId, gameId).
 *
 * The game must belong to the SAME org as the collection -- checked
 * separately via orgFilter(games, ...), because collection_games itself has
 * no org_id to enforce that at the database level.
 */
export async function addGameToCollection(orgId: string, id: string, gameId: string): Promise<boolean> {
  const db = getDb();
  const owned = await db.select({ id: collections.id }).from(collections)
    .where(orgFilter(collections, orgId, eq(collections.id, id))).limit(1);
  if (owned.length === 0) return false;

  const gameOwned = await db.select({ id: games.id }).from(games)
    .where(orgFilter(games, orgId, eq(games.id, gameId))).limit(1);
  if (gameOwned.length === 0) return false;

  const [{ maxSort }] = await db
    .select({ maxSort: sql<number>`coalesce(max(${collectionGames.sortKey}), -1)::int` })
    .from(collectionGames)
    .where(eq(collectionGames.collectionId, id));

  await db.insert(collectionGames)
    .values({ collectionId: id, gameId, sortKey: maxSort + 1 })
    .onConflictDoNothing();
  return true;
}

/** Removing a game that is not (or no longer) a member is also a no-op: the delete simply matches zero rows. */
export async function removeGameFromCollection(orgId: string, id: string, gameId: string): Promise<boolean> {
  const db = getDb();
  const owned = await db.select({ id: collections.id }).from(collections)
    .where(orgFilter(collections, orgId, eq(collections.id, id))).limit(1);
  if (owned.length === 0) return false;

  await db.delete(collectionGames)
    .where(and(eq(collectionGames.collectionId, id), eq(collectionGames.gameId, gameId)));
  return true;
}

/** Reorders the org's own collection list. There is no single collection id to own here, so no null case. */
export async function reorderCollections(orgId: string, ids: string[]): Promise<ReorderResult> {
  const db = getDb();
  const current = await db.select({ id: collections.id }).from(collections)
    .where(orgFilter(collections, orgId));

  const plan = planReorder(current.map((c) => c.id), ids);
  if (!plan.ok) return plan;
  if (plan.assignments.length === 0) return plan;

  const stmts: BatchItem<'pg'>[] = plan.assignments.map((a) =>
    db.update(collections).set({ sortKey: a.sortKey })
      .where(orgFilter(collections, orgId, eq(collections.id, a.id))),
  );
  await db.batch(stmts as [BatchItem<'pg'>, ...BatchItem<'pg'>[]]);
  return plan;
}

/**
 * `null` and a `ReorderResult` error are NOT interchangeable: `null` means
 * "no such collection for this org", which the route turns into 404. A
 * `ReorderResult` error means the submitted list was bad relative to a
 * collection that DOES exist for this org -- a 400. Returning an error object
 * for a missing collection would confirm to another tenant that it exists.
 */
export async function reorderCollectionGames(
  orgId: string, id: string, ids: string[],
): Promise<ReorderResult | null> {
  const db = getDb();
  const owned = await db.select({ id: collections.id }).from(collections)
    .where(orgFilter(collections, orgId, eq(collections.id, id))).limit(1);
  if (owned.length === 0) return null;

  const current = await db.select({ gameId: collectionGames.gameId })
    .from(collectionGames).where(eq(collectionGames.collectionId, id));

  const plan = planReorder(current.map((c) => c.gameId), ids);
  if (!plan.ok) return plan;
  if (plan.assignments.length === 0) return plan;

  const stmts: BatchItem<'pg'>[] = plan.assignments.map((a) =>
    db.update(collectionGames).set({ sortKey: a.sortKey })
      .where(and(eq(collectionGames.collectionId, id), eq(collectionGames.gameId, a.id))),
  );
  await db.batch(stmts as [BatchItem<'pg'>, ...BatchItem<'pg'>[]]);
  return plan;
}
