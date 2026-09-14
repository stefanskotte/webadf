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

import {
  and, eq, inArray, isNull, ne, sql,
} from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { getDb } from '@/db';
import { games, disks } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { tosecEntries } from '@/db/schema/tosec';
import { collectionGames } from '@/db/schema/collections';
import { demozooDismissals } from '@/db/schema/demozoo';

// Sources this system writes for itself. Anything else means a human decided
// it, and a human's row is never deleted by a sweep -- the Authority rule
// applies to deletion as much as to retitling.
//
// Exported because openretro-apply.ts enforces the same rule and must not
// keep a second copy of this list: a source added to one and not the other
// would silently make half the system treat a machine row as human-edited.
export const MACHINE_SOURCES = ['filename', 'tosec', 'openretro', 'demozoo'];

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

    // Game level: only over machine-authored metadata. Gating on
    // MACHINE_SOURCES (not just 'filename') keeps a game re-correctable
    // after its first TOSEC match -- a row already at metadataSource:
    // 'tosec' is still machine-authored, and importDat()'s promise that a
    // newer release "corrects the entries it changed" would otherwise be
    // false for any row already matched once. Idempotent either way: a
    // repeat writes identical values. A human edit (any other value,
    // including NULL) is never overwritten -- nothing writes such a value
    // today, but the rule exists before the first edit UI can forget it.
    stmts.push(db.update(games).set({
      title: entry.title, sortTitle: entry.sortTitle,
      year: entry.year, publisher: entry.publisher,
      metadataSource: 'tosec',
    }).where(and(eq(games.id, row.gameId), inArray(games.metadataSource, MACHINE_SOURCES))));
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
 *
 * The Authority rule -- a human edit is never overwritten -- applies to
 * deletion by merge exactly as much as it applies to the retitling UPDATE in
 * applyMatch above: collapsing two games into one destroys whichever one does
 * not survive, so a human-edited (non-MACHINE_SOURCES) row is only ever a
 * survivor, never the one a sweep removes. See the branches below for how
 * that plays out when more than one row is human-edited.
 */
async function mergeDuplicates(orgId: string, sortTitle: string, year: number | null): Promise<number> {
  const db = getDb();

  const dupes = await db
    .select({ id: games.id, createdAt: games.createdAt, metadataSource: games.metadataSource })
    .from(games)
    .where(and(
      eq(games.orgId, orgId),
      eq(games.sortTitle, sortTitle),
      year === null ? isNull(games.year) : eq(games.year, year),
    ))
    // createdAt ALONE is not a total order. ingest/complete bulk-inserts up
    // to INSERT_CHUNK (250) games in a single INSERT, and Postgres' now()
    // returns the enclosing TRANSACTION's start time, so every game created
    // by one /complete call shares one identical createdAt. Without games.id
    // (the primary key) as a tiebreaker, ties among those rows have no
    // defined order, and which one this function treats as "first" -- the
    // survivor -- could change from one sweep to the next. This exact bug
    // class (non-unique ORDER BY paired with a first-row/LIMIT pick) has
    // already appeared once in this codebase, on the super-admin plane's user
    // list (see admin-queries.ts's adminListUsers, which orders by
    // (createdAt, id) for the same reason). Do not drop the second column.
    .orderBy(games.createdAt, games.id);

  if (dupes.length < 2) return 0;

  const protectedRows = dupes.filter((d) => !MACHINE_SOURCES.includes(d.metadataSource ?? ''));
  const machineRows = dupes.filter((d) => MACHINE_SOURCES.includes(d.metadataSource ?? ''));

  // Two or more human-edited rows: merging them would mean deleting one
  // person's edit to keep another's, and choosing between two human
  // decisions is not a sweep's call. Merge nothing, for either row.
  if (protectedRows.length >= 2) return 0;

  // Exactly one protected row: it is the survivor regardless of where it
  // sorts by (createdAt, id), and only machine-authored rows are absorbed.
  // With zero protected rows, the survivor is the oldest machine row by the
  // deterministic order above.
  const survivor = protectedRows.length === 1 ? protectedRows[0].id : machineRows[0].id;
  const absorbed = machineRows.filter((m) => m.id !== survivor).map((m) => m.id);

  if (absorbed.length === 0) return 0;

  const stmts: BatchItem<'pg'>[] = [];
  for (const gone of absorbed) {
    // Deliberately NOT org-scoped, unlike the two devices updates below.
    // disks.orgId is an independent column, not guaranteed to match its
    // game's org (src/lib/admin-delete.ts documents this drift as real), so
    // an org-scoped predicate here can leave a disk pointed at `gone`. That
    // disk is not merely missed -- `gone` is a game in THIS org, so any disk
    // pointing at it is reachable only through it, and the DELETE below
    // cascades (disks.gameId references games.id with onDelete: 'cascade')
    // and destroys it outright. A destroyed disk is indistinguishable from
    // an eject: readDesired's leftJoin on devices.desiredDiskId returns no
    // row, and "no disk desired" IS eject in this protocol. Repointing every
    // disk regardless of its own orgId is strictly SAFER than that cascade,
    // not a cross-tenant risk -- there is no other tenant's disk to move,
    // because `gone` never belonged to one.
    stmts.push(db.update(disks).set({ gameId: survivor })
      .where(eq(disks.gameId, gone)));
    stmts.push(db.update(devices).set({ desiredGameId: survivor })
      .where(and(eq(devices.orgId, orgId), eq(devices.desiredGameId, gone))));
    stmts.push(db.update(devices).set({ mountedGameId: survivor })
      .where(and(eq(devices.orgId, orgId), eq(devices.mountedGameId, gone))));

    // Collections are HUMAN-authored and cannot be recomputed, unlike every
    // other grouping in this app. A membership row left pointing at `gone`
    // would be destroyed by the cascade below, silently removing a game from
    // someone's collection with no error and nothing to recover from.
    //
    // TWO statements, and the ORDER MATTERS. If a collection already holds
    // the survivor as well as `gone`, a bare repoint produces two rows with
    // the same (collection_id, game_id) and violates the primary key --
    // which, because db.batch() is atomic, aborts the ENTIRE merge. The
    // sweeper does not stamp a blob whose applyMatch threw, so it would retry
    // that merge on every pass forever. Deleting the would-be duplicates
    // first makes the repoint always legal.
    stmts.push(db.delete(collectionGames).where(and(
      eq(collectionGames.gameId, gone),
      inArray(
        collectionGames.collectionId,
        db.select({ id: collectionGames.collectionId })
          .from(collectionGames)
          .where(eq(collectionGames.gameId, survivor)),
      ),
    )));
    stmts.push(db.update(collectionGames)
      .set({ gameId: survivor })
      .where(eq(collectionGames.gameId, gone)));

    // Demozoo dismissals ("not this production") are per-org-game, exactly
    // like collectionGames above, and the same PRIMARY KEY violation applies:
    // (game_id, production_id) means a repoint that lands on a production the
    // survivor already dismissed would collide. Delete-then-update, same
    // reason, same order, for the same atomicity consequence.
    stmts.push(db.delete(demozooDismissals).where(and(
      eq(demozooDismissals.gameId, gone),
      inArray(
        demozooDismissals.productionId,
        db.select({ id: demozooDismissals.productionId })
          .from(demozooDismissals)
          .where(eq(demozooDismissals.gameId, survivor)),
      ),
    )));
    stmts.push(db.update(demozooDismissals)
      .set({ gameId: survivor })
      .where(eq(demozooDismissals.gameId, gone)));

    // A Demozoo CONFIRMATION is a human decision (spec §6.2) and the Authority
    // rule protects it the same way protectedRows above protects title/year/
    // publisher: it must not be silently lost because the row that happened
    // to carry it was the one absorbed. Unlike title/year/publisher, a
    // confirmation is not what decided survivor vs. absorbed above -- a game
    // can be MACHINE_SOURCES-titled and still carry a human's confirmed link
    // (confirmDemozoo does not touch metadataSource) -- so it needs its own
    // carry-forward here, done as a single correlated UPDATE rather than a
    // read-then-write because this statement runs inside the same atomic
    // batch as every other repoint for `gone`, before the DELETE below removes
    // the row these subqueries read from. Only fires when the survivor has NO
    // confirmation of its own (demozoo_link_source IS NULL) and `gone` has
    // one; if both have one, the survivor's stands, matching how a doubly
    // human-edited pair is left alone above.
    stmts.push(db.update(games).set({
      demozooProductionId: sql`(SELECT demozoo_production_id FROM games WHERE id = ${gone})`,
      demozooLinkSource: sql`(SELECT demozoo_link_source FROM games WHERE id = ${gone})`,
    }).where(and(
      eq(games.id, survivor),
      isNull(games.demozooLinkSource),
      sql`(SELECT demozoo_link_source FROM games WHERE id = ${gone}) IS NOT NULL`,
    )));

    stmts.push(db.delete(games).where(and(eq(games.id, gone), ne(games.id, survivor))));
  }
  await db.batch(stmts as [BatchItem<'pg'>, ...BatchItem<'pg'>[]]);
  // Traceable in logs: a merge deletes `games` rows, and applyMatch's
  // caller (the sweep) can only report a count, not which games. Named here
  // because this is the one place that still has both ids in hand.
  console.log(`tosec-apply: merged ${absorbed.length} game(s) into ${survivor}: ${absorbed.join(', ')}`);
  return absorbed.length;
}
