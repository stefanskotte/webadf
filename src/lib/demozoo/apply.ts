import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks, blobs, entitlements } from '@/db/schema/catalog';
import { tosecEntries } from '@/db/schema/tosec';
import { demozooProductions, demozooDismissals } from '@/db/schema/demozoo';
import { MACHINE_SOURCES } from '@/lib/tosec-apply';
import { makeSortTitle } from '@/lib/tosec';
import { productionToDismissAfterClear, agreesOnAutomaticLink } from './effective';
import { rederiveMachineTitle } from './rederive';

/**
 * Write a production's title, year and publisher onto games -- ONLY where a
 * machine owns those values (metadata_source in MACHINE_SOURCES). A human edit
 * is never overwritten. Demozoo's first group stands in for the publisher.
 */
export async function applyDemozooToGames(productionId: number, gameIds: string[]): Promise<number> {
  if (gameIds.length === 0) return 0;
  const db = getDb();
  const p = (await db.select().from(demozooProductions).where(eq(demozooProductions.id, productionId)).limit(1))[0];
  if (!p) return 0;
  const res = await db.update(games).set({
    title: p.title,
    sortTitle: makeSortTitle(p.title),
    year: p.releaseYear ?? sql`${games.year}`,
    publisher: p.groups[0] ?? sql`${games.publisher}`,
    metadataSource: 'demozoo',
  }).where(and(inArray(games.id, gameIds), inArray(games.metadataSource, MACHINE_SOURCES)))
    .returning({ id: games.id });
  return res.length;
}

/**
 * The sweep's automatic link, GLOBAL: every game in every org holding these
 * bytes, except games that confirmed a production themselves or dismissed
 * this one.
 *
 * R11: a game can hold several disks, and this function is triggered by ONE
 * blob becoming 'applied' -- it must not write a title on the strength of
 * that one disk alone if another of the game's disks disagrees (applied to
 * a DIFFERENT production). effectiveLink shows nothing for a disagreement,
 * so a title written here would be stale the instant it landed, and with no
 * automatic path back to fix it (only Unlink re-derives). Checked via
 * agreesOnAutomaticLink against every disk the candidate game holds, not
 * just the one that matched `sha256`.
 */
export async function applyAutomaticLink(sha256: string, productionId: number): Promise<number> {
  const db = getDb();
  const rows = await db.select({ id: games.id })
    .from(disks)
    .innerJoin(games, eq(games.id, disks.gameId))
    .leftJoin(demozooDismissals, and(eq(demozooDismissals.gameId, games.id), eq(demozooDismissals.productionId, productionId)))
    .where(and(eq(disks.sha256, sha256), isNull(games.demozooLinkSource), isNull(demozooDismissals.gameId)));
  const candidateIds = [...new Set(rows.map((r) => r.id))];
  if (candidateIds.length === 0) return 0;

  const appliedRows = await db.select({ gameId: disks.gameId, id: blobs.demozooProductionId })
    .from(disks).innerJoin(blobs, eq(blobs.sha256, disks.sha256))
    .where(and(inArray(disks.gameId, candidateIds), eq(blobs.demozooState, 'applied')));
  const appliedByGame = new Map<string, number[]>();
  for (const row of appliedRows) {
    if (row.id === null) continue;
    const list = appliedByGame.get(row.gameId);
    if (list) list.push(row.id); else appliedByGame.set(row.gameId, [row.id]);
  }

  const dismissedRows = await db.select({ gameId: demozooDismissals.gameId, id: demozooDismissals.productionId })
    .from(demozooDismissals).where(inArray(demozooDismissals.gameId, candidateIds));
  const dismissedByGame = new Map<string, Set<number>>();
  for (const row of dismissedRows) {
    const set = dismissedByGame.get(row.gameId);
    if (set) set.add(row.id); else dismissedByGame.set(row.gameId, new Set([row.id]));
  }

  const agreeing = candidateIds.filter((gameId) => agreesOnAutomaticLink(
    appliedByGame.get(gameId) ?? [], dismissedByGame.get(gameId) ?? new Set(), productionId,
  ));
  return applyDemozooToGames(productionId, agreeing);
}

async function orgGame(orgId: string, gameId: string) {
  const rows = await getDb().select({
    id: games.id, title: games.title, metadataSource: games.metadataSource,
    demozooProductionId: games.demozooProductionId, demozooLinkSource: games.demozooLinkSource,
  }).from(games).where(and(eq(games.id, gameId), eq(games.orgId, orgId))).limit(1);
  return rows[0] ?? null;
}

async function productionExists(productionId: number): Promise<boolean> {
  const rows = await getDb().select({ id: demozooProductions.id }).from(demozooProductions)
    .where(eq(demozooProductions.id, productionId)).limit(1);
  return rows.length > 0;
}

/**
 * R15 (fix round 1), defence in depth: spec §5.3.1, a TOSEC-recognised game
 * never gets a Demozoo link. The game page never offers Link/Accept for one
 * (listReviewQueue/getGameDemozoo already exclude it), but nothing stops a
 * crafted POST straight at the confirm/accept route from naming its id, so
 * this check has to hold here too, org-scoped like every other disks join
 * (D-5-5).
 */
async function hasSkippedGameDisk(orgId: string, gameId: string): Promise<boolean> {
  const rows = await getDb().select({ sha256: disks.sha256 }).from(disks)
    .innerJoin(blobs, eq(blobs.sha256, disks.sha256))
    .where(and(eq(disks.gameId, gameId), eq(disks.orgId, orgId), eq(blobs.demozooState, 'skipped_game')))
    .limit(1);
  return rows.length > 0;
}

/** Use this. Org-scoped: stored on this org's game only. false = not found. */
export async function confirmDemozoo(orgId: string, gameId: string, productionId: number): Promise<boolean> {
  const game = await orgGame(orgId, gameId);
  if (!game || (await hasSkippedGameDisk(orgId, gameId)) || !(await productionExists(productionId))) return false;
  const db = getDb();
  await db.update(games).set({ demozooProductionId: productionId, demozooLinkSource: 'confirmed' })
    .where(and(eq(games.id, gameId), eq(games.orgId, orgId)));
  await db.delete(demozooDismissals)
    .where(and(eq(demozooDismissals.gameId, gameId), eq(demozooDismissals.productionId, productionId)));
  await applyDemozooToGames(productionId, [gameId]);
  return true;
}

/** Not this. Remembered per org's game. */
export async function dismissDemozoo(orgId: string, gameId: string, productionId: number): Promise<boolean> {
  const game = await orgGame(orgId, gameId);
  if (!game || !(await productionExists(productionId))) return false;
  await getDb().insert(demozooDismissals).values({ orgId, gameId, productionId }).onConflictDoNothing();
  return true;
}

/**
 * Unlink: this game shows no Demozoo link and no Demozoo-written title,
 * afterwards, unconditionally (R11).
 *
 * (i) A confirmation, if any, is cleared. (ii) With the confirmation gone,
 * whatever automatic link would now show (disks agree, and it isn't already
 * dismissed) gets dismissed too, for this org's game only -- the global
 * automatic link stays for other tenants. (iii) If Demozoo owns the title,
 * it is re-derived to the next machine source.
 *
 * (iii) NEVER returns early ahead of (i)/(ii): two disks that disagree on
 * the automatic link make effectiveLink return null even though the game's
 * title still reads metadataSource: 'demozoo' (a race between this game
 * acquiring a second disk and the sweep -- see agreesOnAutomaticLink); an
 * early return here used to leave that title permanently stuck, because
 * nothing else in this system ever revisits it. The same ordering also
 * makes a retry after a partial failure (say, (i)/(ii) committed but a
 * crash lost (iii)) safe: clearing an already-cleared confirmation and
 * dismissing an already-dismissed production are both no-ops.
 */
export async function unlinkDemozoo(orgId: string, gameId: string): Promise<boolean> {
  const game = await orgGame(orgId, gameId);
  if (!game) return false;
  const db = getDb();

  const diskRows = await db.select({ sha256: disks.sha256, diskNo: disks.diskNo, auto: blobs.demozooProductionId,
                                     state: blobs.demozooState, tosecEntryId: blobs.tosecEntryId })
    .from(disks).innerJoin(blobs, eq(blobs.sha256, disks.sha256))
    .where(and(eq(disks.gameId, gameId), eq(disks.orgId, orgId)))
    .orderBy(disks.diskNo);
  const dismissedRows = await db.select({ id: demozooDismissals.productionId }).from(demozooDismissals)
    .where(eq(demozooDismissals.gameId, gameId));
  const automaticIds = diskRows.filter((d) => d.state === 'applied' && d.auto !== null).map((d) => d.auto!);
  const dismissed = new Set(dismissedRows.map((d) => d.id));

  if (game.demozooLinkSource === 'confirmed') {
    await db.update(games).set({ demozooProductionId: null, demozooLinkSource: null })
      .where(and(eq(games.id, gameId), eq(games.orgId, orgId)));
  }

  const toDismiss = productionToDismissAfterClear(automaticIds, dismissed);
  if (toDismiss !== null) {
    await db.insert(demozooDismissals).values({ orgId, gameId, productionId: toDismiss }).onConflictDoNothing();
  }

  if (game.metadataSource !== 'demozoo') return true;   // a human edited it since: leave it
  // Lowest-diskNo disk that actually HAS a TOSEC identity for the TOSEC
  // branch (diskRows is already ordered by diskNo, so `.find` keeps that
  // order); the filename branch stays on the lowest-diskNo disk regardless.
  const firstWithTosec = diskRows.find((d) => d.tosecEntryId !== null) ?? null;
  const tosec = firstWithTosec?.tosecEntryId
    ? (await db.select({ title: tosecEntries.title, year: tosecEntries.year, publisher: tosecEntries.publisher })
        .from(tosecEntries).where(eq(tosecEntries.id, firstWithTosec.tosecEntryId)).limit(1))[0] ?? null
    : null;
  const first = diskRows[0];
  const filename = first
    ? (await db.select({ f: entitlements.sourceFilename }).from(entitlements)
        .where(and(eq(entitlements.sha256, first.sha256), eq(entitlements.orgId, orgId))).limit(1))[0]?.f ?? null
    : null;
  const next = rederiveMachineTitle({ tosec, filename, fallbackTitle: game.title });
  await db.update(games).set(next)
    .where(and(eq(games.id, gameId), eq(games.orgId, orgId), eq(games.metadataSource, 'demozoo')));
  return true;
}

/** Review queue: Accept selected. Each item goes through confirmDemozoo, so every guard holds. */
export async function acceptSuggestions(orgId: string, items: Array<{ gameId: string; productionId: number }>): Promise<number> {
  let accepted = 0;
  for (const it of items) if (await confirmDemozoo(orgId, it.gameId, it.productionId)) accepted++;
  return accepted;
}
