import { and, eq, or, sql, isNull, ne } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { firmwareAtLeastSql } from '@/lib/display-store';
import { SECOND_DRIVE_NET_FW, secondDriveRefusal, type SaveSecondDriveOutcome, type SecondDriveMode } from '@/lib/second-drive';

/**
 * One org-scoped conditional UPDATE (the saveDisplay pattern): the capability and
 * the df1Seen guard live in the WHERE, so a report landing between a read and a
 * write cannot slip a refused setting through. Switching OFF is never refused.
 * The df1Seen guard and the override apply to Network exactly as to Next disk: both make
 * the board answer as DF1 (spec 2026-10-12 §1).
 */
export async function saveSecondDrive(
  orgId: string, deviceId: string, mode: SecondDriveMode, override: boolean,
): Promise<SaveSecondDriveOutcome> {
  const db = getDb();
  const scope = and(eq(devices.id, deviceId), eq(devices.orgId, orgId));
  const guard = mode === 'off' || override
    ? sql`true`
    : or(isNull(devices.df1Seen), ne(devices.df1Seen, true));
  const [row] = await db.update(devices)
    .set({
      secondDrive: mode,
      secondDriveVersion: sql`${devices.secondDriveVersion} + 1`,
      // DF1 any disk (spec 2026-10-14 §3.2): leaving On drops the disk mounted into DF1, in this same write. The
      // cursor moves only when there was one, so the board is woken only for a real change -- and on any save made
      // while the row says Network: a netPick board (fw 1.12.1) holds the driver disk as DF1's pick, and must hear
      // it go (or, re-saving Network, it is re-sent and is a no-op). `secondDrive` here is the row's value before
      // this write.
      ...(mode !== 'df1'
        ? {
            df1DiskId: null,
            df1Version: sql`case when ${devices.df1DiskId} is null and ${devices.secondDrive} <> 'net' then ${devices.df1Version} else ${devices.df1Version} + 1 end`,
          }
        : {
            df1Version: sql`case when ${devices.secondDrive} = 'net' then ${devices.df1Version} + 1 else ${devices.df1Version} end`,
          }),
    })
    .where(and(scope, eq(devices.secondDriveCapable, true),
      // Network needs 1.11.0 by the REPORTED version, in the same WHERE (the saveDisplay rule): a board
      // that reports an older build between a read and this write cannot take a mode it does not know.
      mode === 'net' ? firmwareAtLeastSql(SECOND_DRIVE_NET_FW) : sql`true`, guard))
    .returning({ version: devices.secondDriveVersion });
  if (row) return { version: row.version };
  const [r] = await db.select({ capable: devices.secondDriveCapable, seen: devices.df1Seen, firmwareVersion: devices.firmwareVersion })
    .from(devices).where(scope).limit(1);
  if (!r) return 'not_found';
  return secondDriveRefusal(mode, r);
}
