import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';

export type SaveDisplayOutcome = { version: number } | 'not_found' | 'firmware_too_old';

/**
 * Store a board's display panel and layout (OLED layouts spec §7) and raise
 * its display cursor, in ONE org-scoped conditional UPDATE. `blob` null means
 * the panel's built-in default (a reset).
 *
 * The capability gate is in the same WHERE clause, not a read before it: a
 * board that reports an older build between a read and a write must not be
 * left holding a layout cursor it can never acknowledge. Only when no row
 * comes back does a second read decide which refusal it was -- and that read
 * is org-scoped too, so another org's device is indistinguishable from none.
 *
 * The blob arrives already validated by the board's own C validator; this
 * module never looks inside it. The caller does, for one thing: a layout that
 * lists an element older firmware does not know (the 'nfc' element, 1.10.0)
 * passes `minFirmware`, and the board's REPORTED version must be at least
 * that -- in the same WHERE, for the same reason as the capability.
 */
export async function saveDisplay(
  orgId: string,
  deviceId: string,
  panel: '128x32' | '128x64',
  blob: Uint8Array | null,
  minFirmware?: string,
): Promise<SaveDisplayOutcome> {
  const db = getDb();
  const scope = and(eq(devices.id, deviceId), eq(devices.orgId, orgId));
  const gate = minFirmware
    ? and(eq(devices.displayLayouts, true), firmwareAtLeastSql(minFirmware))
    : eq(devices.displayLayouts, true);
  const [row] = await db.update(devices)
    .set({
      displayPanel: panel,
      displayLayout: blob,
      displayVersion: sql`${devices.displayVersion} + 1`,
      // A new version has not been judged yet: the old rejection reason
      // would read as "The board rejected it" for a layout it has not seen.
      displayError: null,
    })
    .where(and(scope, gate))
    .returning({ version: devices.displayVersion });
  if (row) return { version: row.version };

  const [exists] = await db.select({ id: devices.id }).from(devices).where(scope).limit(1);
  return exists ? 'firmware_too_old' : 'not_found';
}

/**
 * `firmware_version >= min` by its semver half, numerically (firmware-version.ts
 * firmwareAtLeast in SQL). The CASE keeps the int[] cast away from a version
 * without the `x.y.z+` shape -- which, like a NULL, compares as not new enough.
 */
export function firmwareAtLeastSql(min: string) {
  const want = min.split('.').map((n) => Number.parseInt(n, 10));
  if (want.length !== 3 || want.some((n) => !Number.isInteger(n) || n < 0)) throw new Error(`bad version ${min}`);
  return sql`(case when ${devices.firmwareVersion} ~ '^[0-9]+[.][0-9]+[.][0-9]+[+]'
    then string_to_array(split_part(${devices.firmwareVersion}, '+', 1), '.')::int[] end)
    >= array[${sql.raw(want.join(','))}]::int[]`;
}

/**
 * What GET /api/device/display sends. Not org-scoped: the caller is the device
 * itself, already authenticated to exactly this row by requireDevice().
 */
export async function readDisplay(
  deviceId: string,
): Promise<{ version: number; panel: string; layout: Uint8Array | null } | null> {
  const [row] = await getDb()
    .select({ version: devices.displayVersion, panel: devices.displayPanel, layout: devices.displayLayout })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  return row ?? null;
}
