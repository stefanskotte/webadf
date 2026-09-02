// Everything the typeahead reads, and the only place tenancy is decided for it.
//
// A search endpoint is the widest read surface in this app: fired on every
// keystroke, free text, reaching four tables. Three rules keep it safe and
// only the first is obvious (spec section 3):
//
//  1. orgFilter() scopes every query and THROWS on an empty org id.
//  2. disks.orgId can diverge from its game's org -- nothing in the schema
//     prevents it -- so the disks join carries orgId as well as gameId. A join
//     on gameId alone would still return the right org's games, with another
//     tenant's disk counted in them. That is the failure that would be silent.
//  3. Global content-addressed tables are never matched first and joined back.
//     This file does not touch blobs, tosec_entries or openretro_images at all.
//
// collection_games has no org_id by design (D-4-5): membership is reachable
// only through a collection, which has one. The gameCount subquery below does
// query it -- correlated on collections.id, which has already passed through
// orgFilter(collections, orgId, ...) in the query above it -- so it is never
// keyed on a collection id that has not itself been through orgFilter. No
// cross-org row can be counted. listCollections (src/lib/collections.ts)
// scopes the same subquery the same way.

import { and, asc, eq, ilike, or, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks } from '@/db/schema/catalog';
import { collections } from '@/db/schema/collections';
import { orgFilter } from '@/db/scope';
import { likePattern } from '@/lib/search-query';

/** Enough to choose from, few enough that the panel never scrolls. */
export const TITLE_LIMIT = 8;
export const COLLECTION_LIMIT = 4;

export interface SearchTitle {
  id: string; title: string; year: number | null; publisher: string | null; diskCount: number;
}
export interface SearchCollectionHit { id: string; name: string; gameCount: number }
export interface SearchResults { titles: SearchTitle[]; collections: SearchCollectionHit[] }

// Frozen, and shared across every empty-query call in this warm lambda for
// the life of the process. Safe only because it is frozen two levels deep --
// an unfrozen shared object would let one future `results.titles.push(...)`
// corrupt every org's "no results" response. Freeze, don't allocate fresh:
// this is the common case, fired on every keystroke before the user has
// typed anything worth searching for.
const emptyTitles: SearchTitle[] = [];
const emptyCollectionHits: SearchCollectionHit[] = [];
export const EMPTY_RESULTS: SearchResults = Object.freeze({
  titles: Object.freeze(emptyTitles) as SearchTitle[],
  collections: Object.freeze(emptyCollectionHits) as SearchCollectionHit[],
});

export async function search(orgId: string, raw: string): Promise<SearchResults> {
  const pattern = likePattern(raw);
  // No pattern means nothing to search. Return without a round trip: '%%'
  // would match every row this caller owns, on every empty keystroke.
  if (pattern === null) return EMPTY_RESULTS;

  const db = getDb();

  const [titles, collectionHits] = await Promise.all([
    db
      .select({
        id: games.id,
        title: games.title,
        year: games.year,
        publisher: games.publisher,
        diskCount: sql<number>`count(${disks.id})::int`,
      })
      .from(games)
      // BOTH predicates, deliberately. disks.orgId is an independent column
      // and admin-delete.ts documents its drift from a game's org as real, so
      // eq(disks.gameId, games.id) alone would let another tenant's disk be
      // counted into this org's result. listGames and withDerived scope this
      // join the same way and for the same reason.
      .leftJoin(disks, and(eq(disks.gameId, games.id), eq(disks.orgId, orgId)))
      .where(orgFilter(games, orgId, or(
        ilike(games.title, pattern),
        ilike(games.publisher, pattern),
        ilike(games.genre, pattern),
        // Matched, but never advertised: description is written only for
        // blobs OpenRetro recognises -- 2 of 9 rows today. It costs nothing
        // here and improves on its own as enrichment lands.
        ilike(games.description, pattern),
      )))
      .groupBy(games.id)
      // Ranking lives in SQL, not in TypeScript, so the LIMIT can never
      // truncate away the very name-match that should have ranked first --
      // which is exactly what fetching N by sort_title and re-sorting in JS
      // would do. The trailing id is not decoration: a non-unique ORDER BY
      // with a LIMIT has already produced two bugs in this codebase.
      .orderBy(sql`(case when ${games.title} ilike ${pattern} then 0 else 1 end)`,
               asc(games.sortTitle), asc(games.id))
      .limit(TITLE_LIMIT),

    db
      .select({
        id: collections.id,
        name: collections.name,
        gameCount: sql<number>`(
          select count(*)::int from collection_games
          where collection_games.collection_id = ${collections.id}
        )`,
      })
      .from(collections)
      .where(orgFilter(collections, orgId, ilike(collections.name, pattern)))
      .orderBy(asc(collections.name), asc(collections.id))
      .limit(COLLECTION_LIMIT),
  ]);

  return { titles, collections: collectionHits };
}
