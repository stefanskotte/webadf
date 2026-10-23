import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';

/**
 * What each drive of a board holds right now, for Undo in the mount toast (A3): DF0's confirmed disk and DF1's pick
 * (null = empty / following the set). The mount route reads it before writing and hands the one for its drive back.
 * Null when the board is not this org's -- the mount itself then answers 404.
 */
export async function drivesBefore(orgId: string, deviceId: string): Promise<{ df0: string | null; df1: string | null } | null> {
  const [row] = await getDb()
    .select({ df0: devices.mountedDiskId, df1: devices.df1DiskId })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
    .limit(1);
  return row ?? null;
}
