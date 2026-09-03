// Applies one OpenRetro entry to every tenant's game rows for a sha256.
//
// IDS ARE NEVER WRITTEN HERE. Not games.id, not disks.id, and never
// devices.desiredDiskId or mountedDiskId. See tosec-apply.ts's header for the
// full reasoning: a re-keyed disk makes readDesired's join return nothing, and
// "no disk desired" IS eject in this protocol.
//
// This file only ever UPDATEs metadata columns on games. It creates nothing,
// deletes nothing, and merges nothing -- unlike tosec-apply, an enrichment
// cannot change a game's identity, so there is no duplicate to collapse.

import { and, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { BatchItem } from 'drizzle-orm/batch';
import { getDb } from '@/db';
import { games, disks } from '@/db/schema/catalog';
import { openretroEntries } from '@/db/schema/openretro';
import { MACHINE_SOURCES } from '@/lib/tosec-apply';

/**
 * "This group is still the machines' to write."
 *
 * NULL means MACHINE-WRITABLE here, and that is the opposite of what it means
 * in metadataSource -- the one asymmetry in this rule, and it was measured
 * before it was written. metadata_source is set to 'filename' at ingest and is
 * never NULL, so a NULL there really does mean a human took the row. But
 * facts_source and prose_source are NULL on 7 of the 9 live games, where it
 * means "nothing has ever written this", not "a person owns it". A plain
 * `inArray(col, MACHINE_SOURCES)` would therefore have excluded every
 * never-enriched row -- silently stopping enrichment on the ~78% of the
 * archive that needs it most.
 */
function machineOwned(col: PgColumn): SQL {
  return or(isNull(col), inArray(col, MACHINE_SOURCES)) as SQL;
}

export async function applyEnrichment(sha256: string, entryUuid: string) {
  const db = getDb();
  const rows = await db.select().from(openretroEntries).where(eq(openretroEntries.uuid, entryUuid)).limit(1);
  const e = rows[0];
  if (!e) return { gamesUpdated: 0 };

  const affected = await db
    .select({ gameId: disks.gameId })
    .from(disks)
    .where(eq(disks.sha256, sha256));
  const gameIds = [...new Set(affected.map((a) => a.gameId))];
  if (gameIds.length === 0) return { gamesUpdated: 0 };

  // OpenRetro carries two prose fields; the long one is the fuller and is
  // what a game page wants. 1,706 of 3,697 entries have one or the other.
  const prose = e.longDescription ?? e.description;

  // THREE statements per game, not one, and the split is the whole point of
  // there being three source columns.
  //
  // This was a single UPDATE guarded on metadataSource alone until 2026-09-03.
  // That made the per-group columns decorative: a person fixing a typo in a
  // TITLE stamped metadataSource 'human' and thereby froze that game's facts
  // AND prose against every future enrichment, which is precisely what having
  // separate columns was supposed to prevent. Each group is now guarded by the
  // column that owns it.
  //
  // title/sortTitle/year remain unwritten here regardless: OpenRetro's
  // game_name carries decorations like "[AGA]" that would fight the canonical
  // TOSEC title, and metadataSource is never claimed, because overwriting it
  // with 'openretro' would lock TOSEC out of correcting the title again.
  const stmts: BatchItem<'pg'>[] = gameIds.flatMap((gameId) => [
    // publisher is IDENTITY, not facts, even though it arrives with the
    // facts: it is TOSEC's column first and a person correcting it means it.
    // Guarding it on metadataSource is what keeps a human's publisher from
    // being overwritten by an enrichment that is otherwise still welcome.
    db.update(games).set({ publisher: e.publisher }).where(and(
      eq(games.id, gameId),
      inArray(games.metadataSource, MACHINE_SOURCES),
    )),

    db.update(games).set({
      developer: e.developer, players: e.players,
      genre: e.tags, chipset: e.chipset, factsSource: 'openretro',
    }).where(and(
      eq(games.id, gameId),
      machineOwned(games.factsSource),
    )),

    ...(prose === null ? [] : [
      db.update(games).set({ description: prose, proseSource: 'openretro' }).where(and(
        eq(games.id, gameId),
        machineOwned(games.proseSource),
      )),
    ]),
  ]);

  await db.batch(stmts as [BatchItem<'pg'>, ...BatchItem<'pg'>[]]);
  return { gamesUpdated: gameIds.length };
}
