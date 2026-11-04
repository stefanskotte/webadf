import { and, eq, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { firmwareAtLeastSql } from '@/lib/display-store';
import { BOOT_DISK_FW, type BootDisk, type BootReport } from '@/lib/boot-disk';

/**
 * The SET half of the one UPDATE that decides a boot (Disk at startup, see boot-disk.ts). Every expression reads the
 * row's PRE-image under one lock, so a boot is acted on exactly once however many requests carry it:
 *   - `fresh`: the id is neither the stored boot nor the one before it -- the first request of a NEW boot. A late
 *     request from the previous boot (its id is prev_boot_id) is ignored: it neither clears nor moves the ids back.
 *   - DF0 is emptied only on a fresh boot that FOLLOWS a known one (boot_id not null): the first id ever heard from a
 *     board is a baseline, recorded only -- the reboot that installs 1.18.1 runs older firmware's code, which writes
 *     no update mark, and must never be what empties DF0. Then: on "No disk", not an update's reboot, and with a disk
 *     desired -- the same columns and version bump as clearDesired, so the boot's first poll answers with no disk.
 * A reconnect, a server restart or a retried request carries the stored id: nothing moves. DF1 is not touched.
 *
 * A fresh boot also offers again an update still asked for. A board keeps an offer in RAM only, and the server has its ack
 * (acks only rise), so a reboot before the flash left it waiting for an offer that never came, the card on "Requested"
 * until a cancel and a new request moved the cursor (Pillock 2026-11-04). Not on an update's reboot, nor from 'applying' or
 * 'failed': there the board has its own report to make, and a release that reverted must not be flashed again.
 */
export function bootPatch(boot: BootReport): PgUpdateSetSource<typeof devices> {
  const fresh = sql`(${devices.bootId} is distinct from ${boot.id} and ${devices.prevBootId} is distinct from ${boot.id})`;
  const empty = sql`(${fresh} and ${devices.bootId} is not null and ${devices.bootDisk} = 'empty'
    and ${boot.ota ? sql`false` : sql`true`} and ${devices.desiredSha256} is not null)`;
  const reoffer = sql`(${fresh} and ${boot.ota ? sql`false` : sql`true`} and ${devices.desiredFirmwareVersion} is not null
    and ${devices.firmwareUpdateState} is distinct from 'applying' and ${devices.firmwareUpdateState} is distinct from 'failed')`;
  const clear = <T>(col: T) => sql`case when ${empty} then null else ${col} end`;
  return {
    firmwareInstructionVersion: sql`case when ${reoffer} then ${devices.firmwareInstructionVersion} + 1 else ${devices.firmwareInstructionVersion} end`,
    bootId: sql`case when ${fresh} then ${boot.id} else ${devices.bootId} end`,
    prevBootId: sql`case when ${fresh} then ${devices.bootId} else ${devices.prevBootId} end`,
    desiredSha256: clear(devices.desiredSha256),
    desiredGameId: clear(devices.desiredGameId),
    desiredDiskNo: clear(devices.desiredDiskNo),
    desiredDiskId: clear(devices.desiredDiskId),
    desiredSetAt: sql`case when ${empty} then now() else ${devices.desiredSetAt} end`,
    desiredVersion: sql`case when ${empty} then ${devices.desiredVersion} + 1 else ${devices.desiredVersion} end`,
  };
}

/** The tap's call (the poll's is touchLastSeen, which carries the same patch): decide the boot, before the tap mounts. */
export async function noteBoot(deviceId: string, boot: BootReport): Promise<void> {
  await getDb().update(devices)
    .set({ lastSeenAt: new Date(), ...bootPatch(boot) })
    .where(eq(devices.id, deviceId));
}

/**
 * One org-scoped conditional UPDATE (the saveDisplay pattern): "No disk" needs the firmware that names its boot, by
 * the REPORTED version, in the WHERE -- a report landing between a read and the write cannot slip it through. "Last
 * disk" is what every board does anyway and is never refused.
 */
export async function saveBootDisk(
  orgId: string, deviceId: string, mode: BootDisk,
): Promise<'ok' | 'not_found' | 'firmware_too_old'> {
  const db = getDb();
  const scope = and(eq(devices.id, deviceId), eq(devices.orgId, orgId));
  const [row] = await db.update(devices)
    .set({ bootDisk: mode })
    .where(and(scope, mode === 'empty' ? firmwareAtLeastSql(BOOT_DISK_FW) : sql`true`))
    .returning({ id: devices.id });
  if (row) return 'ok';
  const [owned] = await db.select({ id: devices.id }).from(devices).where(scope).limit(1);
  return owned ? 'firmware_too_old' : 'not_found';
}
