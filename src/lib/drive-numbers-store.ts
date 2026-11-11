import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { saveSecondDrive } from '@/lib/second-drive-store';
import type { DriveBase } from '@/lib/drive-numbers';

/**
 * Saves which DF numbers the board's drives are (src/lib/drive-numbers.ts). Nothing is sent to the board for the
 * numbers themselves. DF3 switches the second drive Off in the same request (through saveSecondDrive, so the board
 * hears it and a disk mounted into it goes): there is no DF4.
 */
export async function saveDriveBase(orgId: string, deviceId: string, base: DriveBase): Promise<'ok' | 'not_found'> {
  const db = getDb();
  const scope = and(eq(devices.id, deviceId), eq(devices.orgId, orgId));
  const [row] = await db.update(devices).set({ driveBase: base }).where(scope)
    .returning({ secondDrive: devices.secondDrive, capable: devices.secondDriveCapable });
  if (!row) return 'not_found';
  if (base === 3 && row.secondDrive !== 'off' && row.capable === true) {
    await saveSecondDrive(orgId, deviceId, 'off', false);
  }
  return 'ok';
}
