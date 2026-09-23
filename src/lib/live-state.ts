import { createHash } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { disks } from '@/db/schema/catalog';
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
}

/**
 * First 16 hex of a sha-256 over one canonical line per device, ordered by id.
 * `lastSeenAt` itself is NOT in it -- it moves every poll -- only what the
 * pages actually render from it: the online/offline boundary (DevicesPage's
 * header count), and, for a device stuck 'stale', the exact "Nm ago" text a
 * card shows (DeviceCard). Both are derived facts that change only when they
 * would change what is on screen, not every time the clock ticks.
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
        isOnline(r.lastSeenAt, now) ? '1' : '0',
        state === 'stale' ? relative(r.lastSeenAt, now) : '',
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
    })
    .from(devices)
    // Org-scoped on both sides of both joins: without `disks.orgId`, a
    // `desiredDiskId`/`mountedDiskId` that somehow named a disk row in
    // another org (it never should, but nothing at the type level prevents
    // it) would join in that other org's `sha256`/`writeProtected` into THIS
    // org's fingerprint.
    .leftJoin(disks, and(eq(disks.id, devices.desiredDiskId), eq(disks.orgId, orgId)))
    .leftJoin(mountedDisk, and(eq(mountedDisk.id, devices.mountedDiskId), eq(mountedDisk.orgId, orgId)))
    .where(eq(devices.orgId, orgId))
    .orderBy(asc(devices.id));
}
