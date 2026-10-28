// Library sharing (spec §4.1, Review Focus 2): a disk mounted from a remote library is held as a HIDDEN games/disks
// pair with remote_library_id set. It exists only so mount, send, write-back and history work; it never reaches a
// local view (library, Uncategorized, collections, search, counts, NFC lists, the Demozoo queue, next disk, disk
// sets, admin counts, the game and disk pages) and identification sweeps never touch it (they would retitle it or
// merge it into a same-named local title). Device and drive state still show it, named "<title> (remote)".
// The first Amiga write clears the columns (Task 7, D2), and from then on the row is an ordinary local disk.
import { isNull, sql, type Column, type SQL } from 'drizzle-orm';

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
