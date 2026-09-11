import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';

/**
 * The label a device carries until a human gives it one.
 *
 * `devices.name` is NOT NULL and has always held this, written by
 * /api/device/register from the one identifying detail the device itself
 * supplies. Naming it here rather than inlining the template twice is the
 * point: register writes it, and clearing an alias restores it, so the two
 * must agree or a "reset" would produce a label the device never had.
 *
 * The MAC is not lost by renaming -- `devices.macAddress` is its own column,
 * and the devices page shows it beside the name regardless.
 */
export function defaultDeviceName(macAddress: string | null): string {
  // A device that somehow registered without a MAC still needs a non-null
  // label, and "Device null" is not it.
  return macAddress ? `Device ${macAddress}` : 'Device';
}

/** True when `name` is just the stand-in, i.e. nobody has named this drive. */
export function isDefaultDeviceName(name: string, macAddress: string | null): boolean {
  return name === defaultDeviceName(macAddress);
}

/**
 * Set a device's alias, org-scoped. Returns false when the device is outside
 * `orgId` or does not exist -- indistinguishably, so an id from another tenant
 * reveals nothing, the same shape setDesired uses.
 *
 * An empty alias is not an error and not an empty name: it RESETS to
 * defaultDeviceName(), because `devices.name` is NOT NULL and because a drive
 * with no label at all is harder to pick out of a list than one wearing its
 * MAC. Callers pass the trimmed string; the route owns validation.
 */
export async function renameDevice(
  orgId: string, deviceId: string, alias: string,
): Promise<boolean> {
  const db = getDb();

  // Read the MAC back rather than trusting a caller to supply it: the reset
  // label has to match what register wrote, and only the row knows that.
  const owned = await db
    .select({ id: devices.id, macAddress: devices.macAddress })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
    .limit(1);
  const row = owned[0];
  if (!row) return false;

  const name = alias.trim() === '' ? defaultDeviceName(row.macAddress) : alias.trim();
  await db.update(devices).set({ name }).where(eq(devices.id, deviceId));
  return true;
}
