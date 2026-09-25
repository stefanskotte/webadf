import { createHash } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { disks, games } from '@/db/schema/catalog';
import { deviceState, isOnline, relative } from '@/lib/device-state';

/**
 * What every open browser watches to know when to re-render (spec
 * 2026-09-19-live-device-state-design.md). Covers exactly what the pages show
 * about devices and the disks they hold: a change here means some page would
 * render differently, and nothing else changes it.
 */
export interface LiveStateRow {
  id: string; name: string;
  desiredDiskId: string | null; desiredSha256: string | null; desiredVersion: number;
  mountedDiskId: string | null; mountedSha256: string | null; mountedVersion: number | null;
  lastSeenAt: Date | null;
  diskSha256: string | null; diskWriteProtected: boolean | null;
  // The MOUNTED disk's write-protect, distinct from `diskWriteProtected`
  // above (which is the DESIRED disk's -- what a board is about to be told to
  // hold, not what it already does). The Devices card's bottom tag reads this
  // one, and a flip must reach every open tab the same way a mount does.
  mountedDiskWriteProtected: boolean | null;
  firmwareVersion: string | null;
  // What the Devices tab renders about an update in flight. Increment 1
  // shipped with exactly this gap for the release registry and it had to be
  // fixed in review -- a page input that is not in the fingerprint is a page
  // that silently stops updating itself.
  desiredFirmwareVersion: string | null;
  firmwareUpdateState: string | null;
  // Also page inputs, and also missed the first time: updateProtocol decides
  // whether a checkbox is drawn at all, and firmwareUpdateError is rendered
  // verbatim in the "update failed -- <reason>" line.
  updateProtocol: number | null;
  firmwareUpdateError: string | null;
  lastError: string | null; lastErrorAt: Date | null;
  // What the header's drive chips (DriveChips) render about the MOUNTED disk
  // -- the one the board reported, never the one it was asked for -- plus
  // the desired disk's title for the "loading <title>…" line while a mount
  // is in flight. The layout renders the chips straight from these rows on
  // every page, so each of them is a page input and has to be in the
  // fingerprint below: a rename of the mounted game, or an HFE arriving in
  // place of an ADF, must reach every open tab like a mount does.
  mountedGameId: string | null;
  mountedGameTitle: string | null;
  mountedDiskNo: number | null;
  /** How many disks the mounted disk's game has -- "disk 2" is only worth saying on a multi-disk game. */
  mountedDiskCount: number | null;
  mountedImageFormat: string | null;
  desiredGameTitle: string | null;
  /** Only to recognise the default "Device <MAC>" name, which the chip shortens. */
  macAddress: string | null;
}

/**
 * First 16 hex of a sha-256 over one canonical line per device, ordered by id.
 * `lastSeenAt` itself is NOT in it -- it moves every poll -- only what the
 * pages actually render from it: the online/offline boundary (DevicesPage's
 * header count), and, for any OFFLINE device, the exact "Nm ago" text its
 * card's "last seen" line shows (DeviceCard). That line is not limited to a
 * device stuck 'stale' -- fix round 1 made it render for EVERY offline card
 * (empty and converged included), so the fingerprint has to track the same
 * set or an offline empty/converged card freezes at whatever "Nm ago" it
 * first rendered. Both are derived facts that change only when they would
 * change what is on screen, not every time the clock ticks.
 */
export function liveFingerprint(
  rows: readonly LiveStateRow[],
  now: number,
  /**
   * The newest release's sequence, or 0 when nothing is published.
   *
   * /devices renders the firmware verdict from TWO inputs -- the device's
   * reported version (above) and the registry -- and only the first was in
   * here. Publishing a release therefore changed what every open Devices tab
   * should show while leaving the fingerprint identical, so the callout only
   * appeared on a manual reload.
   *
   * REQUIRED, deliberately. It shipped with `= 0`, and the app layout kept
   * calling with two arguments -- so the server-seeded baseline was hashed
   * with 0 while every poll hashed the real sequence, and no two ever matched
   * once a release existed. Every idle tab refreshed itself forever. A
   * default parameter is an ignored input: it lets a stale call site compile
   * and be wrong.
   */
  latestReleaseSequence: number,
): string {
  const lines = [...rows]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => {
      const state = deviceState(r, now);
      return [
        r.id, r.desiredDiskId ?? '', r.desiredSha256 ?? '', r.desiredVersion,
        r.mountedDiskId ?? '', r.mountedSha256 ?? '', r.mountedVersion ?? '', state,
        r.diskSha256 ?? '', r.diskWriteProtected === null ? '' : String(r.diskWriteProtected),
        r.mountedDiskWriteProtected === null ? '' : String(r.mountedDiskWriteProtected), r.name,
        r.firmwareVersion ?? '',
        r.desiredFirmwareVersion ?? '', r.firmwareUpdateState ?? '',
        r.updateProtocol ?? '', r.firmwareUpdateError ?? '',
        r.lastError ?? '', r.lastErrorAt?.toISOString() ?? '',
        // The drive chips' inputs (see LiveStateRow).
        r.mountedGameId ?? '', r.mountedGameTitle ?? '', r.mountedDiskNo ?? '',
        r.mountedDiskCount ?? '', r.mountedImageFormat ?? '', r.desiredGameTitle ?? '',
        r.macAddress ?? '',
        isOnline(r.lastSeenAt, now) ? '1' : '0',
        // Every offline card, not just 'stale' -- see the doc comment above.
        isOnline(r.lastSeenAt, now) ? '' : relative(r.lastSeenAt, now),
      ].join('|');
    });
  return createHash('sha256')
    .update(`${lines.length}\n${latestReleaseSequence}\n${lines.join('\n')}`)
    .digest('hex')
    .slice(0, 16);
}

export async function liveStateRows(db: ReturnType<typeof getDb>, orgId: string): Promise<LiveStateRow[]> {
  // A second alias of `disks`, keyed on mountedDiskId rather than
  // desiredDiskId -- the same reasoning as listDevices' own mountedDisk join
  // (src/lib/queries.ts): a device's desired and mounted disks are frequently
  // different rows, and this fingerprint has to notice a write-protect flip
  // on EITHER one.
  const mountedDisk = alias(disks, 'mounted_disk');
  // The two games behind those two disks, for the drive chips' titles.
  // Reached THROUGH the disk rows rather than devices.mountedGameId /
  // desiredGameId: mountedDiskId is the exact row the board reported, and
  // (gameId, diskNo) is not unique, so going via the disk keeps the title,
  // the number and the write-protect all describing one and the same row.
  const mountedGame = alias(games, 'mounted_game');
  const desiredGame = alias(games, 'desired_game');

  return db
    .select({
      id: devices.id, name: devices.name,
      desiredDiskId: devices.desiredDiskId, desiredSha256: devices.desiredSha256,
      desiredVersion: devices.desiredVersion,
      mountedDiskId: devices.mountedDiskId,
      mountedSha256: devices.mountedSha256, mountedVersion: devices.mountedVersion,
      lastSeenAt: devices.lastSeenAt,
      diskSha256: disks.sha256, diskWriteProtected: disks.writeProtected,
      mountedDiskWriteProtected: mountedDisk.writeProtected,
      firmwareVersion: devices.firmwareVersion,
      desiredFirmwareVersion: devices.desiredFirmwareVersion,
      firmwareUpdateState: devices.firmwareUpdateState,
      updateProtocol: devices.updateProtocol,
      firmwareUpdateError: devices.firmwareUpdateError,
      lastError: devices.lastError, lastErrorAt: devices.lastErrorAt,
      mountedGameId: mountedDisk.gameId,
      mountedGameTitle: mountedGame.title,
      mountedDiskNo: mountedDisk.diskNo,
      // Null (not 0) when the join found no disk, so "nothing to count" never
      // reads as "a game with no disks". Org-scoped like every join here.
      mountedDiskCount: sql<number | null>`(
        select case when ${mountedDisk.gameId} is null then null else count(*)::int end
        from disks dc
        where dc.game_id = ${mountedDisk.gameId} and dc.org_id = ${orgId}
      )`,
      mountedImageFormat: mountedDisk.imageFormat,
      desiredGameTitle: desiredGame.title,
      macAddress: devices.macAddress,
    })
    .from(devices)
    // Org-scoped on both sides of both joins: without `disks.orgId`, a
    // `desiredDiskId`/`mountedDiskId` that somehow named a disk row in
    // another org (it never should, but nothing at the type level prevents
    // it) would join in that other org's `sha256`/`writeProtected` into THIS
    // org's fingerprint.
    .leftJoin(disks, and(eq(disks.id, devices.desiredDiskId), eq(disks.orgId, orgId)))
    .leftJoin(mountedDisk, and(eq(mountedDisk.id, devices.mountedDiskId), eq(mountedDisk.orgId, orgId)))
    .leftJoin(mountedGame, and(eq(mountedGame.id, mountedDisk.gameId), eq(mountedGame.orgId, orgId)))
    .leftJoin(desiredGame, and(eq(desiredGame.id, disks.gameId), eq(desiredGame.orgId, orgId)))
    .where(eq(devices.orgId, orgId))
    .orderBy(asc(devices.id));
}
