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
import { atomic } from '@/db/atomic';
import { getDb } from '@/db';
import { games } from '@/db/schema/catalog';
import { collections, collectionGames } from '@/db/schema/collections';
import { orgFilter } from '@/db/scope';
import { planReorder, type ReorderResult } from '@/lib/collection-order';
import { coverUrlsForGames } from '@/lib/queries';
import { chooseMosaic, mosaicCandidates, MOSAIC_TILES } from '@/lib/collection-mosaic';
import { isLocal } from '@/lib/remote-hidden';

export interface CollectionListItem { id: string; name: string; sortKey: number; gameCount: number; diskCount: number }

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
      isLocal(games),
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
      // Hidden remote stand-ins (library sharing, spec §4.1) never count. They are never filed in a collection
      // (addGameToCollection refuses them), so the join to games is belt and braces.
      gameCount: sql<number>`(
        select count(*)::int from collection_games
        join games on games.id = collection_games.game_id and games.remote_library_id is null
        where collection_games.collection_id = collections.id
      )`,
      // The table's folder rows show it. The disks are org-scoped as well as
      // the collection: collection_games has no org_id (D-4-5), and a member
      // row pointing at another tenant's game must not count its disks here.
      // The outer columns are spelled out, not interpolated: drizzle renders a
      // one-table select's columns unqualified, and a bare "id" or "org_id"
      // inside this subquery would bind to disks' own.
      diskCount: sql<number>`(
        select count(*)::int from collection_games
        join disks on disks.game_id = collection_games.game_id and disks.org_id = collections.org_id
          and disks.remote_library_id is null
        where collection_games.collection_id = collections.id
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
/**
 * Every title of a collection, in its hand-made order: what dragging inside one PAGE of the collection reorders
 * (library paging, 2026-10-22). reorderCollectionGames takes the whole list, so a page must hand it the whole list,
 * not its own slice. Empty for a collection this org does not own.
 */
export async function listCollectionGameIds(orgId: string, id: string): Promise<string[]> {
  const rows = await getDb()
    .select({ gameId: collectionGames.gameId })
    .from(collectionGames)
    .innerJoin(collections, eq(collections.id, collectionGames.collectionId))
    .innerJoin(games, and(eq(games.id, collectionGames.gameId), isLocal(games)))
    .where(and(eq(collectionGames.collectionId, id), eq(collections.orgId, orgId)))
    .orderBy(collectionGames.sortKey, collectionGames.gameId);
  return rows.map((r) => r.gameId);
}

export async function countUncategorized(orgId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(games)
    .where(and(orgFilter(games, orgId), isLocal(games), sql`not exists (
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
  return { id, name, sortKey, gameCount: 0, diskCount: 0 };
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

  // A hidden remote stand-in (spec §4.1) is not a title of this library: never filed, same answer as unknown.
  const gameOwned = await db.select({ id: games.id }).from(games)
    .where(orgFilter(games, orgId, and(eq(games.id, gameId), isLocal(games)))).limit(1);
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

  await atomic((tx) => plan.assignments.map((a) =>
    tx.update(collections).set({ sortKey: a.sortKey })
      .where(orgFilter(collections, orgId, eq(collections.id, a.id))),
  ));
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

  await atomic((tx) => plan.assignments.map((a) =>
    tx.update(collectionGames).set({ sortKey: a.sortKey })
      .where(and(eq(collectionGames.collectionId, id), eq(collectionGames.gameId, a.id))),
  ));
  return plan;
}

/** What a bulk move did (spec 2026-10-26 library multi-select §3.2). */
export interface MoveResult { added: number; alreadyThere: number; removedFrom: number; missing: string[] }

/**
 * Library multi-select's Move to collection (spec §3.2, Rulings 11, 15, 18): every owned title in `ids` goes into
 * `to`, and inside a collection (`from`) leaves that one. The single move's own meaning, made plural: from All titles
 * or Uncategorized it only adds, and a title is never taken out of its other collections.
 *
 * Null when `to` or `from` is not this org's collection (the route's 404), with nothing written. An id this org does
 * not own -- absent or another tenant's, indistinguishable on purpose -- is reported in `missing` and never written.
 *
 * All or nothing in ONE transaction. getDb().transaction directly (what atomic() wraps): the new sort keys come from a
 * max(sort_key) read inside the same transaction, after the target's existing members (Plan ruling). A title already
 * in `to` is a quiet no-op (the composite PK, ON CONFLICT DO NOTHING), so running it twice gives the same end state.
 */
export async function moveGamesToCollection(
  orgId: string, ids: string[], to: string, from?: string,
): Promise<MoveResult | null> {
  const db = getDb();
  const wanted = from === undefined ? [to] : [to, from];
  const owned = await db.select({ id: collections.id }).from(collections)
    .where(orgFilter(collections, orgId, inArray(collections.id, wanted)));
  const have = new Set(owned.map((c) => c.id));
  if (!have.has(to) || (from !== undefined && !have.has(from))) return null;

  const mine = new Set((await db.select({ id: games.id }).from(games)
    .where(orgFilter(games, orgId, and(inArray(games.id, ids), isLocal(games))))).map((g) => g.id));
  const ownedIds = ids.filter((id) => mine.has(id));
  const missing = ids.filter((id) => !mine.has(id));
  if (ownedIds.length === 0) return { added: 0, alreadyThere: 0, removedFrom: 0, missing };

  return db.transaction(async (tx) => {
    const [{ maxSort }] = await tx
      .select({ maxSort: sql<number>`coalesce(max(${collectionGames.sortKey}), -1)::int` })
      .from(collectionGames)
      .where(eq(collectionGames.collectionId, to));
    const added = await tx.insert(collectionGames)
      .values(ownedIds.map((gameId, i) => ({ collectionId: to, gameId, sortKey: maxSort + 1 + i })))
      .onConflictDoNothing()
      .returning({ gameId: collectionGames.gameId });
    let removedFrom = 0;
    if (from !== undefined) {
      const gone = await tx.delete(collectionGames)
        .where(and(eq(collectionGames.collectionId, from), inArray(collectionGames.gameId, ownedIds)))
        .returning({ gameId: collectionGames.gameId });
      removedFrom = gone.length;
    }
    return { added: added.length, alreadyThere: ownedIds.length - added.length, removedFrom, missing };
  });
}

/**
 * The first of this org's collections (in the Library's collection order: sortKey, then id, as listCollections) the
 * title is filed in, or null (Files 2 §3.1): where "Files…" opens the title's disk. Scoped through `collections`, since
 * collection_games carries no org_id (D-4-5).
 */
export async function firstCollectionOf(orgId: string, gameId: string): Promise<string | null> {
  const [row] = await getDb().select({ id: collections.id }).from(collectionGames)
    .innerJoin(collections, and(eq(collections.id, collectionGames.collectionId), eq(collections.orgId, orgId)))
    .where(eq(collectionGames.gameId, gameId))
    .orderBy(collections.sortKey, collections.id).limit(1);
  return row?.id ?? null;
}
