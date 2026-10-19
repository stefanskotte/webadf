import { and, eq, sql } from 'drizzle-orm';
import type { LastBoot } from '@/lib/last-boot';
import { NFC_FAIL_RE } from '@/lib/nfc/fail';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { DC_TITLE_MAX } from '@/lib/device-limits';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { firmwareReleases } from '@/db/schema/firmware';
import { releaseVisibleToSql } from '@/lib/firmware-releases';
import { disks, entitlements, games } from '@/db/schema/catalog';
import { boardDiskLabel } from '@/lib/disk-label';
import { isHdAdf, isServable } from '@/lib/disk-format';
import { LEGACY_BOARD_TRACK_MAX_BYTES } from '@/lib/adfmfm';
import { asSecondDriveMode, type SecondDriveMode } from '@/lib/second-drive';
import { netNextRearm, netNextRearmCandidate } from '@/lib/paulanet-disk';
import { bootPatch } from '@/lib/boot-disk-store';
import type { BootReport } from '@/lib/boot-disk';

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

export type SetDesiredOutcome =
  | { ok: true; version: number }
  // not_found covers an unknown device, an unknown or unservable disk, and
  // either belonging to another org -- deliberately indistinguishable.
  // track_too_long and hd_unsupported are only ever reported for a device
  // AND disk this org owns.
  | { ok: false; reason: 'not_found' | 'track_too_long' | 'hd_unsupported' };

/**
 * Point a device at a disk. Returns the new version; not_found when either
 * the device or the disk is outside `orgId`, or the image route cannot serve
 * the disk (isServable); track_too_long when both are this org's but the
 * disk's longest track exceeds what the board's firmware holds; hd_unsupported
 * when the disk is HD and the board has not reported playsHd.
 *
 * not_found rather than a thrown error on purpose: a caller cannot tell a
 * device that belongs to someone else from one that does not exist -- and
 * cannot tell that from a disk the route will refuse.
 */
export async function setDesired(
  orgId: string, deviceId: string, diskId: string,
): Promise<SetDesiredOutcome> {
  const db = getDb();

  // Org-scoped in the statement. A disk id alone is not enough to name a disk.
  const rows = await db
    .select({
      id: disks.id, sha256: disks.sha256, gameId: disks.gameId, diskNo: disks.diskNo,
      sizeBytes: disks.sizeBytes, imageFormat: disks.imageFormat, maxTrackBits: disks.maxTrackBits,
    })
    .from(disks)
    .where(and(eq(disks.id, diskId), eq(disks.orgId, orgId)))
    .limit(1);
  const disk = rows[0];
  if (!disk) return { ok: false, reason: 'not_found' };
  // Ingest accepts anything from 1 byte to 2.5 MiB (a truncated .adf from a
  // scraped archive included), but the image route can only serve an exact
  // DD ADF or an HFE validated at ingest (isServable). A disk the route
  // cannot serve must not become mountable: without this check, mount
  // succeeds, the poll succeeds, and /api/device/image/<sha256> 500s forever
  // with nothing telling the human why the Amiga never sees a disk.
  if (!isServable(disk)) return { ok: false, reason: 'not_found' };

  // A disk with tracks longer than this board's firmware holds (an HFE with a
  // long-track format, e.g. Turrican's 13,500-byte sides) would be rejected
  // WHOLE by image_loader.c, so the board would never load anything. In the
  // UPDATE's own WHERE, not a read before it: a status report that changes
  // the board's firmware between the two cannot slip past.
  const fits = disk.maxTrackBits === null
    ? sql`true`
    : sql`coalesce(${devices.trackMaxBytes}, ${LEGACY_BOARD_TRACK_MAX_BYTES}) * 8 >= ${disk.maxTrackBits}`;
  // An HD disk goes only to a board whose firmware answers the drive-ID read
  // as HD (HD spec §4.3); anywhere else the Amiga reads it with DD geometry.
  // In the UPDATE's WHERE, like `fits`, so a status report landing between a
  // read and the write cannot slip past.
  const hd = isHdAdf(disk);
  const playsHd = hd ? eq(devices.playsHd, true) : sql`true`;

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
      // DF1 any disk (spec 2026-10-14 §3.2): mounting into DF0 the disk picked for DF1 is a move -- the pick goes
      // in this same UPDATE, and its cursor moves so the board ejects DF1. Any other DF0 mount leaves DF1 alone.
      df1DiskId: sql`case when ${devices.df1DiskId} = ${disk.id} then null else ${devices.df1DiskId} end`,
      df1Version: sql`case when ${devices.df1DiskId} = ${disk.id} then ${devices.df1Version} + 1 else ${devices.df1Version} end`,
    })
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId), fits, playsHd))
    .returning({ version: devices.desiredVersion });

  if (updated[0]) return { ok: true, version: updated[0].version };
  if (disk.maxTrackBits === null && !hd) return { ok: false, reason: 'not_found' };
  // Nothing updated: tell a board of this org that is too old apart from a
  // device that is not this org's at all (still 404 for the latter).
  const owned = await db.select({ id: devices.id }).from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId))).limit(1);
  if (owned.length === 0) return { ok: false, reason: 'not_found' };
  return { ok: false, reason: hd ? 'hd_unsupported' : 'track_too_long' };
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
  /** The NFC write-request cursor (spec §5.3): compared against the board's ?nfcAck=. */
  nfcWriteSeq: number;
  /** The display-layout cursor (OLED layouts spec §7): compared against the board's ?displayAck=. */
  displayVersion: number;
  /** The DF1 setting cursor and value: compared against the board's ?driveAck=. */
  secondDriveVersion: number;
  secondDrive: SecondDriveMode;
  /** What the board last reported running, and the setting version it had handled (pre-flight I2). */
  secondDriveReported: SecondDriveMode | null;
  secondDriveAppliedVersion: number | null;
  /** The driver disk's one-shot cursor: the setting version a body last carried it at (`next`, or `df1` for netPick). */
  netNextSentVersion: number | null;
  /** The DF1 pick's cursor (spec 2026-10-14 §4.2): compared against the board's ?df1Ack=. */
  df1Version: number;
  /** The send queue's cursor (PaulaNET Phase 4): compared against the board's ?xferAck=. */
  sendVersion: number;
  /** The Amiga's last address (R17): sent as xfer.ip. */
  netAmigaIpLast: string | null;
  /** What DF1 holds and when the Amiga's driver last read: driverDiskFor's inputs (plan 2026-10-17 R16). */
  df1Sha256: string | null;
  netDriverSeenAt: Date | null;
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
      nfcWriteSeq: devices.nfcWriteSeq,
      displayVersion: devices.displayVersion,
      secondDriveVersion: devices.secondDriveVersion,
      secondDrive: devices.secondDrive,
      secondDriveReported: devices.secondDriveReported,
      secondDriveAppliedVersion: devices.secondDriveAppliedVersion,
      netNextSentVersion: devices.netNextSentVersion,
      df1Version: devices.df1Version,
      sendVersion: devices.sendVersion,
      netAmigaIpLast: devices.netAmigaIpLast,
      df1Sha256: devices.df1Sha256,
      netDriverSeenAt: devices.netDriverSeenAt,
    })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  return row
    ? {
        ...row,
        secondDrive: asSecondDriveMode(row.secondDrive) ?? 'off',
        secondDriveReported: asSecondDriveMode(row.secondDriveReported),
      }
    : null;
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
      // The org's own name for these bytes: the label's fallback (disk-label.ts).
      sourceFilename: entitlements.sourceFilename,
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
    // On BOTH columns of the entitlement's key: on sha256 alone another
    // tenant's file name for shared bytes would reach this board's screen.
    // A primary-key lookup, and readDesired runs on delivery only (the poll
    // route calls it when something moved), never once a tick.
    .leftJoin(entitlements, and(
      eq(entitlements.sha256, disks.sha256),
      eq(entitlements.orgId, devices.orgId),
    ))
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
      // Bounded to DC_LABEL_MAX inside boardDiskLabel. Never "Disk n": the
      // firmware prints its own counter on a set, and empty is the fallback.
      label: boardDiskLabel({ label: r.label, sourceFilename: r.sourceFilename }),
      // A disk row that has gone missing is not a licence to allow writes.
      // HD follows the row like DD (HD writes spec §5.3); a board on 1.4.1
      // still holds WPROT for HD itself until it updates (§5.4).
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
    /** Board server override (fw 1.13.0+). Absent from older boards: the columns stay as they are. */
    server?: { custom: boolean; tls: 'verify' | 'noverify' };
    /** TRACK_MAX_BYTES of the firmware the board runs. Absent from builds before 2026-09-24. */
    trackMaxBytes?: number;
    /** The drive-ID responder is built in (HD spec §5.5). Absent from builds before 1.4.0. */
    playsHd?: boolean;
    /** Whether the Si512 reader answered its init on the board's last check (spec §5). */
    nfcReader?: 'present' | 'absent';
    /** The boot I2C scan (fw 1.17.0+): the addresses that answered on i2c1, [] for none. */
    i2c?: number[];
    /** The previous boot (fw 1.18.2 boot trail), on the first report of a boot. */
    lastBoot?: LastBoot;
    /** The newest failed tag event's reason (fw 1.18.2), until a report carrying it is heard. */
    nfcFail?: string;
    /** The board key's first 4 hex digits (fw 1.19.0), until a report carrying them is heard. */
    upKey?: string;
    /** What the board's idle slot holds (multi-disk spec §3.5). */
    preload?: { sha256: string; state: 'loading' | 'ready' } | null;
    /** The build renders per-board layouts (OLED layouts, 1.7.0+). */
    displayLayouts?: boolean;
    /** The board's displayAck: the highest display version it has handled, applied or rejected. */
    displayVersion?: number;
    /** Why the board rejected the layout at displayVersion; null = applied. */
    displayError?: string | null;
    /** A SEL1 select reached the board since boot (DF1 second drive, 1.7.6+). */
    sel1Wired?: boolean;
    /** A real drive stepped as DF1 while the board's own DF1 was off (1.7.6+). */
    df1Seen?: boolean;
    /** The DF1 mode the board runs (fw 1.9.0+). Absent from builds without DF1. */
    secondDrive?: SecondDriveMode;
    /** The board's driveAck: the highest DF1 setting version it has handled. */
    driveVersion?: number;
    /** What DF1 holds now (sha256), null = empty or off (fw 1.8.0+). */
    df1Sha256?: string | null;
    /** Network mode's readings (fw 1.11.0+), Network mode only (spec 2026-10-12 §4). */
    net?: { driver?: number; amigaIp?: string; framesIn?: number; framesOut?: number };
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
  if (s.server !== undefined) {
    patch.serverCustom = s.server.custom;
    patch.serverTls = s.server.tls;
  }
  if (s.error !== undefined) {
    patch.lastError = s.error;
    patch.lastErrorAt = s.error ? new Date() : null;
  }
  if (s.version !== undefined) patch.mountedVersion = s.version;
  // Absent leaves the column alone; an explicit null clears it. Same rule as
  // every other optional field here -- a partial report must never wipe a
  // value a fuller one established.
  if (s.firmwareVersion !== undefined) patch.firmwareVersion = s.firmwareVersion;
  // NOT the absent-leaves-it-alone rule: trackMaxBytes belongs to the build.
  // A report that names its firmware but carries no trackMaxBytes comes from
  // a build too old to know the field -- a board that rolled back after a
  // failed trial boot, say -- and must drop to the legacy limit rather than
  // keep the newer build's claim and be sent tracks it would reject.
  if (s.trackMaxBytes !== undefined) patch.trackMaxBytes = s.trackMaxBytes;
  else if (s.firmwareVersion !== undefined) patch.trackMaxBytes = null;
  // The same build-bound rule as trackMaxBytes: a report that names its
  // firmware but says nothing about HD comes from a build without the
  // responder (older, WF_DRIVE_ID=OFF, or a reverted trial boot), and must
  // stop being sent HD disks.
  if (s.playsHd !== undefined) patch.playsHd = s.playsHd;
  else if (s.firmwareVersion !== undefined) patch.playsHd = false;
  // Build-bound like trackMaxBytes: a report naming its firmware but silent on
  // preload is a build without the field, and must not keep a newer build's claim.
  if (s.preload !== undefined) {
    patch.preloadSha256 = s.preload?.sha256 ?? null;
    patch.preloadState = s.preload ? s.preload.state : 'none';
  } else if (s.firmwareVersion !== undefined) {
    patch.preloadSha256 = null;
    patch.preloadState = null;
  }
  // Build-bound, the same rule as playsHd: a report naming its firmware but
  // silent on display layouts is a build before 1.7.0 (or a reverted trial
  // boot), and the editor must stop offering a layout it cannot apply.
  if (s.displayLayouts !== undefined) patch.displayLayouts = s.displayLayouts;
  else if (s.firmwareVersion !== undefined) patch.displayLayouts = false;
  // Plain assignment, NOT greatest(): the board's ack can legitimately go
  // DOWN -- a re-paired board resets it to 0 when the poll's displayVersion
  // is below it (device_client.c) -- and this column is what the editor's
  // "Applied on the board" compares with display_version.
  if (s.displayVersion !== undefined) patch.displayAppliedVersion = s.displayVersion;
  if (s.displayError !== undefined) patch.displayError = s.displayError;
  // Build-bound, the playsHd rule: a report naming its firmware but silent on
  // SEL1 comes from a build before 1.7.6 (or a reverted trial) -- no reading.
  if (s.sel1Wired !== undefined) patch.sel1Wired = s.sel1Wired;
  else if (s.firmwareVersion !== undefined) patch.sel1Wired = null;
  if (s.df1Seen !== undefined) patch.df1Seen = s.df1Seen;
  else if (s.firmwareVersion !== undefined) patch.df1Seen = null;
  // Build-bound (the playsHd rule): silent on secondDrive with a firmwareVersion = a build without DF1.
  if (s.secondDrive !== undefined) { patch.secondDriveCapable = true; patch.secondDriveReported = s.secondDrive; }
  else if (s.firmwareVersion !== undefined) { patch.secondDriveCapable = false; patch.secondDriveReported = null; }
  // Plain assignment: a re-paired board's ack can go down (the displayVersion rule).
  if (s.driveVersion !== undefined) patch.secondDriveAppliedVersion = s.driveVersion;
  if (s.df1Sha256 !== undefined) patch.df1Sha256 = s.df1Sha256;
  else if (s.firmwareVersion !== undefined && s.secondDrive === undefined) patch.df1Sha256 = null;
  // Build-bound (the playsHd rule): a report naming its firmware without `net` is a board not in Network
  // mode (or older), and the checklist must not keep a Network reading (plan 2026-10-12 ruling 14).
  // netDriverSeenAt is the exception while the board is in Network mode (plan 2026-10-17 R16, fix round 1): a report
  // without `driver` (the driver not heard since this boot -- an OTA trial boot, say, under a running Amiga) leaves
  // the last reading, so driverDiskFor does not swap DF1 under a driver that is still running. Only an explicit age
  // moves it; leaving Network mode still clears it.
  if (s.net !== undefined) {
    if (s.net.driver !== undefined) patch.netDriverSeenAt = new Date(Date.now() - s.net.driver * 1000);
    patch.netAmigaIp = s.net.amigaIp ?? null;
    // R17: kept across reports that lack it (a rebooted board knows none until the Amiga transmits).
    if (s.net.amigaIp && /^\d{1,3}(\.\d{1,3}){3}$/.test(s.net.amigaIp)) patch.netAmigaIpLast = s.net.amigaIp;
    patch.netFramesIn = s.net.framesIn ?? null;
    patch.netFramesOut = s.net.framesOut ?? null;
  } else if (s.firmwareVersion !== undefined) {
    if (s.secondDrive !== 'net') patch.netDriverSeenAt = null;
    patch.netAmigaIp = null;
    patch.netFramesIn = null;
    patch.netFramesOut = null;
  }
  // Plain absent-leaves-it-alone, unlike trackMaxBytes above: the reader's
  // presence is not tied to the firmware build, so there is no "drop to a
  // legacy default" case here -- a report that omits it simply has nothing
  // new to say about the reader.
  if (s.nfcReader !== undefined) patch.nfcReader = s.nfcReader;
  // Build-bound (the playsHd rule): a report naming its firmware without a scan is a build that does not send
  // one (older, or a reverted trial boot), and the card must not keep a newer build's list.
  // Once-a-boot / once-a-failure telemetry (fw 1.18.2): stored when sent, never cleared by a report without it.
  if (s.lastBoot !== undefined) {
    patch.lastBoot = s.lastBoot;
    patch.lastBootAt = new Date();
    console.info(`[device ${deviceId}] previous boot: ${JSON.stringify(s.lastBoot)}`);
  }
  // The route already checked the shape (NFC_FAIL_RE); checked again here, the store's own guard, before the log.
  if (s.nfcFail !== undefined && NFC_FAIL_RE.test(s.nfcFail)) {
    patch.nfcLastFail = s.nfcFail;
    patch.nfcLastFailAt = new Date();
    console.info(`[device ${deviceId}] tag failure: ${s.nfcFail}`);
  }
  // fw 1.19.0 (spec 2026-10-18 §6): stored when sent, never cleared by a report without it (it rides until heard).
  if (s.upKey !== undefined && /^[0-9a-f]{4}$/.test(s.upKey)) patch.upKey = s.upKey;
  if (s.i2c !== undefined) patch.i2cAddrs = s.i2c;
  else if (s.firmwareVersion !== undefined) patch.i2cAddrs = null;
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

  // Task 8 review I1: re-arm the poll's driver-disk wake after a lost response (netNextRearm says when). Read
  // only for a Network report whose DF1 lacks the disk; written as a compare-and-set in this one UPDATE, so a
  // cursor the poll moved since the read (it just sent the disk again) is left alone.
  if (netNextRearmCandidate(s)) {
    const [row] = await db
      .select({
        secondDrive: devices.secondDrive, secondDriveVersion: devices.secondDriveVersion,
        netNextSentVersion: devices.netNextSentVersion, netNextRearmedAt: devices.netNextRearmedAt,
      })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);
    const now = new Date();
    if (row && row.netNextSentVersion !== null && netNextRearm(row, s, now)) {
      const same = sql`${devices.netNextSentVersion} = ${row.netNextSentVersion} and ${devices.secondDriveVersion} = ${row.secondDriveVersion}`;
      patch.netNextSentVersion = sql`case when ${same} then null else ${devices.netNextSentVersion} end`;
      patch.netNextRearmedAt = sql`case when ${same} then ${now.toISOString()}::timestamptz else ${devices.netNextRearmedAt} end`;
    }
  }

  await db.update(devices).set(patch).where(eq(devices.id, deviceId));
}

/**
 * Touch last_seen_at alone. Called once per poll request, right after auth
 * succeeds -- the poll is the only contact a device is guaranteed to make
 * every ~25 s, so a device polling happily whose status POST is failing must
 * still read as recently seen, not as vanished hardware.
 */
export async function touchLastSeen(deviceId: string, boot?: BootReport | null): Promise<void> {
  // Disk at startup: the boot rides this same write (bootPatch) -- still one statement per poll -- and lands
  // before the hold's first tick reads the desired disk.
  await getDb().update(devices)
    .set({ lastSeenAt: new Date(), ...(boot ? bootPatch(boot) : {}) })
    .where(eq(devices.id, deviceId));
}

/**
 * Records that a poll body carried the driver disk (as `next`, or as `df1` to a netPick board) at this setting
 * version (pre-flight I2), so the hold stops waking for it. Single column, like touchLastSeen; written only on the delivery path.
 */
export async function markNetNextSent(
  deviceId: string, secondDriveVersion: number, opts: { bumpDf1?: boolean } = {},
): Promise<void> {
  await getDb().update(devices)
    // bumpDf1 (fw 1.12.1, netPick): the driver disk goes out as DF1's pick, so its first body moves df1_version in
    // the same write -- the board's df1Ack then differs, and a body lost in transit is re-sent by the re-arm.
    .set({ netNextSentVersion: secondDriveVersion,
      ...(opts.bumpDf1 ? { df1Version: sql`${devices.df1Version} + 1` } : {}) })
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
    // A `+e2e` release only joins for a board in a test org (releaseVisibleToSql): a real board is never
    // offered one, even if a desired version somehow named it.
    .leftJoin(firmwareReleases, and(
      eq(firmwareReleases.version, devices.desiredFirmwareVersion), releaseVisibleToSql(devices.orgId)))
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
