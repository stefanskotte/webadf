// Removing a disk, or a whole title, from one organization's library.
//
// THE BLOB IS NEVER DELETED HERE, and that is not an oversight. `blobs` is
// global and content-addressed: the same bytes may be entitled to other
// tenants, and deleting the object would break their library. What this
// removes is THIS org's claim on those bytes -- the entitlement -- which is
// what makes the blob reclaimable later. src/lib/blob-gc.ts decides when.

import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks, entitlements } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { diskVersions } from '@/db/schema/disk-history';
import { clearDesired } from '@/lib/mount';
import { ejectDf1Holders } from '@/lib/df1-store';
import { planReorder } from '@/lib/disk-set';
import { applyPlan, orgDevices, run } from '@/lib/disk-set-store';

export interface DeleteResult {
  /** Disk ids actually removed. */
  diskIds: string[];
  /** True when the title went too -- either asked for, or its last disk left. */
  gameDeleted: boolean;
  /** Devices ejected on the way, by name, so the UI can say what it did. */
  ejected: string[];
  /** Entitlements dropped; the blobs themselves stay. */
  releasedSha256: string[];
}

/**
 * Eject every device in this org that wants or holds any of these disks.
 *
 * DELIBERATE, not incidental. `disks.gameId` cascades, so the rows would
 * vanish either way -- but readDesired resolves the disk through a LEFT JOIN
 * on devices.desiredDiskId, so a disk that simply disappears makes that join
 * return nothing, which in this protocol IS an eject. The board would never
 * be told: the long poll is gated on desiredVersion, and nothing would have
 * bumped it. clearDesired is used rather than a hand-written UPDATE precisely
 * because it bumps the version.
 *
 * Matched on the disk id AND the sha, because a device can be pointed at
 * bytes by either: desiredDiskId is what resolves the label, desiredSha256 is
 * what the board actually fetches.
 */
async function ejectHolders(orgId: string, diskIds: string[], shas: string[]): Promise<string[]> {
  if (diskIds.length === 0) return [];
  const db = getDb();
  const holders = await db
    .select({ id: devices.id, name: devices.name })
    .from(devices)
    .where(and(eq(devices.orgId, orgId), inArray(devices.desiredDiskId, diskIds)));

  const byShaRows = shas.length === 0 ? [] : await db
    .select({ id: devices.id, name: devices.name })
    .from(devices)
    .where(and(eq(devices.orgId, orgId), inArray(devices.desiredSha256, shas)));

  const all = new Map<string, string>();
  for (const d of [...holders, ...byShaRows]) all.set(d.id, d.name);

  for (const id of all.keys()) await clearDesired(orgId, id);
  // DF1 any disk (spec 2026-10-14 §3.2, plan ruling 2): a board holding one of these disks in DF1 lets go of it,
  // with its cursor moved. The FK's ON DELETE SET NULL would clear the column after the delete and tell no board.
  const df1 = await ejectDf1Holders(orgId, diskIds);
  return [...new Set([...all.values(), ...df1])];
}

/**
 * The shas an org must stay entitled to: every one a current disk points at,
 * and every one its disk history names, as a version's blob or its image.
 */
export function entitlementsToKeep(
  diskShas: string[], history: { blob: string; image: string }[],
): Set<string> {
  const keep = new Set(diskShas);
  for (const h of history) { keep.add(h.blob); keep.add(h.image); }
  return keep;
}

/**
 * Drop this org's entitlement to bytes it no longer holds a disk for.
 *
 * ONLY when no OTHER disk in the same org still references that sha256. The
 * same bytes can back two disks in one library -- a duplicate upload, or two
 * titles that happen to be identical -- and removing the entitlement while
 * one of those remains would break the survivor's download and its device
 * fetch, because the entitlement IS the access boundary those paths check.
 * Nor while the org's disk history still names it (entitlementsToKeep).
 */
async function releaseEntitlements(orgId: string, shas: string[]): Promise<string[]> {
  if (shas.length === 0) return [];
  const db = getDb();
  const [stillUsed, inHistory] = await Promise.all([
    db.select({ sha256: disks.sha256 }).from(disks)
      .where(and(eq(disks.orgId, orgId), inArray(disks.sha256, shas))),
    // A sha the org's disk HISTORY still names -- an earlier version of a
    // surviving disk, as its snapshot or its image -- is still needed: the
    // entitlement is what keeps the e2e blob GC from reclaiming those bytes,
    // and without them that disk's history can never be rebuilt.
    db.select({ blob: diskVersions.blobSha256, image: diskVersions.imageSha256 }).from(diskVersions)
      .where(and(eq(diskVersions.orgId, orgId),
        or(inArray(diskVersions.blobSha256, shas), inArray(diskVersions.imageSha256, shas)))),
  ]);
  const keep = entitlementsToKeep(stillUsed.map((r) => r.sha256), inHistory);
  const release = shas.filter((s) => !keep.has(s));
  if (release.length === 0) return [];
  await db.delete(entitlements)
    .where(and(eq(entitlements.orgId, orgId), inArray(entitlements.sha256, release)));
  return release;
}

/**
 * Remove one disk. Takes the title with it when it was the last one.
 *
 * A person-arranged set (disk_order_source = 'human') closes the gap the disk
 * leaves, in the same batch as the delete: its other disks are renumbered
 * 1..N in their current order, so a set never reads "Disk 3 of 2". Boards
 * holding one of those disks get the new game/number exactly as
 * disk-set-store moves them -- only *_game_id/*_disk_no, guarded on the disk
 * the board still names, never *_disk_id or desired_version.
 */
export async function deleteDisk(orgId: string, diskId: string): Promise<DeleteResult | null> {
  const db = getDb();
  const rows = await db
    .select({ id: disks.id, sha256: disks.sha256, gameId: disks.gameId })
    .from(disks)
    .where(and(eq(disks.id, diskId), eq(disks.orgId, orgId)))
    .limit(1);
  const disk = rows[0];
  if (!disk) return null;

  const siblings = await db.select({ id: disks.id, gameId: disks.gameId, diskNo: disks.diskNo }).from(disks)
    .where(and(eq(disks.gameId, disk.gameId), eq(disks.orgId, orgId), ne(disks.id, disk.id)));
  const owner = await db.select({ diskOrderSource: games.diskOrderSource }).from(games)
    .where(and(eq(games.id, disk.gameId), eq(games.orgId, orgId))).limit(1);

  const ejected = await ejectHolders(orgId, [disk.id], [disk.sha256]);
  const deleteIt = db.delete(disks).where(and(eq(disks.id, disk.id), eq(disks.orgId, orgId)));

  const ordered = [...siblings].sort((a, b) => a.diskNo - b.diskNo || (a.id < b.id ? -1 : 1));
  const gap = ordered.some((d, i) => d.diskNo !== i + 1);
  if (owner[0]?.diskOrderSource === 'human' && gap) {
    // Read after the eject, so a board that held the deleted disk is no
    // longer counted as holding anything.
    const devs = await orgDevices(db, orgId);
    const plan = planReorder({ gameId: disk.gameId, disks: ordered }, ordered.map((d) => d.id), devs);
    await run(db, [deleteIt, ...applyPlan(db, orgId, plan, devs)]);
  } else {
    await deleteIt;
  }

  // A title with no disks left is not a title. Checked AFTER the delete so
  // the count is what remains, not what was. The delete itself also refuses
  // a title that still has ANY disk (not org-scoped: disks.org_id can drift),
  // since disks.game_id cascades and would take such a disk with it.
  const remaining = await db.select({ id: disks.id }).from(disks)
    .where(and(eq(disks.gameId, disk.gameId), eq(disks.orgId, orgId)));
  let gameDeleted = false;
  if (remaining.length === 0) {
    const gone = await db.delete(games).where(and(eq(games.id, disk.gameId), eq(games.orgId, orgId),
      sql`not exists (select 1 from ${disks} "d" where "d"."game_id" = ${games.id})`)).returning({ id: games.id });
    gameDeleted = gone.length > 0;
  }

  const releasedSha256 = await releaseEntitlements(orgId, [disk.sha256]);
  return { diskIds: [disk.id], gameDeleted, ejected, releasedSha256 };
}

/** Remove a whole title and every disk on it. */
export async function deleteGame(orgId: string, gameId: string): Promise<DeleteResult | null> {
  const db = getDb();
  const owned = await db.select({ id: games.id }).from(games)
    .where(and(eq(games.id, gameId), eq(games.orgId, orgId))).limit(1);
  if (owned.length === 0) return null;

  const rows = await db.select({ id: disks.id, sha256: disks.sha256 }).from(disks)
    .where(and(eq(disks.gameId, gameId), eq(disks.orgId, orgId)));
  const diskIds = rows.map((r) => r.id);
  const shas = [...new Set(rows.map((r) => r.sha256))];

  const ejected = await ejectHolders(orgId, diskIds, shas);

  // Disks explicitly, not by relying on the FK cascade. The cascade would do
  // it, but only for rows whose disks.orgId matches -- and that column is
  // independent and can drift from its game's org (D-5-5), so a cascade could
  // take a row this org does not own. Deleting org-scoped first means the
  // cascade finds nothing left to guess about.
  if (diskIds.length > 0) {
    await db.delete(disks).where(and(eq(disks.gameId, gameId), eq(disks.orgId, orgId)));
  }
  // collection_games.gameId cascades from here, which is correct and
  // deliberate: a membership of a title that is genuinely gone is not worth
  // keeping. That is the OPPOSITE of the disks ruling above, where a
  // disappearing row would read as an eject.
  await db.delete(games).where(and(eq(games.id, gameId), eq(games.orgId, orgId)));

  const releasedSha256 = await releaseEntitlements(orgId, shas);
  return { diskIds, gameDeleted: true, ejected, releasedSha256 };
}
