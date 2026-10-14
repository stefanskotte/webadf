// DF1 second drive (spec docs/superpowers/research/2026-10-08-df1-second-drive.md).
import { and, eq, or, sql, isNull, ne } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { firmwareAtLeast } from '@/lib/firmware-version';
import { firmwareAtLeastSql } from '@/lib/display-store';

// Texts for the device card's readings: both values of each state, in words.

export function sel1Text(wired: boolean): string {
  return wired ? 'DF1 line: connected' : 'DF1 line: no signal yet';
}

export function df1SeenText(seen: boolean): string {
  return seen ? 'Other DF1 drive: detected' : 'Other DF1 drive: none seen';
}

export type SecondDriveMode = 'off' | 'df1' | 'net';
/** Network (PaulaNET), spec 2026-10-12 §5: the firmware that has it. */
export const SECOND_DRIVE_NET_FW = '1.11.0';

/** A stored or reported mode, or null for anything this server does not know. */
export function asSecondDriveMode(v: string | null): SecondDriveMode | null {
  return v === 'off' || v === 'df1' || v === 'net' ? v : null;
}
export type SaveSecondDriveOutcome = { version: number } | 'not_found' | 'firmware_too_old' | 'df1_seen';

export const SECOND_DRIVE_FW = '1.9.0';
export const DF1_SEEN_REASON = 'A drive already answers as DF1 on this Amiga';

/** The firmware a mode needs: 1.9.0 for the DF1 setting itself, 1.11.0 for Network (spec 2026-10-12 §5). */
export function firmwareFor(mode: SecondDriveMode): string {
  return mode === 'net' ? SECOND_DRIVE_NET_FW : SECOND_DRIVE_FW;
}

/** After a refused save: which refusal it was. The firmware first -- a seen DF1 is moot on a board that cannot. */
export function secondDriveRefusal(
  mode: SecondDriveMode, r: { capable: boolean | null; seen: boolean | null; firmwareVersion: string | null },
): 'firmware_too_old' | 'df1_seen' {
  if (r.capable !== true) return 'firmware_too_old';
  if (mode === 'net' && !firmwareAtLeast(r.firmwareVersion, SECOND_DRIVE_NET_FW)) return 'firmware_too_old';
  return 'df1_seen';
}

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
      // cursor moves only when there was one, so the board is woken only for a real change.
      ...(mode !== 'df1'
        ? {
            df1DiskId: null,
            df1Version: sql`case when ${devices.df1DiskId} is null then ${devices.df1Version} else ${devices.df1Version} + 1 end`,
          }
        : {}),
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

export const DF1_ON_OLD_FIRMWARE =
  `DF1 is on, set on the board \u2014 needs firmware ${SECOND_DRIVE_FW} or newer to change`;

/**
 * What the board is doing with the setting -- never a state it is not in (final review I1, I2).
 * - Older firmware cannot take the setting. 1.8.x still honours a stored ON and reports the
 *   disk DF1 serves (df1Sha256), so a non-null digest there means DF1 is on (I2).
 * - "Set on the board" only when the board has acked this version AND reports running the
 *   chosen mode: a re-paired board acks 0 against a new row at 0 while still running DF1 (I1).
 */
export function secondDriveStatus(d: {
  secondDriveCapable: boolean; secondDriveVersion: number; secondDriveAppliedVersion: number | null;
  secondDrive: SecondDriveMode; secondDriveReported: SecondDriveMode | null; df1Sha256: string | null;
}): string {
  if (!d.secondDriveCapable) {
    return d.df1Sha256 !== null ? DF1_ON_OLD_FIRMWARE : `Needs firmware ${SECOND_DRIVE_FW} or newer`;
  }
  if (d.secondDriveAppliedVersion !== d.secondDriveVersion) return 'Waiting for the board';
  if (d.secondDriveReported !== d.secondDrive) return 'Waiting for the board';
  return 'Set on the board \u2014 takes effect when the Amiga restarts';
}
