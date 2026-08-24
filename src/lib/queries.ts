import { sql, desc, eq, and } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks } from '@/db/schema/catalog';
import { orgFilter } from '@/db/scope';

export interface GameListItem {
  id: string; title: string; year: number | null; publisher: string | null;
  diskCount: number; coverAssetId: string | null;
  sizeBytes: number; sha256Prefix: string | null;
}

export async function listGames(orgId: string, opts: { limit?: number } = {}): Promise<GameListItem[]> {
  return getDb()
    .select({
      id: games.id, title: games.title, year: games.year, publisher: games.publisher,
      coverAssetId: games.coverAssetId,
      diskCount: sql<number>`count(${disks.id})::int`,
      sizeBytes: sql<number>`coalesce(sum(${disks.sizeBytes}), 0)::bigint`,
      sha256Prefix: sql<string | null>`min(${disks.sha256})`,
    })
    .from(games)
    // Scoped on both columns, not just gameId -- belt and braces alongside the
    // WHERE below. Nothing in the schema (no CHECK, no composite FK) currently
    // guarantees disks.org_id matches its game's org_id; only the write path
    // (/api/ingest/complete) keeps that true today. Scoping the join itself
    // means a future write path that got that wrong can never leak another
    // tenant's disk into this count or its sha256Prefix.
    .leftJoin(disks, and(eq(disks.gameId, games.id), eq(disks.orgId, orgId)))
    .where(orgFilter(games, orgId))
    .groupBy(games.id)
    .orderBy(desc(games.createdAt))     // recently added first (spec §10, D9)
    .limit(opts.limit ?? 200);
}
