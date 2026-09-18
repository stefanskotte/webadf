import { and, eq, ne, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks, entitlements } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { diskWriteSessions, diskWriteTracks } from '@/db/schema/disk-history';
import { diskStore } from '@/lib/storage';
import { recordVersion, StaleHeadError, type Recorded } from '@/lib/disk-history/store';
import { overlayTracks, isTrackUpload } from '@/lib/disk-history/version';

/**
 * A board's write session (write-back spec §3.1, §3.3). The board uploads each
 * rewritten track, then closes the session; the close turns the staged tracks
 * into one history version.
 */

export interface WriteQuery { diskId: string; mount: number }
/**
 * What a route answers, verbatim. stageTrack: 200 { staged } | 200 { duplicate }
 * | 400 invalid_body | 404 not_found | 409 not_mounted | 409 write_protected.
 * closeSession: 200 { sha256 } | 200 { sha256, unchanged } | 404 not_found
 * | 409 not_mounted | 409 { mismatch, sha256 } | 409 conflict (the disk moved
 * on; the session is kept for a retry).
 */
export type Outcome = { status: number; body: Record<string, unknown> };
type Device = { deviceId: string; orgId: string };

/** 409 not_mounted unless this board holds exactly this disk at exactly this mount. */
async function holdsMount(device: Device, q: WriteQuery): Promise<boolean> {
  const rows = await getDb()
    .select({ diskId: devices.mountedDiskId, version: devices.mountedVersion })
    .from(devices)
    .where(and(eq(devices.id, device.deviceId), eq(devices.orgId, device.orgId)))
    .limit(1);
  return rows[0]?.diskId === q.diskId && rows[0]?.version === q.mount;
}

export async function stageTrack(
  device: Device, q: WriteQuery & { track: number; seq: number }, data: Uint8Array,
): Promise<Outcome> {
  if (!isTrackUpload(q.track, data)) return { status: 400, body: { error: 'invalid_body' } };
  if (!(await holdsMount(device, q))) return { status: 409, body: { error: 'not_mounted' } };

  const db = getDb();
  const disk = (await db.select({ wp: disks.writeProtected }).from(disks)
    .where(and(eq(disks.id, q.diskId), eq(disks.orgId, device.orgId))).limit(1))[0];
  if (!disk) return { status: 404, body: { error: 'not_found' } };
  if (disk.wp) return { status: 409, body: { error: 'write_protected' } };

  let session = (await db.select({ lastSeq: diskWriteSessions.lastSeq }).from(diskWriteSessions)
    .where(and(eq(diskWriteSessions.deviceId, device.deviceId), eq(diskWriteSessions.mount, q.mount)))
    .limit(1))[0];
  if (!session) {
    // A session left open under an EARLIER mount means the board lost power
    // before closing it. After a reboot the board re-downloads the head image,
    // which does not contain those tracks; applying them later would make the
    // server and the board disagree. Discarded -- the force majeure the
    // operator accepted (spec D3).
    await db.delete(diskWriteSessions).where(and(
      eq(diskWriteSessions.deviceId, device.deviceId), ne(diskWriteSessions.mount, q.mount)));
    await db.insert(diskWriteSessions).values({
      deviceId: device.deviceId, mount: q.mount, diskId: q.diskId, lastSeq: 0,
    }).onConflictDoNothing();
    session = { lastSeq: 0 };
  }
  if (q.seq <= session.lastSeq) return { status: 200, body: { duplicate: true } };

  await db.batch([
    db.insert(diskWriteTracks).values({
      deviceId: device.deviceId, mount: q.mount, track: q.track, data,
    }).onConflictDoUpdate({
      target: [diskWriteTracks.deviceId, diskWriteTracks.mount, diskWriteTracks.track],
      set: { data },
    }),
    db.update(diskWriteSessions).set({ lastSeq: q.seq }).where(and(
      eq(diskWriteSessions.deviceId, device.deviceId), eq(diskWriteSessions.mount, q.mount))),
  ]);
  return { status: 200, body: { staged: q.track } };
}

export async function closeSession(
  device: Device, q: WriteQuery & { seq: number; sha256: string },
): Promise<Outcome> {
  if (!(await holdsMount(device, q))) return { status: 409, body: { error: 'not_mounted' } };
  const db = getDb();

  const disk = (await db.select({ sha256: disks.sha256, tosecName: disks.tosecName })
    .from(disks).where(and(eq(disks.id, q.diskId), eq(disks.orgId, device.orgId))).limit(1))[0];
  if (!disk) return { status: 404, body: { error: 'not_found' } };

  const staged = await db.select({ track: diskWriteTracks.track, data: diskWriteTracks.data })
    .from(diskWriteTracks)
    .where(and(eq(diskWriteTracks.deviceId, device.deviceId), eq(diskWriteTracks.mount, q.mount)));
  if (staged.length === 0) return { status: 200, body: { sha256: disk.sha256, unchanged: true } };

  const head = await diskStore.read(disk.sha256);
  const next = overlayTracks(head, staged);
  const ent = (await db.select({ name: entitlements.sourceFilename }).from(entitlements)
    .where(and(eq(entitlements.orgId, device.orgId), eq(entitlements.sha256, disk.sha256))).limit(1))[0];
  let recorded: Recorded | null;
  try {
    recorded = await recordVersion({
      orgId: device.orgId, diskId: q.diskId, headSha: disk.sha256, head, next,
      source: 'amiga', deviceId: device.deviceId,
      sourceFilename: disk.tosecName ?? ent?.name ?? `${q.diskId}.adf`,
    });
  } catch (err) {
    // The disk moved on while this session was open (another writer took the
    // head). Nothing was recorded. The session and its staged tracks are
    // KEPT and no device row is touched, so the board can retry the close and
    // it rebuilds on the new head.
    if (err instanceof StaleHeadError) return { status: 409, body: { error: 'conflict' } };
    throw err;
  }
  const sha256 = recorded?.sha256 ?? disk.sha256;

  await db.delete(diskWriteSessions).where(and(
    eq(diskWriteSessions.deviceId, device.deviceId), eq(diskWriteSessions.mount, q.mount)));

  const mismatch = sha256 !== q.sha256;
  // This board already holds `sha256` -- unless the digests disagree, in which
  // case the server's image wins and the version bump makes it re-download.
  await db.update(devices).set({
    mountedSha256: mismatch ? undefined : sha256,
    desiredSha256: sha256,
    ...(mismatch ? {
      desiredVersion: sql`${devices.desiredVersion} + 1`,
      lastError: `write close mismatch: board ${q.sha256.slice(0, 12)} server ${sha256.slice(0, 12)}`,
      lastErrorAt: new Date(),
    } : {}),
  }).where(and(eq(devices.id, device.deviceId), eq(devices.orgId, device.orgId)));

  // Any OTHER board that wants this disk is now behind: point it at the new
  // image and bump it, so it re-downloads (the volume-name holder pattern).
  await db.update(devices).set({
    desiredSha256: sha256, desiredVersion: sql`${devices.desiredVersion} + 1`,
  }).where(and(
    eq(devices.orgId, device.orgId), eq(devices.desiredDiskId, q.diskId), ne(devices.id, device.deviceId)));

  if (mismatch) return { status: 409, body: { error: 'mismatch', sha256 } };
  return { status: 200, body: { sha256 } };
}
