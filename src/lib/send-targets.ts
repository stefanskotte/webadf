import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '@/db';
import { devices } from '@/db/schema/devices';
import { disks, entitlements } from '@/db/schema/catalog';
import { firmwareAtLeast } from '@/lib/firmware-version';
import { isOnline } from '@/lib/device-state';
import { isDefaultDeviceName } from '@/lib/device-name';
import { XFER_FW } from '@/lib/send-limits';
import { orderTargets, type Rx, type SendTarget } from '@/lib/send-ui';
import { isLocal } from '@/lib/remote-hidden';

const asRx = (v: string | null): Rx | null => (v === 'c' || v === 'r' || v === 'u' || v === '-' ? v : null);

/** The boards a person may send to (spec §4, D11; R1): this org's, on XFER_FW or newer, online first. */
export async function listSendTargets(db: Db, orgId: string, now = Date.now()): Promise<SendTarget[]> {
  const rows = await db.select({
    id: devices.id, name: devices.name, macAddress: devices.macAddress, firmwareVersion: devices.firmwareVersion,
    lastSeenAt: devices.lastSeenAt, secondDriveReported: devices.secondDriveReported,
    sendRx: devices.sendRx, sendRxAt: devices.sendRxAt,
  }).from(devices).where(eq(devices.orgId, orgId)).orderBy(asc(devices.name), asc(devices.id));
  return orderTargets(rows.filter((r) => firmwareAtLeast(r.firmwareVersion, XFER_FW)).map((r) => ({
    id: r.id, name: r.name, macAddress: r.macAddress, defaultName: isDefaultDeviceName(r.name, r.macAddress),
    online: isOnline(r.lastSeenAt, now), lastSeenAt: r.lastSeenAt?.getTime() ?? null,
    network: r.secondDriveReported === 'net', rx: asRx(r.sendRx), rxAt: r.sendRxAt?.getTime() ?? null,
  })));
}

/** One target, or null for a board that is not this org's, does not exist, or cannot take files. */
export async function findSendTarget(db: Db, orgId: string, deviceId: string, now = Date.now()): Promise<SendTarget | null> {
  return (await listSendTargets(db, orgId, now)).find((t) => t.id === deviceId) ?? null;
}

export type SendDisk = { sha256: string; imageFormat: string; tosecName: string | null; sourceFilename: string | null; diskNo: number };

/**
 * A library disk through this org's entitlement, the boundary /api/disks/[id]/adf uses. A hidden remote disk only
 * with `includeHidden` (the remote Send, after it materialised the disk); otherwise it is unknown (R-6b).
 */
export async function loadSendDisk(
  db: Db, orgId: string, diskId: string, opts: { includeHidden?: boolean } = {},
): Promise<SendDisk | null> {
  const [d] = await db.select({ sha256: disks.sha256, imageFormat: disks.imageFormat, tosecName: disks.tosecName,
    sourceFilename: entitlements.sourceFilename, diskNo: disks.diskNo })
    .from(disks)
    .innerJoin(entitlements, and(eq(entitlements.sha256, disks.sha256), eq(entitlements.orgId, orgId)))
    .where(and(eq(disks.id, diskId), eq(disks.orgId, orgId), opts.includeHidden ? undefined : isLocal(disks))).limit(1);
  return d ?? null;
}
