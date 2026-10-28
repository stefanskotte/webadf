// Library sharing (spec §4.1, Review Focus 2): a disk mounted from a remote library is held as a HIDDEN games/disks
// pair with remote_library_id set. It exists only so mount, send, write-back and history work; it never reaches a
// local view (library, Uncategorized, collections, search, counts, NFC lists, the Demozoo queue, next disk, disk
// sets, admin counts, the game and disk pages) and identification sweeps never touch it (they would retitle it or
// merge it into a same-named local title). Device and drive state still show it, named "<title> (remote)".
// The first Amiga write clears the columns (Task 7, D2), and from then on the row is an ordinary local disk.
import { and, eq, isNull, sql, type Column, type SQL } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks, games } from '@/db/schema/catalog';

/** What device/drive state appends to a hidden title's name. */
export const REMOTE_SUFFIX = ' (remote)';

/** The row is local (not a hidden remote stand-in). For `games`, `disks` or an alias of either. */
export function isLocal(t: { remoteLibraryId: Column }): SQL {
  return isNull(t.remoteLibraryId);
}

/** Raw-SQL form of `isLocal`, for hand-written subqueries over games or disks (`alias` is the table's name there). */
export function localSql(alias: string): SQL {
  return sql.raw(`${alias}.remote_library_id is null`);
}

/** The title as device state shows it: a hidden game's name gets " (remote)". Null stays null (no joined game). */
export function deviceTitle(g: { title: Column; remoteLibraryId: Column }): SQL<string | null> {
  return sql<string | null>`case when ${g.remoteLibraryId} is null then ${g.title} else ${g.title} || ${REMOTE_SUFFIX} end`;
}

/**
 * A game id device state may link to: null for a hidden game, whose page 404s by design, so no "Go to disk" link
 * leads there. `remoteLibraryId` is the joined game's; `id` may come from the disk row (disks.game_id).
 */
export function linkableGameId(id: Column, g: { remoteLibraryId: Column }): SQL<string | null> {
  return sql<string | null>`case when ${g.remoteLibraryId} is null then ${id} end`;
}

// ---- The one guard for local routes (Task 8, ruling R-6b).
// A local route that takes a disk or game id (edit, delete, download, files, cover, history, ...) answers a hidden id
// exactly as it answers an unknown one: 404 {error:'not_found'}. Device-facing routes (/api/device/*) never use this:
// the board must keep mounting, fetching and writing back a hidden disk it holds.

/** True when `diskId` names a hidden remote disk of this org. An unknown id is not hidden (the route 404s it itself). */
export async function isHiddenDisk(orgId: string, diskId: string): Promise<boolean> {
  const [r] = await getDb().select({ lib: disks.remoteLibraryId }).from(disks)
    .where(and(eq(disks.id, diskId), eq(disks.orgId, orgId))).limit(1);
  return r?.lib != null;
}

/** True when `gameId` names a hidden remote title of this org. */
export async function isHiddenGame(orgId: string, gameId: string): Promise<boolean> {
  const [r] = await getDb().select({ lib: games.remoteLibraryId }).from(games)
    .where(and(eq(games.id, gameId), eq(games.orgId, orgId))).limit(1);
  return r?.lib != null;
}

/** The 404 a local route gives a hidden id, or null to carry on. Same body as an unknown id (global constraints). */
export async function refuseHidden(orgId: string, ref: { diskId: string } | { gameId: string }): Promise<Response | null> {
  const hidden = 'diskId' in ref ? await isHiddenDisk(orgId, ref.diskId) : await isHiddenGame(orgId, ref.gameId);
  return hidden ? Response.json({ error: 'not_found' }, { status: 404 }) : null;
}
