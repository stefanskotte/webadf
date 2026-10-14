// DF1 any disk (spec docs/superpowers/specs/2026-10-14-df1-any-disk-design.md §4): the pick's writes and the
// poll's read. Every write is ONE org-scoped UPDATE that moves df1_version with the pick -- the board learns of a
// change only through that cursor (a wake needs a cursor, not a flag).
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { disks } from '@/db/schema/catalog';
import { firmwareAtLeastSql } from '@/lib/display-store';
import { DF1_PICK_FW, df1Refusal, isStandardDd, type Df1Refusal } from '@/lib/df1-pick';

export type MountDf1Outcome = { ok: true; version: number } | { ok: false; reason: 'not_found' | Df1Refusal };

/**
 * Mount a disk into DF1 (spec §4.4). §3.1's board rules live in the UPDATE's WHERE (the saveSecondDrive /
 * saveDisplay pattern): a status report or a DF0 mount landing between a read and this write cannot slip a refused
 * pick through. The disk's own rule (a standard DD ADF of this org) is a property of its row, checked first.
 * not_found covers an unknown disk, another org's disk, and another org's board -- indistinguishable, as for
 * setDesired.
 */
export async function mountToDf1(orgId: string, deviceId: string, diskId: string): Promise<MountDf1Outcome> {
  const db = getDb();
  const [disk] = await db
    .select({ id: disks.id, imageFormat: disks.imageFormat, sizeBytes: disks.sizeBytes })
    .from(disks)
    .where(and(eq(disks.id, diskId), eq(disks.orgId, orgId)))
    .limit(1);
  if (!disk) return { ok: false, reason: 'not_found' };
  const scope = and(eq(devices.id, deviceId), eq(devices.orgId, orgId));
  if (isStandardDd(disk)) {
    const [row] = await db.update(devices)
      .set({ df1DiskId: disk.id, df1Version: sql`${devices.df1Version} + 1` })
      .where(and(
        scope,
        eq(devices.secondDrive, 'df1'),
        eq(devices.secondDriveReported, 'df1'),
        eq(devices.secondDriveAppliedVersion, devices.secondDriveVersion),
        firmwareAtLeastSql(DF1_PICK_FW),
        // Rule 4, by disk ROW (spec §8.2): not the disk DF0 holds or is about to hold.
        sql`coalesce(${devices.desiredDiskId}, ${devices.mountedDiskId}) is distinct from ${disk.id}`,
      ))
      .returning({ version: devices.df1Version });
    if (row) return { ok: true, version: row.version };
  }
  const [b] = await db
    .select({
      secondDrive: devices.secondDrive, secondDriveReported: devices.secondDriveReported,
      secondDriveVersion: devices.secondDriveVersion, secondDriveAppliedVersion: devices.secondDriveAppliedVersion,
      firmwareVersion: devices.firmwareVersion, desiredDiskId: devices.desiredDiskId,
      mountedDiskId: devices.mountedDiskId, df1DiskId: devices.df1DiskId,
    })
    .from(devices)
    .where(scope)
    .limit(1);
  if (!b) return { ok: false, reason: 'not_found' };
  // A refusal that no longer holds when read back (the board caught up between the write and this read) is still
  // a refusal of THIS request: the person presses again.
  return { ok: false, reason: df1Refusal(b, disk) ?? 'waiting' };
}

/** Eject DF1 (spec §3.2): the pick goes and DF1 follows the set again. The new cursor, or null if not this org's. */
export async function ejectDf1(orgId: string, deviceId: string): Promise<number | null> {
  const [row] = await getDb().update(devices)
    .set({ df1DiskId: null, df1Version: sql`${devices.df1Version} + 1` })
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
    .returning({ version: devices.df1Version });
  return row?.version ?? null;
}

/**
 * Every board of the org whose pick is one of `diskIds` lets go of it, with the cursor moved (plan ruling 2): the
 * FK's ON DELETE SET NULL would clear the column and tell no board. Called before the disks are deleted.
 */
export async function ejectDf1Holders(orgId: string, diskIds: string[]): Promise<string[]> {
  if (diskIds.length === 0) return [];
  const rows = await getDb().update(devices)
    .set({ df1DiskId: null, df1Version: sql`${devices.df1Version} + 1` })
    .where(and(eq(devices.orgId, orgId), inArray(devices.df1DiskId, diskIds)))
    .returning({ name: devices.name });
  return rows.map((r) => r.name);
}

/**
 * The poll body's `df1` (spec §4.2): the cursor and the pick's digest, null without one. Not org-scoped by the
 * caller -- the device is authenticated to exactly this row -- but the join is: a pick naming another org's disk
 * row yields null, never that org's digest.
 */
export async function readDf1ForPoll(deviceId: string): Promise<{ v: number; sha256: string | null }> {
  const [r] = await getDb()
    .select({ v: devices.df1Version, sha256: disks.sha256 })
    .from(devices)
    .leftJoin(disks, and(eq(disks.id, devices.df1DiskId), eq(disks.orgId, devices.orgId)))
    .where(eq(devices.id, deviceId))
    .limit(1);
  return { v: r?.v ?? 0, sha256: r?.sha256 ?? null };
}
