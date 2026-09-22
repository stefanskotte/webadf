import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { listReleases } from '@/lib/firmware-releases';
import { buildRegistry } from '@/lib/firmware-state';
import { refuseTarget, type TargetRefusal } from '@/lib/firmware-update-rules';

export type BatchRefusal = { deviceId: string; name: string; reason: TargetRefusal };

export type BatchResult =
  | { ok: true; count: number }
  | { ok: false; kind: 'refused'; refusals: BatchRefusal[] }
  | { ok: false; kind: 'unknown_device' }
  | { ok: false; kind: 'unknown_version' };

/**
 * Point devices at a firmware release.
 *
 * ALL-OR-NOTHING. Every device is checked before any is written: a multi-select
 * that silently updated three of five would be the worst outcome it could have,
 * and the operator would have no way to tell which three.
 *
 * Note what is deliberately NOT a refusal: a mounted disk. Setting desired
 * firmware always succeeds, and the board applies it once nothing is mounted
 * (spec D2) -- the device enforces that itself, so the rule holds even when
 * this server is wrong about what is mounted.
 */
export async function requestFirmwareUpdate(
  orgId: string, userId: string, deviceIds: string[], version: string,
): Promise<BatchResult> {
  const db = getDb();

  const releases = await listReleases();
  const target = releases.find((r) => r.version === version);
  if (!target) return { ok: false, kind: 'unknown_version' };
  const reg = buildRegistry(releases);

  // Org-scoped in the statement. A device id alone is not enough to name a
  // device -- the same rule setDesired already follows.
  const rows = await db
    .select({
      id: devices.id, name: devices.name,
      updateProtocol: devices.updateProtocol,
      firmwareVersion: devices.firmwareVersion,
      desiredFirmwareVersion: devices.desiredFirmwareVersion,
      firmwareUpdateState: devices.firmwareUpdateState,
    })
    .from(devices)
    .where(and(eq(devices.orgId, orgId), inArray(devices.id, deviceIds)));

  // A device outside the org is indistinguishable from one that does not
  // exist. Never a 403. Compared against a de-duplicated input so a caller
  // repeating one id cannot make a legitimate batch look short.
  if (rows.length !== new Set(deviceIds).size) return { ok: false, kind: 'unknown_device' };

  const refusals: BatchRefusal[] = [];
  for (const d of rows) {
    const reason = refuseTarget(d, target, reg);
    if (reason) refusals.push({ deviceId: d.id, name: d.name, reason });
  }
  if (refusals.length > 0) return { ok: false, kind: 'refused', refusals };

  await db.update(devices)
    .set({
      desiredFirmwareVersion: target.version,
      desiredFirmwareSetAt: new Date(),
      desiredFirmwareSetByUserId: userId,
      // The cursor moves, which IS the wake. Computed column-relative so two
      // concurrent batches cannot land on the same value.
      firmwareInstructionVersion: sql`${devices.firmwareInstructionVersion} + 1`,
      firmwareUpdateState: null,
      firmwareUpdateError: null,
    })
    .where(and(eq(devices.orgId, orgId), inArray(devices.id, deviceIds)));

  return { ok: true, count: rows.length };
}

/** Stand down. No password: this is not the privileged direction. */
export async function cancelFirmwareUpdate(
  orgId: string, deviceIds: string[],
): Promise<number> {
  const rows = await getDb().update(devices)
    .set({
      desiredFirmwareVersion: null, desiredFirmwareSetAt: null,
      desiredFirmwareSetByUserId: null, firmwareUpdateState: null,
      firmwareUpdateError: null,
      // Cancelling bumps the cursor too, so a board that ALREADY acknowledged
      // the instruction is woken and learns it is withdrawn. Without this, a
      // board sitting in 'queued' waiting for an eject would never hear about
      // the cancellation and would flash the withdrawn release when the disk
      // came out -- the cancel would clear intent the operator could see and
      // not the one that mattered.
      firmwareInstructionVersion: sql`${devices.firmwareInstructionVersion} + 1`,
    })
    // Only rows that actually had something pending. Bumping the cursor on an
    // idle board arms a wake it has nothing to answer, and the returned count
    // then claims to have cancelled something that was never requested.
    .where(and(
      eq(devices.orgId, orgId),
      inArray(devices.id, deviceIds),
      isNotNull(devices.desiredFirmwareVersion),
    ))
    .returning({ id: devices.id });
  return rows.length;
}
