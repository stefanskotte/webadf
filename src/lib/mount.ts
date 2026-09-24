import { and, eq, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { DC_TITLE_MAX, DC_LABEL_MAX } from '@/lib/device-limits';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { firmwareReleases } from '@/db/schema/firmware';
import { disks, games } from '@/db/schema/catalog';
import { isServable } from '@/lib/disk-format';

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
      sizeBytes: disks.sizeBytes, imageFormat: disks.imageFormat,
    })
    .from(disks)
    .where(and(eq(disks.id, diskId), eq(disks.orgId, orgId)))
    .limit(1);
  const disk = rows[0];
  if (!disk) return null;
  // Ingest accepts anything from 1 byte to 2 MiB (a truncated .adf from a
  // scraped archive included), but the image route can only serve an exact
  // DD ADF or an HFE validated at ingest (isServable). A disk the route
  // cannot serve must not become mountable: without this check, mount
  // succeeds, the poll succeeds, and /api/device/image/<sha256> 500s forever
  // with nothing telling the human why the Amiga never sees a disk.
  if (!isServable(disk)) return null;

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
export interface PollTick {
  /** desiredVersion: the disk-state counter the device echoes as mountedVersion. */
  version: number;
  /** The firmware instruction counter, and what the device has acknowledged. */
  instructionVersion: number;
  instructionAck: number;
}

/**
 * Everything the 25 s hold loop needs, in ONE row read on the primary key.
 *
 * It must stay a single query: the loop calls this once a second, and the
 * joins belong on the delivery path. It briefly was two -- desiredVersion and
 * a separate firmware-cursor read -- which doubled the fleet's steady-state
 * query count while a comment claimed otherwise.
 */
export async function readPollTick(deviceId: string): Promise<PollTick | null> {
  const [row] = await getDb()
    .select({
      version: devices.desiredVersion,
      instructionVersion: devices.firmwareInstructionVersion,
      instructionAck: devices.firmwareInstructionAck,
    })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  return row ?? null;
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
      // BOUNDED, and this is load-bearing. `game` and `label` come from
      // `text` columns with no length limit, while the firmware's poll buffer
      // is a fixed DC_POLL_BODY_BYTES -- and the firmware REFUSES a truncated
      // body outright rather than losing the last field, so one long TOSEC
      // title could make a board stop mounting and ejecting entirely. The
      // limits are the firmware's own DC_TITLE_MAX / DC_LABEL_MAX, so nothing
      // the board could have used is lost: it truncates to exactly these
      // anyway. src/lib/firmware-version.test.ts asserts the whole worst-case
      // body still fits.
      game: (r.title ?? 'Unknown').slice(0, DC_TITLE_MAX),
      diskNo: r.diskNo,
      // count(*) returns 0, not null, after a cascade delete leaves no rows
      // for this game -- `|| 1` would treat that 0 as falsy and fall through
      // to the same default, but so would a negative value slip past nothing
      // catches; Math.max is explicit about the floor being 1, not "anything
      // falsy".
      diskCount: Math.max(r.diskCount ?? 1, 1),
      label: (r.label ?? `Disk ${r.diskNo}`).slice(0, DC_LABEL_MAX),
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
    /** The board's own firmware version, refreshed on every heartbeat. */
    firmwareVersion?: string | null;
    updateProtocol?: number;
    firmwareUpdateState?: string | null;
    firmwareUpdateError?: string | null;
    /** Highest firmware instruction the board has seen. Monotonic. */
    firmwareInstructionAck?: number;
    error?: string | null;
    psramFree?: number | null;
    rssi?: number | null;
  },
): Promise<void> {
  const db = getDb();

  // SQL is allowed alongside plain values: the firmware-completion clear and
  // the acknowledgement cursor below are expressed as column-relative
  // expressions so they evaluate against the row's pre-image under one lock,
  // rather than against a value read a round trip earlier.
  const patch: PgUpdateSetSource<typeof devices> = {
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
  // Absent leaves the column alone; an explicit null clears it. Same rule as
  // every other optional field here -- a partial report must never wipe a
  // value a fuller one established.
  if (s.firmwareVersion !== undefined) patch.firmwareVersion = s.firmwareVersion;
  if (s.updateProtocol !== undefined) patch.updateProtocol = s.updateProtocol;
  if (s.firmwareUpdateState !== undefined) patch.firmwareUpdateState = s.firmwareUpdateState;
  if (s.firmwareUpdateError !== undefined) patch.firmwareUpdateError = s.firmwareUpdateError;
  // The acknowledgement cursor only ever goes UP. A late report carrying an
  // older value must not re-open a wake the device has already answered.
  if (s.firmwareInstructionAck !== undefined) {
    patch.firmwareInstructionAck = sql`greatest(${devices.firmwareInstructionAck}, ${s.firmwareInstructionAck})`;
  }

  // An update is COMPLETE when the board reports running the exact version it
  // was asked to run. The device never says "I succeeded" -- this is the only
  // evidence that counts, and the board produces it by running rather than by
  // claiming.
  //
  // Expressed as a COMPARE-AND-CLEAR inside the single UPDATE, not as a read
  // then a write. It used to SELECT the desired version, decide in JS, and
  // write the decision -- two round trips on the neon-http driver, with no
  // transaction available (see admin-delete.ts). An operator requesting a new
  // version inside that window had their request silently erased by the
  // heartbeat's stale decision: 200 returned, success toasted, nothing
  // pending, nothing logged. Each CASE below evaluates against the same
  // pre-image under one row lock, so a concurrent request either wins or is
  // left entirely alone.
  //
  // Final review I2: running the version is not yet KEEPING it. A board in
  // its TBYB trial already runs (and reports) the new version, but the boot
  // ROM will revert it unless the trial confirms -- so the trial says
  // firmwareUpdateState "applying", and completion waits for the confirmed
  // boot, which reports null. Taking the trial's heartbeat as completion
  // cleared the target and error, and a later revert then showed "up to
  // date" with the failure nowhere. An absent state (a board that predates
  // the field) is not "applying" and still completes.
  if (s.firmwareVersion && s.firmwareUpdateState !== 'applying') {
    const done = sql`${devices.desiredFirmwareVersion} = ${s.firmwareVersion}`;
    patch.desiredFirmwareVersion =
      sql`case when ${done} then null else ${devices.desiredFirmwareVersion} end`;
    patch.desiredFirmwareSetAt =
      sql`case when ${done} then null else ${devices.desiredFirmwareSetAt} end`;
    patch.desiredFirmwareSetByUserId =
      sql`case when ${done} then null else ${devices.desiredFirmwareSetByUserId} end`;
    // The `else` branches carry whatever this same report asked for, not the
    // column's old value. Written the other way, a heartbeat carrying BOTH a
    // version and a state -- the normal shape -- had its state silently
    // overwritten by the completion CASE, so progress never landed and
    // refuseTarget's update_in_flight guard could never fire.
    const elseState = s.firmwareUpdateState !== undefined
      ? sql`${s.firmwareUpdateState}`
      : sql`${devices.firmwareUpdateState}`;
    const elseError = s.firmwareUpdateError !== undefined
      ? sql`${s.firmwareUpdateError}`
      : sql`${devices.firmwareUpdateError}`;
    patch.firmwareUpdateState = sql`case when ${done} then null else ${elseState} end`;
    patch.firmwareUpdateError = sql`case when ${done} then null else ${elseError} end`;
  }

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

export interface FirmwareInstruction {
  version: string;
  /**
   * For the board's OWN anti-rollback check. A rule only the server enforces
   * is a rule a compromised server can skip.
   */
  sequence: number;
  sha256: string;
  sizeBytes: number;
  signature: string;
  keyId: string;
}

/**
 * What firmware this device should be running, if any.
 *
 * Resolved only on the delivery path. A desired version whose release has
 * been deleted -- or which is not on the 'release' channel -- yields NO
 * instruction rather than a half-built one; the device simply does not
 * update, which is the safe direction.
 */
export async function readFirmwareInstruction(
  deviceId: string,
): Promise<FirmwareInstruction | null> {
  const [row] = await getDb()
    .select({
      want: devices.desiredFirmwareVersion,
      version: firmwareReleases.version,
      sequence: firmwareReleases.sequence,
      sha256: firmwareReleases.sha256,
      sizeBytes: firmwareReleases.sizeBytes,
      signature: firmwareReleases.signature,
      keyId: firmwareReleases.signingKeyId,
      signatureFormat: firmwareReleases.signatureFormat,
    })
    .from(devices)
    .leftJoin(firmwareReleases, eq(firmwareReleases.version, devices.desiredFirmwareVersion))
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!row?.want || row.version === null) return null;
  // Only a format-2 signature covers the manifest (spec D4); a format-1
  // release cannot be verified by the board and must never be offered.
  if (row.signatureFormat !== 2) return null;
  return {
    version: row.version,
    sequence: row.sequence!,
    sha256: row.sha256!,
    sizeBytes: row.sizeBytes!,
    signature: row.signature!,
    keyId: row.keyId!,
  };
}
