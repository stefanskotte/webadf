import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';

/**
 * Delete a paired board's row, org-scoped. Returns false when the device is
 * outside `orgId` or does not exist -- indistinguishably, like renameDevice.
 *
 * WHAT THE ONE DELETE TAKES WITH IT (audited against src/db/schema, 2026-10-09):
 *   - disk_write_sessions: FK to devices.id, ON DELETE CASCADE; its
 *     disk_write_tracks follow through their own composite cascade. An open
 *     write session's un-closed tracks are therefore dropped.
 *   - NFC write request, firmware-update instruction, desired/mounted disk,
 *     display and second-drive state are COLUMNS of the devices row itself,
 *     so they go with it; there is no separate table to clean.
 *   - pairing_codes carry no device id (org + creator only): nothing to clear.
 *
 * WHAT IT DELIBERATELY LEAVES: disk_versions.device_id is a plain text column
 * with no FK, used only as a label ("Amiga: <name>"). Disk history survives;
 * a version whose device is gone is labelled just "Amiga".
 *
 * The board's bearer token is the row's token_hash, so it stops
 * authenticating the instant this commits (every device route 401s).
 */
export async function deleteDevice(orgId: string, deviceId: string): Promise<boolean> {
  const gone = await getDb()
    .delete(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
    .returning({ id: devices.id });
  return gone.length > 0;
}
