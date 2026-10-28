// The mount step as the person's routes answer it: POST /api/devices/[id]/mount and the remote libraries' Mount
// (POST /api/remote/[id]/disks/[diskId]/mount) give the same JSON for the same outcome. SERVER ONLY.
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { drivesBefore } from '@/lib/mount-undo';
import { setDesired } from '@/lib/mount';
import { mountToDf1 } from '@/lib/df1-store';
import { DF1_REFUSAL_TEXT } from '@/lib/df1-pick';
import { TRACK_TOO_LONG } from '@/lib/hfe/messages';
import { HD_UNSUPPORTED } from '@/lib/hd-messages';

export type Drive = 'df0' | 'df1';

/** True when `deviceId` is this org's board. Checked before anything is fetched or asked on the board's behalf. */
export async function orgOwnsDevice(orgId: string, deviceId: string): Promise<boolean> {
  const [dev] = await getDb().select({ id: devices.id }).from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId))).limit(1);
  return !!dev;
}

/**
 * Mount `diskId` into a drive: 200 {version, undo:{diskId}}, 404 not_found, 409 with the refusal. `hidden`: the disk
 * is a hidden remote row that was just (re)materialised. A concurrent revoke or Remove can delete it between that and
 * this (R-7): a not_found then is 410 {error:'ended'}, and a mount that landed on a row deleted right after is
 * taken back and answered the same way.
 */
export async function mountDiskResponse(
  orgId: string, deviceId: string, diskId: string, drive: Drive | undefined, opts: { hidden?: boolean } = {},
): Promise<Response> {
  // What Undo in the mount toast puts back (A3): the disk this drive held before the request -- DF0's confirmed disk,
  // DF1's pick -- or null for "it was empty", which Undo answers with an eject. Read before the write; a change
  // landing between the two is the same race the card's own Cancel has.
  const before = await drivesBefore(orgId, deviceId);

  if (drive === 'df1') {
    const r = await mountToDf1(orgId, deviceId, diskId);
    if (r.ok) {
      if (opts.hidden && await takenBackIfGone(orgId, deviceId, diskId, 'df1')) return ended();
      return Response.json({ version: r.version, undo: { diskId: before?.df1 ?? null } });
    }
    if (r.reason === 'not_found') return opts.hidden && !(await diskExists(orgId, diskId)) ? ended() : notFound();
    // Said, not hidden: the reason is the same sentence the disabled button shows (df1-pick.ts).
    return Response.json({ error: r.reason, reason: DF1_REFUSAL_TEXT[r.reason] }, { status: 409 });
  }

  const result = await setDesired(orgId, deviceId, diskId);
  // not_found covers unknown device, unknown disk, and either belonging to
  // another organization — deliberately indistinguishable.
  if (!result.ok && result.reason === 'not_found') {
    return opts.hidden && !(await diskExists(orgId, diskId)) ? ended() : notFound();
  }
  // HD spec §4.3: the disk is HD and this board's firmware cannot answer the
  // Amiga's drive-ID read as HD. Said, not hidden; the fix is an update.
  if (!result.ok && result.reason === 'hd_unsupported') {
    return Response.json({ error: 'hd_unsupported', reason: HD_UNSUPPORTED }, { status: 409 });
  }
  // Both this org's: the board's firmware cannot hold the disk's longest
  // track. Said, not hidden -- the fix (update the board) is the person's.
  if (!result.ok) return Response.json({ error: 'track_too_long', reason: TRACK_TOO_LONG }, { status: 409 });

  if (opts.hidden && await takenBackIfGone(orgId, deviceId, diskId, 'df0')) return ended();
  return Response.json({ version: result.version, undo: { diskId: before?.df0 ?? null } });
}

const notFound = () => Response.json({ error: 'not_found' }, { status: 404 });
const ended = () => Response.json({ error: 'ended' }, { status: 410 });

async function diskExists(orgId: string, diskId: string): Promise<boolean> {
  const [r] = await getDb().select({ id: disks.id }).from(disks)
    .where(and(eq(disks.id, diskId), eq(disks.orgId, orgId))).limit(1);
  return !!r;
}

/**
 * The hidden row vanished after the mount was written (a purge deleted it in between): the drive is told to let go,
 * with its cursor moved, so the board never holds a disk whose row is gone. Only this request's mount is undone.
 */
async function takenBackIfGone(orgId: string, deviceId: string, diskId: string, drive: Drive): Promise<boolean> {
  if (await diskExists(orgId, diskId)) return false;
  const scope = and(eq(devices.id, deviceId), eq(devices.orgId, orgId));
  if (drive === 'df0') {
    // Not clearDesired: it would remember the gone disk as "last disk", which the foreign key refuses.
    await getDb().update(devices).set({
      desiredSha256: null, desiredGameId: null, desiredDiskNo: null, desiredDiskId: null, desiredSetAt: new Date(),
      desiredVersion: sql`${devices.desiredVersion} + 1`,
    }).where(and(scope, eq(devices.desiredDiskId, diskId)));
  } else {
    // The foreign key already emptied df1_disk_id on the delete; the cursor still has to move for the board to eject.
    await getDb().update(devices).set({ df1DiskId: null, df1Version: sql`${devices.df1Version} + 1` })
      .where(and(scope, or(isNull(devices.df1DiskId), eq(devices.df1DiskId, diskId))));
  }
  return true;
}
