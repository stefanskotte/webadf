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
 * module never looks inside it.
 */
export async function saveDisplay(
  orgId: string,
  deviceId: string,
  panel: '128x32' | '128x64',
  blob: Uint8Array | null,
): Promise<SaveDisplayOutcome> {
  const db = getDb();
  const scope = and(eq(devices.id, deviceId), eq(devices.orgId, orgId));
  const [row] = await db.update(devices)
    .set({
      displayPanel: panel,
      displayLayout: blob,
      displayVersion: sql`${devices.displayVersion} + 1`,
      // A new version has not been judged yet: the old rejection reason
      // would read as "The board rejected it" for a layout it has not seen.
      displayError: null,
    })
    .where(and(scope, eq(devices.displayLayouts, true)))
    .returning({ version: devices.displayVersion });
  if (row) return { version: row.version };

  const [exists] = await db.select({ id: devices.id }).from(devices).where(scope).limit(1);
  return exists ? 'firmware_too_old' : 'not_found';
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
