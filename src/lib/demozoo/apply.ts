import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks, blobs, entitlements } from '@/db/schema/catalog';
import { tosecEntries } from '@/db/schema/tosec';
import { demozooProductions, demozooDismissals } from '@/db/schema/demozoo';
import { MACHINE_SOURCES } from '@/lib/tosec-apply';
import { makeSortTitle } from '@/lib/tosec';
import { effectiveLink } from './effective';
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
 */
export async function applyAutomaticLink(sha256: string, productionId: number): Promise<number> {
  const db = getDb();
  const rows = await db.select({ id: games.id })
    .from(disks)
    .innerJoin(games, eq(games.id, disks.gameId))
    .leftJoin(demozooDismissals, and(eq(demozooDismissals.gameId, games.id), eq(demozooDismissals.productionId, productionId)))
    .where(and(eq(disks.sha256, sha256), isNull(games.demozooLinkSource), isNull(demozooDismissals.gameId)));
  return applyDemozooToGames(productionId, [...new Set(rows.map((r) => r.id))]);
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

/** Use this. Org-scoped: stored on this org's game only. false = not found. */
export async function confirmDemozoo(orgId: string, gameId: string, productionId: number): Promise<boolean> {
  const game = await orgGame(orgId, gameId);
  if (!game || !(await productionExists(productionId))) return false;
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
 * Unlink. A confirmation is cleared; an automatic link is hidden for this
 * org's game with a dismissal (the global link stays for other tenants).
 * Fields Demozoo wrote fall back to the next machine source.
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
  const link = effectiveLink(game,
    diskRows.filter((d) => d.state === 'applied' && d.auto !== null).map((d) => d.auto!),
    new Set(dismissedRows.map((d) => d.id)));
  if (!link) return true;

  if (link.source === 'confirmed') {
    await db.update(games).set({ demozooProductionId: null, demozooLinkSource: null })
      .where(and(eq(games.id, gameId), eq(games.orgId, orgId)));
  } else {
    await db.insert(demozooDismissals).values({ orgId, gameId, productionId: link.productionId }).onConflictDoNothing();
  }

  if (game.metadataSource !== 'demozoo') return true;   // a human edited it since: leave it
  const first = diskRows[0];
  const tosec = first?.tosecEntryId
    ? (await db.select({ title: tosecEntries.title, year: tosecEntries.year, publisher: tosecEntries.publisher })
        .from(tosecEntries).where(eq(tosecEntries.id, first.tosecEntryId)).limit(1))[0] ?? null
    : null;
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
