import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { disks, games } from '@/db/schema/catalog';
import { ADF_BYTES } from '@/lib/adfmfm';

export interface DesiredDisk {
  sha256: string;
  // The exact disks row this is. Lets the device's status report name the
  // disk it actually holds (mountedDiskId) rather than plan 3b having to
  // resolve (orgId, sha256) back to a row -- the non-unique lookup
  // desiredDiskId itself exists to avoid on the desired side.
  diskId: string;
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
 * device or the disk is outside `orgId`, or the disk is not exactly one
 * standard 901,120-byte DD image (see the sizeBytes check below).
 *
 * Null rather than a thrown "not found" on purpose: a caller cannot tell a
 * device that belongs to someone else from one that does not exist -- and
 * now also cannot tell that from a disk the encoder will refuse.
 */
export async function setDesired(
  orgId: string, deviceId: string, diskId: string,
): Promise<number | null> {
  const db = getDb();

  // Org-scoped in the statement. A disk id alone is not enough to name a disk.
  const rows = await db
    .select({
      id: disks.id, sha256: disks.sha256, gameId: disks.gameId, diskNo: disks.diskNo,
      sizeBytes: disks.sizeBytes,
    })
    .from(disks)
    .where(and(eq(disks.id, diskId), eq(disks.orgId, orgId)))
    .limit(1);
  const disk = rows[0];
  if (!disk) return null;
  // Ingest accepts anything from 1 byte to 2 MiB (a truncated .adf from a
  // scraped archive included), but encodeDisk throws on anything that is not
  // exactly a standard DD image. A disk the encoder cannot serve must not
  // become mountable: without this check, mount succeeds, the poll succeeds,
  // and /api/device/image/<sha256> 500s forever with nothing telling the
  // human why the Amiga never sees a disk.
  if (disk.sizeBytes !== ADF_BYTES) return null;

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
      diskId: disks.id,
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
  if (!r.sha256 || !r.gameId || r.diskNo === null || !r.diskId) {
    return { version: r.version, desired: null };
  }

  return {
    version: r.version,
    desired: {
      sha256: r.sha256,
      diskId: r.diskId,
      gameId: r.gameId,
      game: r.title ?? 'Unknown',
      diskNo: r.diskNo,
      // count(*) returns 0, not null, after a cascade delete leaves no rows
      // for this game -- `|| 1` would treat that 0 as falsy and fall through
      // to the same default, but so would a negative value slip past nothing
      // catches; Math.max is explicit about the floor being 1, not "anything
      // falsy".
      diskCount: Math.max(r.diskCount ?? 1, 1),
      label: r.label ?? `Disk ${r.diskNo}`,
      // A disk row that has gone missing is not a licence to allow writes.
      writeProtected: r.writeProtected ?? true,
    },
  };
}

/**
 * Record what the device says it actually holds. Never touches desired state —
 * a report is an observation, not an instruction.
 *
 * error, psramFree, rssi, mountedDiskId and version are all optional:
 * `undefined` means the caller's report did not mention the field at all and
 * the column must be left exactly as it was, while an explicit `null` still
 * means "clear this" (error) or "I hold nothing" (mountedDiskId). Without
 * that distinction a minimal report -- {mountedSha256: X}, the exact shape
 * the reference client sends -- would wipe last_error (and mounted_game_id/
 * mounted_disk_no) while a mount is still unconverged, and a human would see
 * desired != mounted with no explanation. mountedSha256 and lastSeenAt are
 * the two exceptions: a device always knows what it holds (even "nothing"),
 * and every POST is by definition contact, so both are always written.
 */
export async function recordStatus(
  deviceId: string,
  s: {
    mountedSha256: string | null;
    mountedDiskId?: string | null;
    version?: number;
    error?: string | null;
    psramFree?: number | null;
    rssi?: number | null;
  },
): Promise<void> {
  const db = getDb();

  const patch: Partial<typeof devices.$inferInsert> = {
    mountedSha256: s.mountedSha256,
    lastSeenAt: new Date(),
  };
  if (s.psramFree !== undefined) patch.psramFree = s.psramFree;
  if (s.rssi !== undefined) patch.rssi = s.rssi;
  if (s.error !== undefined) {
    patch.lastError = s.error;
    patch.lastErrorAt = s.error ? new Date() : null;
  }
  if (s.version !== undefined) patch.mountedVersion = s.version;

  if (s.mountedDiskId !== undefined) {
    patch.mountedDiskId = s.mountedDiskId;
    // Resolve the reported disk id back to a game/disk-number, org-scoped by
    // the device's own org in the same statement -- never by an org claim
    // the device's body could make. A report must never 500: an id that does
    // not resolve (stale, deleted, wrong org) still records the sha, diskId
    // and version, just with game/diskNo left null rather than failing the
    // whole report.
    let mountedGameId: string | null = null;
    let mountedDiskNo: number | null = null;
    if (s.mountedDiskId) {
      const rows = await db
        .select({ gameId: disks.gameId, diskNo: disks.diskNo })
        .from(disks)
        .innerJoin(devices, eq(devices.orgId, disks.orgId))
        .where(and(eq(disks.id, s.mountedDiskId), eq(devices.id, deviceId)))
        .limit(1);
      if (rows[0]) {
        mountedGameId = rows[0].gameId;
        mountedDiskNo = rows[0].diskNo;
      }
    }
    patch.mountedGameId = mountedGameId;
    patch.mountedDiskNo = mountedDiskNo;
  }

  await db.update(devices).set(patch).where(eq(devices.id, deviceId));
}

/**
 * Touch last_seen_at alone. Called once per poll request, right after auth
 * succeeds -- the poll is the only contact a device is guaranteed to make
 * every ~25 s, so a device polling happily whose status POST is failing must
 * still read as recently seen, not as vanished hardware.
 */
export async function touchLastSeen(deviceId: string): Promise<void> {
  await getDb().update(devices)
    .set({ lastSeenAt: new Date() })
    .where(eq(devices.id, deviceId));
}
