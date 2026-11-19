import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import type { OrigDriveMode, SaveOrigDriveOutcome } from '@/lib/orig-drive';

/**
 * Original drive (src/lib/orig-drive.ts): one org-scoped conditional UPDATE (the saveSecondDrive pattern). The
 * capability lives in the WHERE, so a board without the expander never gets a setting it cannot use. The version
 * moves on every save; the poll carries it to a board that sends ?origAck=. Nothing else changes here: the board
 * takes the setting at its next power-on and says what it did in its status (recordStatus moves drive_base then).
 */
export async function saveOrigDrive(orgId: string, deviceId: string, mode: OrigDriveMode): Promise<SaveOrigDriveOutcome> {
  const db = getDb();
  const scope = and(eq(devices.id, deviceId), eq(devices.orgId, orgId));
  const [row] = await db.update(devices)
    .set({ origDrive: mode, origDriveVersion: sql`${devices.origDriveVersion} + 1` })
    .where(and(scope, eq(devices.origDriveCapable, true)))
    .returning({ version: devices.origDriveVersion });
  if (row) return { version: row.version };
  const [r] = await db.select({ capable: devices.origDriveCapable }).from(devices).where(scope).limit(1);
  return r ? 'not_capable' : 'not_found';
}
