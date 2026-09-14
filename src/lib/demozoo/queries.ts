// Read models for the game page's Demozoo panel, the library grid's covers,
// the review queue and the title search that backs Link.
//
// D-5-5 (HANDOFF.md): disks.orgId can diverge from its game's org -- nothing
// in the schema prevents it, only the write path keeps it true today -- so
// every join to `disks` where an org is in scope carries eq(disks.orgId,
// orgId) alongside the gameId predicate, not gameId alone. That rule is
// already load-bearing in listGames, withDerived and search(); this file adds
// it at each new site that reaches disks with an org in scope.

import { and, asc, eq, ilike, inArray, isNotNull, isNull, like, or, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks, blobs, entitlements } from '@/db/schema/catalog';
import { demozooProductions, demozooImages, demozooSuggestions, demozooDismissals } from '@/db/schema/demozoo';
import type { CoverCandidate } from '@/lib/cover-pick';
import type { SuggestionSource } from './match';
import { effectiveLink, type LinkSource } from './effective';
import { titleKey } from './title-key';
import { foldReviewQueue, type QueueSuggestionRow, type QueueDisk } from './review-fold';

export const demozooUrl = (id: number) => `https://demozoo.org/productions/${id}/`;

export interface DemozooShot { sha1: string; url: string; ordinal: number }
export interface DemozooProductionView {
  id: number; title: string; releaseYear: number | null; types: string[]; groups: string[];
  url: string; screenshots: DemozooShot[];
}
export interface DemozooSuggestionView { production: DemozooProductionView; sources: SuggestionSource[] }
export interface GameDemozoo {
  link: { production: DemozooProductionView; source: LinkSource } | null;
  suggestions: DemozooSuggestionView[];
  /** A disk of this game is a TOSEC game: Demozoo is never offered (spec §5.3.1). */
  isGame: boolean;
}
/**
 * R18 (fix round 1, spec §8): the review queue additionally shows which of
 * this org's disks produced each suggestion -- the game detail page's
 * `DemozooSuggestionView` (above) has no such thing to show, since a game
 * there is looked at one disk-set at a time already. A separate type, not an
 * added optional field on `DemozooSuggestionView`, so `getGameDemozoo` keeps
 * building the plain shape without a dangling `disks: []`.
 */
export interface ReviewSuggestionView extends DemozooSuggestionView { disks: QueueDisk[] }
export interface ReviewItem { gameId: string; gameTitle: string; suggestions: ReviewSuggestionView[] }

async function loadProductions(ids: number[]): Promise<Map<number, DemozooProductionView>> {
  const out = new Map<number, DemozooProductionView>();
  if (ids.length === 0) return out;
  const db = getDb();
  const [prods, shots] = await Promise.all([
    db.select().from(demozooProductions).where(inArray(demozooProductions.id, ids)),
    db.select({ sha1: demozooImages.sha1, productionId: demozooImages.productionId, ordinal: demozooImages.ordinal })
      .from(demozooImages)
      .where(and(inArray(demozooImages.productionId, ids), isNotNull(demozooImages.storageKey)))
      .orderBy(asc(demozooImages.ordinal)),
  ]);
  for (const p of prods) {
    out.set(p.id, { id: p.id, title: p.title, releaseYear: p.releaseYear, types: p.types, groups: p.groups,
                    url: demozooUrl(p.id), screenshots: [] });
  }
  for (const s of shots) out.get(s.productionId)?.screenshots.push({ sha1: s.sha1, url: `/api/images/${s.sha1}`, ordinal: s.ordinal });
  return out;
}

/**
 * Automatic ids and dismissals per game, for effectiveLink. Scoped by the
 * caller's org-filtered game ids AND, here, by orgId directly on the disks
 * join (D-5-5): `disks.gameId` alone would let a disk that has drifted to
 * another org's orgId still contribute its blob's automatic link to this
 * org's game.
 */
async function linkInputs(orgId: string, gameIds: string[]) {
  const db = getDb();
  const [auto, dismissed] = await Promise.all([
    db.select({ gameId: disks.gameId, id: blobs.demozooProductionId }).from(disks)
      .innerJoin(blobs, eq(blobs.sha256, disks.sha256))
      .where(and(
        inArray(disks.gameId, gameIds),
        eq(disks.orgId, orgId),
        eq(blobs.demozooState, 'applied'),
        isNotNull(blobs.demozooProductionId),
      )),
    db.select({ gameId: demozooDismissals.gameId, id: demozooDismissals.productionId })
      .from(demozooDismissals).where(inArray(demozooDismissals.gameId, gameIds)),
  ]);
  const autoOf = new Map<string, number[]>();
  for (const a of auto) autoOf.set(a.gameId, [...(autoOf.get(a.gameId) ?? []), a.id!]);
  const dismissedOf = new Map<string, Set<number>>();
  for (const d of dismissed) dismissedOf.set(d.gameId, (dismissedOf.get(d.gameId) ?? new Set()).add(d.id));
  return { autoOf, dismissedOf };
}

export async function getGameDemozoo(
  orgId: string,
  game: { id: string; demozooProductionId: number | null; demozooLinkSource: string | null },
  shas: string[],
): Promise<GameDemozoo> {
  const { autoOf, dismissedOf } = await linkInputs(orgId, [game.id]);
  const dismissed = dismissedOf.get(game.id) ?? new Set<number>();
  const link = effectiveLink(game, autoOf.get(game.id) ?? [], dismissed);
  const isGame = shas.length > 0 && (await getDb().select({ sha256: blobs.sha256 }).from(blobs)
    .where(and(inArray(blobs.sha256, shas), eq(blobs.demozooState, 'skipped_game'))).limit(1)).length > 0;

  if (link) {
    const prods = await loadProductions([link.productionId]);
    const production = prods.get(link.productionId);
    // No FK from games/blobs to demozoo_productions (a weekly re-import
    // prunes stale rows): a linked production that no longer exists shows no
    // link at all, never a broken one.
    return { link: production ? { production, source: link.source } : null, suggestions: [], isGame };
  }
  if (shas.length === 0 || isGame) return { link: null, suggestions: [], isGame };

  const rows = await getDb().select({ id: demozooSuggestions.productionId, source: demozooSuggestions.source })
    .from(demozooSuggestions).where(inArray(demozooSuggestions.sha256, shas));
  const sourcesOf = new Map<number, SuggestionSource[]>();
  for (const r of rows) {
    if (dismissed.has(r.id)) continue;
    sourcesOf.set(r.id, [...new Set([...(sourcesOf.get(r.id) ?? []), r.source as SuggestionSource])]);
  }
  const prods = await loadProductions([...sourcesOf.keys()]);
  return {
    link: null,
    // Production id tiebreaker: sourcesOf's Map iterates in insertion order
    // (row arrival order), which is not a stable ordering on its own.
    suggestions: [...sourcesOf].flatMap(([id, sources]) => {
      const production = prods.get(id);
      return production ? [{ production, sources }] : [];
    }).sort((a, b) => a.production.id - b.production.id),
    isGame: false,
  };
}

/** Grid covers: the first stored screenshot of each game's effective production. */
export async function demozooCovers(orgId: string, gameIds: string[]): Promise<Map<string, CoverCandidate[]>> {
  const out = new Map<string, CoverCandidate[]>();
  if (gameIds.length === 0) return out;
  const db = getDb();
  const owned = await db.select({ id: games.id, demozooProductionId: games.demozooProductionId, demozooLinkSource: games.demozooLinkSource })
    .from(games).where(and(inArray(games.id, gameIds), eq(games.orgId, orgId)));
  const { autoOf, dismissedOf } = await linkInputs(orgId, owned.map((g) => g.id));
  const linkOf = new Map<string, number>();
  for (const g of owned) {
    const l = effectiveLink(g, autoOf.get(g.id) ?? [], dismissedOf.get(g.id) ?? new Set());
    if (l) linkOf.set(g.id, l.productionId);
  }
  const pids = [...new Set(linkOf.values())];
  if (pids.length === 0) return out;
  const imgs = await db.select({ sha1: demozooImages.sha1, productionId: demozooImages.productionId, ordinal: demozooImages.ordinal })
    .from(demozooImages).where(and(inArray(demozooImages.productionId, pids), isNotNull(demozooImages.storageKey)));
  for (const [gameId, pid] of linkOf) {
    const list = imgs.filter((i) => i.productionId === pid).map((i) => ({ sha1: i.sha1, kind: 'screenshot', ordinal: i.ordinal }));
    if (list.length) out.set(gameId, list);
  }
  return out;
}

/**
 * Every (game, suggested production) row a review queue could possibly show:
 * this org's games, excluding any with a CONFIRMED link (nothing left to
 * review) and, per spec §5.3.1, any game holding a disk TOSEC already
 * identified as a game (`demozoo_state = 'skipped_game'`) -- checked with a
 * NOT EXISTS scoped on BOTH disks.gameId and disks.orgId (D-5-5), same as
 * `linkInputs`' disks join.
 *
 * Per-suggestion dismissal and the automatic-link drop are NOT applied here:
 * both need `linkInputs`, and are left to `foldReviewQueue` so the exact same
 * predicate produces both `listReviewQueue` and `countReviewQueue` (R15) --
 * duplicating it per caller is exactly what would let them drift apart.
 */
async function reviewQueueRows(orgId: string): Promise<QueueSuggestionRow[]> {
  const rows = await getDb().select({
    gameId: games.id, gameTitle: games.title,
    productionId: demozooSuggestions.productionId, source: demozooSuggestions.source,
    // R18: which disk produced this suggestion, and this org's own filename
    // for it -- left-joined on (sha256, orgId), same predicate apply.ts uses
    // to re-derive a machine title, so a disk somehow missing its own
    // entitlement row shows a disk number with no filename rather than
    // dropping the suggestion.
    diskNo: disks.diskNo, filename: entitlements.sourceFilename,
  })
    .from(games)
    .innerJoin(disks, and(eq(disks.gameId, games.id), eq(disks.orgId, orgId)))
    .innerJoin(demozooSuggestions, eq(demozooSuggestions.sha256, disks.sha256))
    .leftJoin(entitlements, and(eq(entitlements.sha256, disks.sha256), eq(entitlements.orgId, orgId)))
    .where(and(
      eq(games.orgId, orgId),
      isNull(games.demozooLinkSource),
      sql`not exists (
        select 1 from disks d2
        inner join blobs b2 on b2.sha256 = d2.sha256
        where d2.game_id = ${games.id} and d2.org_id = ${orgId} and b2.demozoo_state = 'skipped_game'
      )`,
    ));
  return rows.map((r) => ({ ...r, source: r.source as SuggestionSource, filename: r.filename ?? null }));
}

/**
 * Games with an unresolved suggestion (no confirmed/automatic link, no
 * dismissal yet, no TOSEC-recognised disk), single-candidate items first --
 * those are the quickest to clear. Fixed at 5 queries regardless of the
 * queue's size: `reviewQueueRows`, `linkInputs`' two (auto + dismissed),
 * `loadProductions`' two (productions + screenshots) -- no per-row query
 * loop, since this runs on every /library page load for the Task 14 badge.
 */
export async function listReviewQueue(orgId: string): Promise<ReviewItem[]> {
  const rows = await reviewQueueRows(orgId);
  if (rows.length === 0) return [];

  const gameIds = [...new Set(rows.map((r) => r.gameId))];
  const { autoOf, dismissedOf } = await linkInputs(orgId, gameIds);
  const groups = foldReviewQueue(rows, autoOf, dismissedOf);
  if (groups.length === 0) return [];

  const prods = await loadProductions([...new Set(groups.flatMap((g) => g.entries.map((e) => e.productionId)))]);
  return groups.flatMap((g) => {
    const suggestions = g.entries.flatMap((e) => {
      const production = prods.get(e.productionId);
      return production ? [{ production, sources: e.sources, disks: e.disks }] : [];
    });
    return suggestions.length > 0 ? [{ gameId: g.gameId, gameTitle: g.gameTitle, suggestions }] : [];
  });
}

/**
 * The badge's count: how many games `listReviewQueue` would return, without
 * paying for `loadProductions`' two extra queries -- the badge shows a
 * number, not titles or screenshots. Shares `reviewQueueRows` and
 * `foldReviewQueue` with `listReviewQueue`, so the two can never disagree
 * about which games are in the queue (review-fold.test.ts pins the fold
 * itself). 3 queries total: `reviewQueueRows`, `linkInputs`' two.
 */
export async function countReviewQueue(orgId: string): Promise<number> {
  const rows = await reviewQueueRows(orgId);
  if (rows.length === 0) return 0;
  const gameIds = [...new Set(rows.map((r) => r.gameId))];
  const { autoOf, dismissedOf } = await linkInputs(orgId, gameIds);
  return foldReviewQueue(rows, autoOf, dismissedOf).length;
}

/**
 * Global (demozoo_productions carries no org): the title search Link offers
 * reaches the same public catalog for every tenant. Escaping matches
 * src/lib/search-query.ts's escapeLike -- backslash first, then % and _, so
 * an inserted backslash from an earlier step is never re-escaped by a later
 * one -- compared once here rather than imported, since this file only needs
 * ILIKE, not the normalize/likePattern wrapper search.ts uses.
 *
 * Ranked in SQL, like src/lib/search.ts's CASE, and total ahead of LIMIT 10:
 * an exact titleKey match, then a titleKey prefix, then everything else
 * (title-substring-only matches), then title, then id -- the trailing id is
 * not decoration, matching search.ts's own reasoning: a non-unique ORDER BY
 * paired with a LIMIT has already produced bugs in this codebase.
 */
export async function searchDemozoo(q: string): Promise<DemozooProductionView[]> {
  const trimmed = q.trim();
  if (trimmed.length < 2) return [];
  const escaped = trimmed.replace(/[\\%_]/g, (c) => `\\${c}`);
  const key = titleKey(trimmed);
  // No titleKey signal at all (e.g. the query is only punctuation): every row
  // ranks equally here and title/id alone decide the order.
  const rank = key
    ? sql`(case when ${demozooProductions.titleKey} = ${key} then 0
                when ${demozooProductions.titleKey} like ${`${key}%`} then 1
                else 2 end)`
    : sql`2`;
  const rows = await getDb().select({ id: demozooProductions.id }).from(demozooProductions)
    .where(and(
      eq(demozooProductions.supertype, 'production'),
      eq(demozooProductions.isGame, false),
      or(ilike(demozooProductions.title, `%${escaped}%`), ...(key ? [like(demozooProductions.titleKey, `${key}%`)] : [])),
    ))
    .orderBy(rank, asc(demozooProductions.title), asc(demozooProductions.id))
    .limit(10);
  const prods = await loadProductions(rows.map((r) => r.id));
  return rows.map((r) => prods.get(r.id)!).filter(Boolean);
}
