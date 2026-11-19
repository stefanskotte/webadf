import { and, eq, ne } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { saveSecondDrive } from '@/lib/second-drive-store';
import type { DriveBase } from '@/lib/drive-numbers';

/**
 * Saves which DF numbers the board's drives are (src/lib/drive-numbers.ts). Nothing is sent to the board for the
 * numbers themselves. DF3 switches the second drive Off in the same request (through saveSecondDrive, so the board
 * hears it and a disk mounted into it goes): there is no DF4.
 *
 * Refused while the original drive is in use (src/lib/orig-drive.ts): it is DF0 and the board DF1 + DF2, which the
 * board's status set (recordStatus) and sets back when it stops. The guard is in the WHERE, so a status landing
 * between a read and this write cannot be overwritten.
 */
export async function saveDriveBase(
  orgId: string, deviceId: string, base: DriveBase,
): Promise<'ok' | 'not_found' | 'orig_drive_active'> {
  const db = getDb();
  const scope = and(eq(devices.id, deviceId), eq(devices.orgId, orgId));
  const [row] = await db.update(devices).set({ driveBase: base }).where(and(scope, ne(devices.origDriveActive, true)))
    .returning({ secondDrive: devices.secondDrive, capable: devices.secondDriveCapable });
  if (!row) {
    const [r] = await db.select({ active: devices.origDriveActive }).from(devices).where(scope).limit(1);
    return r ? 'orig_drive_active' : 'not_found';
  }
  if (base === 3 && row.secondDrive !== 'off' && row.capable === true) {
    await saveSecondDrive(orgId, deviceId, 'off', false);
  }
  return 'ok';
}
