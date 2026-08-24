import { sql, desc } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks } from '@/db/schema/catalog';
import { orgFilter } from '@/db/scope';

export interface GameListItem {
  id: string; title: string; year: number | null; publisher: string | null;
  diskCount: number; coverAssetId: string | null;
}

export async function listGames(orgId: string, opts: { limit?: number } = {}): Promise<GameListItem[]> {
  return getDb()
    .select({
      id: games.id, title: games.title, year: games.year, publisher: games.publisher,
      coverAssetId: games.coverAssetId,
      diskCount: sql<number>`count(${disks.id})::int`,
    })
    .from(games)
    .leftJoin(disks, sql`${disks.gameId} = ${games.id}`)
    .where(orgFilter(games, orgId))
    .groupBy(games.id)
    .orderBy(desc(games.createdAt))     // recently added first (spec §10, D9)
    .limit(opts.limit ?? 200);
}
