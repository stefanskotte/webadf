import { createHash } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
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
  firmwareVersion: string | null;
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
   * appeared on a manual reload. The sequence is monotonic and assigned at
   * publish, so it moves exactly when the registry does.
   */
  latestReleaseSequence = 0,
): string {
  const lines = [...rows]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => {
      const state = deviceState(r, now);
      return [
        r.id, r.desiredDiskId ?? '', r.desiredSha256 ?? '', r.desiredVersion,
        r.mountedDiskId ?? '', r.mountedSha256 ?? '', r.mountedVersion ?? '', state,
        r.diskSha256 ?? '', r.diskWriteProtected === null ? '' : String(r.diskWriteProtected), r.name,
        r.firmwareVersion ?? '',
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
  return db
    .select({
      id: devices.id, name: devices.name,
      desiredDiskId: devices.desiredDiskId, desiredSha256: devices.desiredSha256,
      desiredVersion: devices.desiredVersion,
      mountedDiskId: devices.mountedDiskId,
      mountedSha256: devices.mountedSha256, mountedVersion: devices.mountedVersion,
      lastSeenAt: devices.lastSeenAt,
      diskSha256: disks.sha256, diskWriteProtected: disks.writeProtected,
      firmwareVersion: devices.firmwareVersion,
      lastError: devices.lastError, lastErrorAt: devices.lastErrorAt,
    })
    .from(devices)
    // Org-scoped on both sides of the join: without `disks.orgId`, a
    // `desiredDiskId` that somehow named a disk row in another org (it never
    // should, but nothing at the type level prevents it) would join in that
    // other org's `sha256`/`writeProtected` into THIS org's fingerprint.
    .leftJoin(disks, and(eq(disks.id, devices.desiredDiskId), eq(disks.orgId, orgId)))
    .where(eq(devices.orgId, orgId))
    .orderBy(asc(devices.id));
}
