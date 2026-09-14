// Pure fold for the review queue and its badge count (R15, fix round 1):
// group suggestion rows by game, dedupe sources, drop what the game has
// already dismissed or already has an effective automatic link for, then
// sort single-candidate items first.
//
// No database import here on purpose. `listReviewQueue` and
// `countReviewQueue` (queries.ts) both fetch the same rows and the same
// per-game automatic/dismissed maps and hand them to this one function, so
// the two can never disagree about which games belong in the queue --
// review-fold.test.ts pins that behaviour without a connection.

import { effectiveLink } from './effective';
import type { SuggestionSource } from './match';

export interface QueueSuggestionRow {
  gameId: string; gameTitle: string; productionId: number; source: SuggestionSource;
}
export interface QueueEntry { productionId: number; sources: SuggestionSource[] }
export interface QueueGroup { gameId: string; gameTitle: string; entries: QueueEntry[] }

/**
 * `autoOf` / `dismissedOf` are the same per-game maps `effectiveLink`
 * consumes elsewhere in this module (linkInputs' output): automatic
 * production ids from the game's own disks, and productions this org's game
 * has dismissed. A game's own CONFIRMED link is not represented here --
 * the caller's row query already excludes any game with one (games with a
 * confirmed link have nothing left to review), so `effectiveLink` is called
 * with hardcoded null confirmed-link fields, matching only its
 * automatic-link branch.
 */
export function foldReviewQueue(
  rows: readonly QueueSuggestionRow[],
  autoOf: ReadonlyMap<string, number[]>,
  dismissedOf: ReadonlyMap<string, ReadonlySet<number>>,
): QueueGroup[] {
  const byGame = new Map<string, QueueGroup>();
  for (const r of rows) {
    const dismissed = dismissedOf.get(r.gameId) ?? new Set<number>();
    // This game has already said "not this" to this production: no longer a
    // suggestion, regardless of what else is unresolved for the game.
    if (dismissed.has(r.productionId)) continue;
    // This game's disks already agree on an (non-dismissed) automatic link:
    // nothing left to review for it at all.
    if (effectiveLink({ demozooProductionId: null, demozooLinkSource: null }, autoOf.get(r.gameId) ?? [], dismissed)) continue;

    const group = byGame.get(r.gameId) ?? { gameId: r.gameId, gameTitle: r.gameTitle, entries: [] };
    const existing = group.entries.find((e) => e.productionId === r.productionId);
    if (existing) { if (!existing.sources.includes(r.source)) existing.sources.push(r.source); }
    else group.entries.push({ productionId: r.productionId, sources: [r.source] });
    byGame.set(r.gameId, group);
  }

  // Production id tiebreaker within a queue item, so the suggestions list
  // doesn't depend on row arrival order.
  for (const g of byGame.values()) g.entries.sort((a, b) => a.productionId - b.productionId);

  // Single-candidate items first (fewest choices = quickest to clear), then
  // title, then game id -- a total order: two games sharing a title never
  // depend on row arrival order either.
  return [...byGame.values()].sort((a, b) =>
    (a.entries.length === 1 ? 0 : 1) - (b.entries.length === 1 ? 0 : 1)
    || a.gameTitle.localeCompare(b.gameTitle)
    || a.gameId.localeCompare(b.gameId));
}
