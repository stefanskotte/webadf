import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { disks, games } from '@/db/schema/catalog';
import { setDesired } from '@/lib/mount';
import { decideTap, type TapOutcome } from '@/lib/nfc/rules';

/**
 * One tap, end to end (spec §5.2). The org is the caller's -- the device's
 * token -- and setDesired scopes the disk to it, so a foreign id and an
 * unknown one both come back not_found (D4).
 */
export async function tapDevice(
  deviceId: string, orgId: string, diskId: string, now: Date,
): Promise<{ outcome: TapOutcome; title?: string }> {
  const db = getDb();
  const [row] = await db.select({ desiredDiskId: devices.desiredDiskId, lastTapAt: devices.lastTapAt })
    .from(devices).where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId))).limit(1);
  if (!row) return { outcome: 'not_found' };

  const decision = decideTap(row, diskId, now);
  // An ignored tap is NOT recorded: recording it would move lastTapAt and let a
  // steady stream of taps hold the limit open forever.
  if (decision === 'ignored') return { outcome: 'ignored' };

  let outcome: TapOutcome = 'already';
  if (decision === 'mount') {
    const r = await setDesired(orgId, deviceId, diskId);
    outcome = r.ok ? 'mounting' : r.reason === 'track_too_long' ? 'too_long' : 'not_found';
  }
  await db.update(devices).set({ lastTapAt: now, lastTapOutcome: outcome })
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)));

  if (outcome !== 'mounting' && outcome !== 'already') return { outcome };
  const [t] = await db.select({ title: games.title }).from(disks)
    .innerJoin(games, eq(games.id, disks.gameId))
    .where(and(eq(disks.id, diskId), eq(disks.orgId, orgId))).limit(1);
  return t ? { outcome, title: t.title } : { outcome };
}

/**
 * The write-request columns plus the disk's title, for the poll payload.
 *
 * `title` comes back RAW (unbounded) -- the poll route is the one that
 * bounds it to DC_TITLE_MAX before it goes on the wire, the same way
 * readDesired (mount.ts) bounds `game`. See the comment there for why.
 */
export async function readNfcWriteRow(deviceId: string) {
  const [r] = await getDb().select({
    nfcWriteSeq: devices.nfcWriteSeq, nfcWriteDiskId: devices.nfcWriteDiskId,
    nfcWriteExpiresAt: devices.nfcWriteExpiresAt, nfcWriteResultSeq: devices.nfcWriteResultSeq,
    title: games.title,
  }).from(devices)
    .leftJoin(disks, and(eq(disks.id, devices.nfcWriteDiskId), eq(disks.orgId, devices.orgId)))
    .leftJoin(games, eq(games.id, disks.gameId))
    .where(eq(devices.id, deviceId)).limit(1);
  return r ?? null;
}
