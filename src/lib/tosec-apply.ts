// Applies a TOSEC identity to every tenant's catalog rows for one sha256.
//
// IDS ARE NEVER RE-DERIVED. games.id feeds stableId('disk', gameId, sha256),
// so re-keying a game would re-key its disks -- and devices.desiredDiskId is
// plain text with no foreign key, joined by readDesired. A dangling
// desiredDiskId makes that join return nothing, and "no disk desired" is not
// an error in this protocol, it IS eject. Re-keying here would silently eject
// disks from real hardware, which disk-change spec section 1 rule 1 forbids.
//
// Duplicates are therefore resolved by CONTENT: two games in one org with the
// same (sortTitle, year) are the same game, and are merged.

import { and, eq, isNull, ne } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { getDb } from '@/db';
import { games, disks } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { tosecEntries } from '@/db/schema/tosec';

export interface ApplyResult { gamesUpdated: number; disksUpdated: number; gamesMerged: number }

export async function applyMatch(sha256: string, entryId: string): Promise<ApplyResult> {
  const db = getDb();

  const entryRows = await db.select().from(tosecEntries).where(eq(tosecEntries.id, entryId)).limit(1);
  const entry = entryRows[0];
  if (!entry) return { gamesUpdated: 0, disksUpdated: 0, gamesMerged: 0 };

  // Every disk holding these bytes, in every organization.
  const affected = await db
    .select({ diskId: disks.id, gameId: disks.gameId, orgId: disks.orgId })
    .from(disks)
    .where(eq(disks.sha256, sha256));
  if (affected.length === 0) return { gamesUpdated: 0, disksUpdated: 0, gamesMerged: 0 };

  const stmts: BatchItem<'pg'>[] = [];
  let disksUpdated = 0;
  let gamesUpdated = 0;
  let gamesMerged = 0;

  for (const row of affected) {
    // Disk level: the TOSEC rom name and disk number are authoritative.
    stmts.push(db.update(disks).set({
      tosecName: entry.romName,
      ...(entry.diskNo === null ? {} : { diskNo: entry.diskNo }),
    }).where(eq(disks.id, row.diskId)));
    disksUpdated++;

    // Game level: only over filename-derived metadata. A human edit is never
    // overwritten -- nothing writes such a value today, but the rule exists
    // before the first edit UI can forget it.
    stmts.push(db.update(games).set({
      title: entry.title, sortTitle: entry.sortTitle,
      year: entry.year, publisher: entry.publisher,
      metadataSource: 'tosec',
    }).where(and(eq(games.id, row.gameId), eq(games.metadataSource, 'filename'))));
    gamesUpdated++;
  }

  await db.batch(stmts as [BatchItem<'pg'>, ...BatchItem<'pg'>[]]);

  // Merge pass, per affected organization. Done AFTER the renames above, so
  // rows that have just become duplicates are visible as such.
  for (const orgId of [...new Set(affected.map((a) => a.orgId))]) {
    gamesMerged += await mergeDuplicates(orgId, entry.sortTitle, entry.year);
  }

  return { gamesUpdated, disksUpdated, gamesMerged };
}

/**
 * Collapse every games row in one org sharing (sortTitle, year) into one.
 *
 * The survivor keeps its id, so no disk moves keys -- only disks.gameId
 * changes. devices.desiredGameId / mountedGameId are repointed in the same
 * batch, because those columns have no foreign key and would otherwise dangle
 * once the absorbed row is deleted. desiredDiskId is deliberately NOT touched:
 * disks keep their ids, so no device's desired state moves and no sweep can
 * be observed as an eject.
 */
async function mergeDuplicates(orgId: string, sortTitle: string, year: number | null): Promise<number> {
  const db = getDb();

  const dupes = await db
    .select({ id: games.id, createdAt: games.createdAt })
    .from(games)
    .where(and(
      eq(games.orgId, orgId),
      eq(games.sortTitle, sortTitle),
      year === null ? isNull(games.year) : eq(games.year, year),
    ))
    .orderBy(games.createdAt);

  if (dupes.length < 2) return 0;

  const survivor = dupes[0].id;
  const absorbed = dupes.slice(1).map((d) => d.id);

  const stmts: BatchItem<'pg'>[] = [];
  for (const gone of absorbed) {
    stmts.push(db.update(disks).set({ gameId: survivor }).where(eq(disks.gameId, gone)));
    stmts.push(db.update(devices).set({ desiredGameId: survivor })
      .where(and(eq(devices.orgId, orgId), eq(devices.desiredGameId, gone))));
    stmts.push(db.update(devices).set({ mountedGameId: survivor })
      .where(and(eq(devices.orgId, orgId), eq(devices.mountedGameId, gone))));
    stmts.push(db.delete(games).where(and(eq(games.id, gone), ne(games.id, survivor))));
  }
  await db.batch(stmts as [BatchItem<'pg'>, ...BatchItem<'pg'>[]]);
  return absorbed.length;
}
