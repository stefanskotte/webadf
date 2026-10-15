import { sql } from 'drizzle-orm';
import { getDb } from '@/db';

export interface LibraryUsage { titles: number; disks: number; versions: number; bytes: number }

/**
 * This org's library in one round trip (About page spec, "Your library").
 * bytes = the DISTINCT blobs the org's current disks and history versions
 * point at, joined to `blobs` for their size: a blob two disks share counts
 * once; a blob another org also holds counts in full here too (it is ours as
 * well). History DELTA blobs are not rows in `blobs` (disk-history/store.ts
 * inserts only snapshots), so they drop out of the join -- they are a few KB
 * each. Casts: count(*) and sum() come back as strings from neon-http
 * without them (see admin-queries.ts adminCounts).
 */
export async function libraryUsage(orgId: string): Promise<LibraryUsage> {
  const { rows } = await getDb().execute<{ titles: number; disks: number; versions: number; bytes: string }>(sql`
    select
      (select count(*)::int from games where org_id = ${orgId})          as titles,
      (select count(*)::int from disks where org_id = ${orgId})          as disks,
      (select count(*)::int from disk_versions where org_id = ${orgId})  as versions,
      (select coalesce(sum(b.size_bytes), 0)::bigint from blobs b
        where b.sha256 in (
          select sha256 from disks where org_id = ${orgId}
          union
          select blob_sha256 from disk_versions where org_id = ${orgId}
        ))                                                                as bytes
  `);
  const r = rows[0];
  return { titles: Number(r.titles), disks: Number(r.disks), versions: Number(r.versions), bytes: Number(r.bytes) };
}
