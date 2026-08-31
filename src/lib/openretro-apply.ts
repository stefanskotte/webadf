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

import { and, eq, inArray } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { getDb } from '@/db';
import { games, disks } from '@/db/schema/catalog';
import { openretroEntries } from '@/db/schema/openretro';
import { MACHINE_SOURCES } from '@/lib/tosec-apply';

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

  const stmts: BatchItem<'pg'>[] = gameIds.map((gameId) =>
    // Facts only. title/sortTitle/year are TOSEC's to own -- OpenRetro's
    // game_name carries decorations like "[AGA]" that would fight the
    // canonical TOSEC title, so it is deliberately not written here.
    //
    // metadataSource is likewise NOT written: it records who owns the
    // IDENTITY of this row, which is still TOSEC's (or the filename's), and
    // overwriting it with 'openretro' would lock TOSEC out of ever
    // correcting the title again. factsSource/proseSource are separate
    // columns precisely so an enrichment can say what it wrote without
    // claiming the row.
    db.update(games).set({
      publisher: e.publisher, developer: e.developer, players: e.players,
      genre: e.tags, chipset: e.chipset, factsSource: 'openretro',
      ...(prose === null ? {} : { description: prose, proseSource: 'openretro' }),
    }).where(and(
      eq(games.id, gameId),
      // The authority rule: a human-edited row is never overwritten.
      inArray(games.metadataSource, MACHINE_SOURCES),
    )),
  );

  await db.batch(stmts as [BatchItem<'pg'>, ...BatchItem<'pg'>[]]);
  return { gamesUpdated: gameIds.length };
}
