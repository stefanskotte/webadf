// Reading and writing a title's own cover (games.cover_override_sha256).
//
// Every query is scoped by orgFilter on the games row: games are per-org rows,
// so an id from another tenant is "not found" here exactly as it is on the
// title page, and one org's choice can never reach another org's title.

import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { games } from '@/db/schema/catalog';
import { orgFilter } from '@/db/scope';

/** The title's override digest; undefined when the title is not this org's (or does not exist). */
export async function getCoverOverride(orgId: string, gameId: string): Promise<{ sha256: string | null } | undefined> {
  const rows = await getDb()
    .select({ sha256: games.coverOverrideSha256 })
    .from(games)
    .where(orgFilter(games, orgId, eq(games.id, gameId)))
    .limit(1);
  return rows[0];
}

/**
 * Sets (a digest) or clears (null, "Revert to default") the override.
 * Returns false when no title of this org has that id. Clearing never deletes
 * the stored object: another title may name the same bytes, and the weekly
 * blob GC reclaims it once nothing does.
 */
export async function setCoverOverride(orgId: string, gameId: string, sha256: string | null): Promise<boolean> {
  const rows = await getDb()
    .update(games)
    .set({ coverOverrideSha256: sha256 })
    .where(orgFilter(games, orgId, eq(games.id, gameId)))
    .returning({ id: games.id });
  return rows.length > 0;
}
