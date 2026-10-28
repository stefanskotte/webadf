import { and, asc, eq, exists, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { collections, collectionGames } from '@/db/schema/collections';
import { games, disks } from '@/db/schema/catalog';
import { libraryShareCollections } from '@/db/schema/sharing';
import type { ShareAuth } from './store';

/** Collections the share exposes: every org collection when `everything`, else the share's rows (own org only). */
export async function scopedCollectionIds(auth: ShareAuth): Promise<string[]> {
  const db = getDb();
  if (auth.everything) {
    const rows = await db.select({ id: collections.id }).from(collections).where(eq(collections.orgId, auth.orgId))
      .orderBy(asc(collections.sortKey), asc(collections.name));
    return rows.map((r) => r.id);
  }
  const rows = await db.select({ id: collections.id }).from(libraryShareCollections)
    .innerJoin(collections, eq(collections.id, libraryShareCollections.collectionId))
    .where(and(eq(libraryShareCollections.shareId, auth.shareId), eq(collections.orgId, auth.orgId)))
    .orderBy(asc(collections.sortKey), asc(collections.name));
  return rows.map((r) => r.id);
}

/** The scope test (a WHERE over `games`), evaluated at the moment of the request: own org, never a hidden remote copy, and shared. */
export function gameInScope(auth: ShareAuth) {
  const base = and(eq(games.orgId, auth.orgId), isNull(games.remoteLibraryId));
  if (auth.everything) return base;
  return and(base, exists(
    getDb().select({ one: sql`1` }).from(collectionGames)
      .innerJoin(libraryShareCollections, eq(libraryShareCollections.collectionId, collectionGames.collectionId))
      .where(and(eq(libraryShareCollections.shareId, auth.shareId), eq(collectionGames.gameId, games.id))),
  ));
}

export async function titleInScope(auth: ShareAuth, gameId: string): Promise<boolean> {
  const rows = await getDb().select({ id: games.id }).from(games)
    .where(and(eq(games.id, gameId), gameInScope(auth))).limit(1);
  return rows.length > 0;
}

export async function diskInScope(
  auth: ShareAuth, diskId: string,
): Promise<{ sha256: string; sizeBytes: number; gameId: string } | null> {
  const rows = await getDb().select({ sha256: disks.sha256, sizeBytes: disks.sizeBytes, gameId: disks.gameId })
    .from(disks).innerJoin(games, eq(games.id, disks.gameId))
    .where(and(eq(disks.id, diskId), eq(disks.orgId, auth.orgId), isNull(disks.remoteLibraryId), gameInScope(auth)))
    .limit(1);
  return rows[0] ?? null;
}
