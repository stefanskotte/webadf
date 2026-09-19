import { and, eq, ne, or, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
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
/** The board's session token: chosen per boot, 1-64 of [A-Za-z0-9_-]. */
export const SESSION_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * What a route answers, verbatim. stageTrack: 200 { staged } | 200 { duplicate }
 * | 400 invalid_body | 404 not_found | 409 not_mounted | 409 { not_mounted,
 * reason: 'behind' } | 409 write_protected (these two only when opening a
 * session). closeSession: 200 { sha256 } | 200 { sha256,
 * unchanged } | 404 not_found | 409 not_mounted | 409 { mismatch, sha256 }
 * | 409 incomplete (seq is not the session's last; kept) | 409 conflict (the
 * disk moved on; the session is kept for a retry).
 */
export type Outcome = { status: number; body: Record<string, unknown> };
type Device = { deviceId: string; orgId: string };

/**
 * Whether this board may write under `q.mount`. A session's mount is fixed
 * from open to close: desiredVersion also moves for reasons that are not a
 * remount (the live write-protect toggle, another board's close, a mismatch
 * bump), and once the board acknowledges that new version the session it is
 * still in the middle of must stay reachable, or the Amiga's saves are lost.
 *
 *   'current' -- the board holds this disk at exactly this mount.
 *   'behind'  -- it does, but the server has since bumped it for this same
 *                disk and it has not acknowledged the bump. Its open session
 *                continues; a NEW one is refused, because a session's base is
 *                the head when it opens, and after a bump (another board's
 *                close, a mismatch) the head may not be the image this board
 *                holds -- its tracks would land on bytes it never had.
 *   'session' -- it holds this disk, and a session is already open for it at
 *                this mount (continue or close it, but never open a new one).
 *   null      -- 409 not_mounted.
 */
async function holdsMount(device: Device, q: WriteQuery): Promise<'current' | 'behind' | 'session' | null> {
  const db = getDb();
  const rows = await db
    .select({
      diskId: devices.mountedDiskId, version: devices.mountedVersion,
      desiredDiskId: devices.desiredDiskId, desiredVersion: devices.desiredVersion,
    })
    .from(devices)
    .where(and(eq(devices.id, device.deviceId), eq(devices.orgId, device.orgId)))
    .limit(1);
  const row = rows[0];
  if (row?.diskId !== q.diskId) return null;
  if (row.version === q.mount) {
    const bumped = row.desiredDiskId === q.diskId && row.desiredVersion > row.version;
    return bumped ? 'behind' : 'current';
  }
  const open = await db.select({ mount: diskWriteSessions.mount }).from(diskWriteSessions)
    .where(and(
      eq(diskWriteSessions.deviceId, device.deviceId), eq(diskWriteSessions.mount, q.mount),
      eq(diskWriteSessions.diskId, q.diskId)))
    .limit(1);
  return open.length ? 'session' : null;
}

export async function stageTrack(
  device: Device, q: WriteQuery & { track: number; seq: number; session: string }, data: Uint8Array,
): Promise<Outcome> {
  if (!isTrackUpload(q.track, data)) return { status: 400, body: { error: 'invalid_body' } };
  const held = await holdsMount(device, q);
  if (!held) return { status: 409, body: { error: 'not_mounted' } };

  const db = getDb();
  const disk = (await db.select({ wp: disks.writeProtected, sha256: disks.sha256 }).from(disks)
    .where(and(eq(disks.id, q.diskId), eq(disks.orgId, device.orgId))).limit(1))[0];
  if (!disk) return { status: 404, body: { error: 'not_found' } };

  const atMount = and(eq(diskWriteSessions.deviceId, device.deviceId), eq(diskWriteSessions.mount, q.mount));
  let session = (await db.select({ lastSeq: diskWriteSessions.lastSeq, token: diskWriteSessions.token })
    .from(diskWriteSessions).where(atMount).limit(1))[0];
  if (!session || session.token !== q.session) {
    // Opening a NEW session -- no session here, or one a previous boot of the
    // board left behind (its token differs). Needs the board's current mount;
    // only an already open session outlives a version bump.
    if (held === 'session') return { status: 409, body: { error: 'not_mounted' } };
    // Write-protect is decided when a session opens, never in the middle of
    // one: refusing the rest of an open session would tear the save the Amiga
    // is part-way through (the board applied those tracks already). Checked
    // before 'behind': turning write-protect on bumps the board too, and the
    // true reason is the flag, not the bump.
    if (disk.wp) return { status: 409, body: { error: 'write_protected' } };
    if (held === 'behind') return { status: 409, body: { error: 'not_mounted', reason: 'behind' } };
    // Any other session of this board -- under an earlier mount, or under this
    // mount with another token -- means the board lost power before closing it.
    // After a reboot the board re-downloads the head image, which does not
    // contain those tracks; applying them later would make the server and the
    // board disagree. Discarded, staged tracks with them (FK cascade) -- the
    // force majeure the operator accepted (spec D3).
    await db.delete(diskWriteSessions).where(and(
      eq(diskWriteSessions.deviceId, device.deviceId),
      or(ne(diskWriteSessions.mount, q.mount), ne(diskWriteSessions.token, q.session))));
    await db.insert(diskWriteSessions).values({
      deviceId: device.deviceId, mount: q.mount, diskId: q.diskId, lastSeq: 0,
      token: q.session, baseSha256: disk.sha256,
    }).onConflictDoNothing();
    session = { lastSeq: 0, token: q.session };
  }
  // Idempotent on (device, mount, token, seq): a rebooted board starts again at
  // seq 1 under a NEW token, so its writes are never mistaken for repeats.
  if (q.seq <= session.lastSeq) return { status: 200, body: { duplicate: true } };

  await db.batch([
    db.insert(diskWriteTracks).values({
      deviceId: device.deviceId, mount: q.mount, track: q.track, data,
    }).onConflictDoUpdate({
      target: [diskWriteTracks.deviceId, diskWriteTracks.mount, diskWriteTracks.track],
      set: { data },
    }),
    db.update(diskWriteSessions).set({ lastSeq: q.seq })
      .where(and(atMount, eq(diskWriteSessions.token, q.session))),
  ]);
  return { status: 200, body: { staged: q.track } };
}

export async function closeSession(
  device: Device, q: WriteQuery & { seq: number; sha256: string; session: string },
): Promise<Outcome> {
  if (!(await holdsMount(device, q))) return { status: 409, body: { error: 'not_mounted' } };
  const db = getDb();

  const disk = (await db.select({ sha256: disks.sha256, tosecName: disks.tosecName })
    .from(disks).where(and(eq(disks.id, q.diskId), eq(disks.orgId, device.orgId))).limit(1))[0];
  if (!disk) return { status: 404, body: { error: 'not_found' } };

  // Only THIS token's session. Another token's belongs to another boot of the
  // board and is not touched here (the next upload of a new token discards it).
  const thisSession = and(
    eq(diskWriteSessions.deviceId, device.deviceId), eq(diskWriteSessions.mount, q.mount),
    eq(diskWriteSessions.token, q.session));
  const session = (await db.select({ lastSeq: diskWriteSessions.lastSeq, baseSha256: diskWriteSessions.baseSha256 })
    .from(diskWriteSessions).where(thisSession).limit(1))[0];
  // The board closes at the seq of its last upload. Any other seq means an
  // upload never arrived (or arrived after this close was sent): recording now
  // would store an image the board does not hold. Kept, nothing recorded, so
  // the board can resend and close again.
  if (session && q.seq !== session.lastSeq) return { status: 409, body: { error: 'incomplete' } };

  const staged = !session ? [] : await db
    .select({ track: diskWriteTracks.track, data: diskWriteTracks.data })
    .from(diskWriteTracks)
    .where(and(eq(diskWriteTracks.deviceId, device.deviceId), eq(diskWriteTracks.mount, q.mount)));

  let sha256 = disk.sha256;
  let recorded: Recorded | null = null;
  if (session && staged.length > 0) {
    // The board's image is its tracks over the image it downloaded (the base),
    // not over whatever the head is now: another writer may have moved it. The
    // delta is taken against the CURRENT head, so the last writer wins and the
    // other write stays in history.
    const base = await diskStore.read(session.baseSha256);
    const head = session.baseSha256 === disk.sha256 ? base : await diskStore.read(disk.sha256);
    const next = overlayTracks(base, staged);
    const ent = (await db.select({ name: entitlements.sourceFilename }).from(entitlements)
      .where(and(eq(entitlements.orgId, device.orgId), eq(entitlements.sha256, disk.sha256))).limit(1))[0];
    try {
      recorded = await recordVersion({
        orgId: device.orgId, diskId: q.diskId, headSha: disk.sha256, head, next,
        source: 'amiga', deviceId: device.deviceId,
        sourceFilename: disk.tosecName ?? ent?.name ?? `${q.diskId}.adf`,
      });
    } catch (err) {
      // The disk moved on between the read above and the record (another
      // writer took the head). Nothing was recorded. The session and its
      // staged tracks are KEPT and no device row is touched, so the board can
      // retry the close and it rebuilds on the new head.
      if (err instanceof StaleHeadError) return { status: 409, body: { error: 'conflict' } };
      throw err;
    }
    sha256 = recorded?.sha256 ?? disk.sha256;
  } else if (q.sha256 === disk.sha256) {
    // Nothing staged and the board already holds the head. The session (if
    // any) is empty and goes too.
    if (session) await db.delete(diskWriteSessions).where(thisSession);
    return { status: 200, body: { sha256, unchanged: true } };
  }
  // Nothing staged but the board's digest is not the head -- e.g. the retry
  // of a close whose 409 mismatch was lost -- takes the mismatch path below,
  // so the board is never told a digest it does not hold is fine.

  const mismatch = sha256 !== q.sha256;
  const thisDevice = and(eq(devices.id, device.deviceId), eq(devices.orgId, device.orgId));
  const stmts: BatchItem<'pg'>[] = [
    // In the SAME batch as the device updates: a crash between them must not
    // leave the session gone and the board's bump lost.
    db.delete(diskWriteSessions).where(thisSession),
    // This board already holds `sha256` -- unless the digests disagree, in
    // which case the server's image wins (below) and the error is recorded.
    db.update(devices).set(mismatch ? {
      lastError: `write close mismatch: board ${q.sha256.slice(0, 12)} server ${sha256.slice(0, 12)}`,
      lastErrorAt: new Date(),
    } : { mountedSha256: sha256 }).where(thisDevice),
    // Only while this board still WANTS this disk. After a swap or eject the
    // browser has already pointed it elsewhere (setDesired), and repointing
    // it here would pair the other disk's identity with these bytes.
    db.update(devices).set({
      desiredSha256: sha256,
      ...(mismatch ? { desiredVersion: sql`${devices.desiredVersion} + 1` } : {}),
    }).where(and(thisDevice, eq(devices.desiredDiskId, q.diskId))),
  ];
  // Any OTHER board that wants this disk but not its head is behind: point it
  // at the head and bump it, so it re-downloads. Keyed on the digest, not on
  // whether THIS call recorded: a close that recorded and then died before
  // this batch is retried, records nothing the second time (the image is
  // already the head), and must still move those boards. A board already at
  // the head is left alone, so nothing changed means nothing bumped.
  stmts.push(db.update(devices).set({
    desiredSha256: sha256, desiredVersion: sql`${devices.desiredVersion} + 1`,
  }).where(and(
    eq(devices.orgId, device.orgId), eq(devices.desiredDiskId, q.diskId), ne(devices.id, device.deviceId),
    ne(devices.desiredSha256, sha256))));
  await db.batch(stmts as [BatchItem<'pg'>, ...BatchItem<'pg'>[]]);

  if (mismatch) return { status: 409, body: { error: 'mismatch', sha256 } };
  return { status: 200, body: { sha256 } };
}
