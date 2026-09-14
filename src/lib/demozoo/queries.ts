// Read models for the game page's Demozoo panel, the library grid's covers,
// the review queue and the title search that backs Link.
//
// D-5-5 (HANDOFF.md): disks.orgId can diverge from its game's org -- nothing
// in the schema prevents it, only the write path keeps it true today -- so
// every join to `disks` where an org is in scope carries eq(disks.orgId,
// orgId) alongside the gameId predicate, not gameId alone. That rule is
// already load-bearing in listGames, withDerived and search(); this file adds
// it at each new site that reaches disks with an org in scope.

import { and, asc, eq, ilike, inArray, isNotNull, isNull, like, or } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks, blobs } from '@/db/schema/catalog';
import { demozooProductions, demozooImages, demozooSuggestions, demozooDismissals } from '@/db/schema/demozoo';
import type { CoverCandidate } from '@/lib/cover-pick';
import type { SuggestionSource } from './match';
import { effectiveLink, type LinkSource } from './effective';
import { titleKey } from './title-key';

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
export interface ReviewItem { gameId: string; gameTitle: string; suggestions: DemozooSuggestionView[] }

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
    suggestions: [...sourcesOf].flatMap(([id, sources]) => {
      const production = prods.get(id);
      return production ? [{ production, sources }] : [];
    }),
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
 * Games with an unresolved suggestion (no confirmed/automatic link, no
 * dismissal yet), single-candidate items first -- those are the quickest to
 * clear. Fixed at 5 queries regardless of the queue's size: the main select,
 * linkInputs' two (auto + dismissed), loadProductions' two (productions +
 * screenshots) -- no per-row query loop, since this runs on every /library
 * page load for the Task 14 badge.
 */
export async function listReviewQueue(orgId: string): Promise<ReviewItem[]> {
  const db = getDb();
  const rows = await db.select({ gameId: games.id, gameTitle: games.title, productionId: demozooSuggestions.productionId, source: demozooSuggestions.source })
    .from(games)
    .innerJoin(disks, and(eq(disks.gameId, games.id), eq(disks.orgId, orgId)))
    .innerJoin(demozooSuggestions, eq(demozooSuggestions.sha256, disks.sha256))
    .leftJoin(demozooDismissals, and(eq(demozooDismissals.gameId, games.id), eq(demozooDismissals.productionId, demozooSuggestions.productionId)))
    .where(and(eq(games.orgId, orgId), isNull(games.demozooLinkSource), isNull(demozooDismissals.gameId)));
  if (rows.length === 0) return [];

  const gameIds = [...new Set(rows.map((r) => r.gameId))];
  const { autoOf, dismissedOf } = await linkInputs(orgId, gameIds);
  const prods = await loadProductions([...new Set(rows.map((r) => r.productionId))]);

  const byGame = new Map<string, ReviewItem>();
  for (const r of rows) {
    if (effectiveLink({ demozooProductionId: null, demozooLinkSource: null }, autoOf.get(r.gameId) ?? [], dismissedOf.get(r.gameId) ?? new Set())) continue;
    const production = prods.get(r.productionId);
    if (!production) continue;
    const item = byGame.get(r.gameId) ?? { gameId: r.gameId, gameTitle: r.gameTitle, suggestions: [] };
    const existing = item.suggestions.find((s) => s.production.id === r.productionId);
    if (existing) { if (!existing.sources.includes(r.source as SuggestionSource)) existing.sources.push(r.source as SuggestionSource); }
    else item.suggestions.push({ production, sources: [r.source as SuggestionSource] });
    byGame.set(r.gameId, item);
  }
  return [...byGame.values()].sort((a, b) =>
    (a.suggestions.length === 1 ? 0 : 1) - (b.suggestions.length === 1 ? 0 : 1) || a.gameTitle.localeCompare(b.gameTitle));
}

/**
 * Global (demozoo_productions carries no org): the title search Link offers
 * reaches the same public catalog for every tenant. Escaping matches
 * src/lib/search-query.ts's escapeLike -- backslash first, then % and _, so
 * an inserted backslash from an earlier step is never re-escaped by a later
 * one -- compared once here rather than imported, since this file only needs
 * ILIKE, not the normalize/likePattern wrapper search.ts uses.
 */
export async function searchDemozoo(q: string): Promise<DemozooProductionView[]> {
  const trimmed = q.trim();
  if (trimmed.length < 2) return [];
  const escaped = trimmed.replace(/[\\%_]/g, (c) => `\\${c}`);
  const key = titleKey(trimmed);
  const rows = await getDb().select({ id: demozooProductions.id }).from(demozooProductions)
    .where(and(
      eq(demozooProductions.supertype, 'production'),
      eq(demozooProductions.isGame, false),
      or(ilike(demozooProductions.title, `%${escaped}%`), ...(key ? [like(demozooProductions.titleKey, `${key}%`)] : [])),
    ))
    .orderBy(asc(demozooProductions.title))
    .limit(10);
  const prods = await loadProductions(rows.map((r) => r.id));
  return rows.map((r) => prods.get(r.id)!).filter(Boolean);
}
