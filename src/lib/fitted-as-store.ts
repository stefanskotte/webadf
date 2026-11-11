import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { saveSecondDrive } from '@/lib/second-drive-store';
import type { FittedAs } from '@/lib/fitted-as';

/**
 * Saves where the board is fitted (src/lib/fitted-as.ts). Nothing is sent to the board for the setting itself.
 * External switches the second drive Off in the same request (through saveSecondDrive, so the board hears it and a
 * disk mounted into DF1 goes), because in an external case its second-drive line is not connected.
 */
export async function saveFittedAs(orgId: string, deviceId: string, fittedAs: FittedAs): Promise<'ok' | 'not_found'> {
  const db = getDb();
  const scope = and(eq(devices.id, deviceId), eq(devices.orgId, orgId));
  const [row] = await db.update(devices).set({ fittedAs }).where(scope)
    .returning({ secondDrive: devices.secondDrive, capable: devices.secondDriveCapable });
  if (!row) return 'not_found';
  if (fittedAs === 'external' && row.secondDrive !== 'off' && row.capable === true) {
    await saveSecondDrive(orgId, deviceId, 'off', false);
  }
  return 'ok';
}
