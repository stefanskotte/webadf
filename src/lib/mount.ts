import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { disks, games } from '@/db/schema/catalog';

export interface DesiredDisk {
  sha256: string;
  gameId: string;
  game: string;
  diskNo: number;
  diskCount: number;
  label: string;
  writeProtected: boolean;
}

export interface DesiredState {
  version: number;
  desired: DesiredDisk | null;
}

/**
 * Point a device at a disk. Returns the new version, or null when either the
 * device or the disk is outside `orgId`.
 *
 * Null rather than a thrown "not found" on purpose: a caller cannot tell a
 * device that belongs to someone else from one that does not exist.
 */
export async function setDesired(
  orgId: string, deviceId: string, diskId: string,
): Promise<number | null> {
  const db = getDb();

  // Org-scoped in the statement. A disk id alone is not enough to name a disk.
  const rows = await db
    .select({ id: disks.id, sha256: disks.sha256, gameId: disks.gameId, diskNo: disks.diskNo })
    .from(disks)
    .where(and(eq(disks.id, diskId), eq(disks.orgId, orgId)))
    .limit(1);
  const disk = rows[0];
  if (!disk) return null;

  // The version bump is in the same UPDATE as the state it describes, so a
  // poller can never observe a new version beside the old disk, or the reverse.
  const updated = await db.update(devices)
    .set({
      desiredSha256: disk.sha256,
      desiredGameId: disk.gameId,
      desiredDiskNo: disk.diskNo,
      desiredDiskId: disk.id,
      desiredSetAt: new Date(),
      desiredVersion: sql`${devices.desiredVersion} + 1`,
    })
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
    .returning({ version: devices.desiredVersion });

  return updated[0]?.version ?? null;
}

/** Eject: no disk is desired. Returns the new version, or null if out of org. */
export async function clearDesired(orgId: string, deviceId: string): Promise<number | null> {
  const updated = await getDb().update(devices)
    .set({
      desiredSha256: null,
      desiredGameId: null,
      desiredDiskNo: null,
      desiredDiskId: null,
      desiredSetAt: new Date(),
      desiredVersion: sql`${devices.desiredVersion} + 1`,
    })
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
    .returning({ version: devices.desiredVersion });

  return updated[0]?.version ?? null;
}

/**
 * Just the version. The poll loop calls this once a second for 25 s, so it must
 * stay a single-column read on the primary key — never the join below.
 * Null means the device row is gone.
 */
export async function readDesiredVersion(deviceId: string): Promise<number | null> {
  const rows = await getDb()
    .select({ version: devices.desiredVersion })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  return rows[0]?.version ?? null;
}

/**
 * What this device should be holding. Not org-scoped: the caller is the device
 * itself, already authenticated to exactly this row by requireDevice().
 */
export async function readDesired(deviceId: string): Promise<DesiredState | null> {
  const rows = await getDb()
    .select({
      version: devices.desiredVersion,
      sha256: devices.desiredSha256,
      gameId: devices.desiredGameId,
      diskNo: devices.desiredDiskNo,
      title: games.title,
      label: disks.label,
      writeProtected: disks.writeProtected,
      // Derived, not stored — games has no disk_count column. Matches how
      // src/lib/queries.ts:17 counts it for the library grid.
      diskCount: sql<number>`(
        select count(*)::int from disks dc
        where dc.game_id = ${devices.desiredGameId} and dc.org_id = ${devices.orgId}
      )`,
    })
    .from(devices)
    .leftJoin(games, eq(games.id, devices.desiredGameId))
    // Joined on the primary key, not the (gameId, diskNo, orgId) triple --
    // that triple is not guaranteed unique (a corrected re-ingest of the same
    // disk number lands a second disks row), so a join on it could silently
    // pick the wrong row and report the wrong writeProtected for hardware
    // that is about to honor it.
    .leftJoin(disks, eq(disks.id, devices.desiredDiskId))
    .where(eq(devices.id, deviceId))
    .limit(1);

  const r = rows[0];
  if (!r) return null;
  if (!r.sha256 || !r.gameId || r.diskNo === null) {
    return { version: r.version, desired: null };
  }

  return {
    version: r.version,
    desired: {
      sha256: r.sha256,
      gameId: r.gameId,
      game: r.title ?? 'Unknown',
      diskNo: r.diskNo,
      diskCount: r.diskCount ?? 1,
      label: r.label ?? `Disk ${r.diskNo}`,
      // A disk row that has gone missing is not a licence to allow writes.
      writeProtected: r.writeProtected ?? true,
    },
  };
}

/**
 * Record what the device says it actually holds. Never touches desired state —
 * a report is an observation, not an instruction.
 */
export async function recordStatus(
  deviceId: string,
  s: { mountedSha256: string | null; error: string | null; psramFree: number | null; rssi: number | null },
): Promise<void> {
  await getDb().update(devices)
    .set({
      mountedSha256: s.mountedSha256,
      lastSeenAt: new Date(),
      psramFree: s.psramFree,
      rssi: s.rssi,
      lastError: s.error,
      lastErrorAt: s.error ? new Date() : null,
    })
    .where(eq(devices.id, deviceId));
}
