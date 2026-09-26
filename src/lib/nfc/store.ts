import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { disks, games } from '@/db/schema/catalog';
import { setDesired } from '@/lib/mount';
import { decideTap, NFC_WRITE_TTL_MS, shouldStoreWriteResult, type TapOutcome } from '@/lib/nfc/rules';

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

/**
 * Records the board's read-back of a tag write (spec §5.3). Only the first
 * answer to the CURRENT request is stored -- shouldStoreWriteResult checks
 * that against the row read here, and the seq in the WHERE below checks it
 * again against whatever is true at write time: a request issued between the
 * read and this write must not receive the older request's answer.
 */
export async function storeWriteResult(
  deviceId: string, r: { seq: number; ok: boolean; uid: string; reason?: string },
): Promise<boolean> {
  const db = getDb();
  const [row] = await db.select({ nfcWriteSeq: devices.nfcWriteSeq, nfcWriteResultSeq: devices.nfcWriteResultSeq })
    .from(devices).where(eq(devices.id, deviceId)).limit(1);
  if (!row || !shouldStoreWriteResult(row, r.seq)) return false;
  const done = await db.update(devices).set({
    nfcWriteResultSeq: r.seq, nfcWriteResult: r.ok ? 'ok' : (r.reason ?? 'failed'), nfcWriteResultUid: r.uid,
  }).where(and(eq(devices.id, deviceId), eq(devices.nfcWriteSeq, r.seq))).returning({ id: devices.id });
  return done.length > 0;
}

/**
 * Arms a write request for the given disk, bumping the cursor the board
 * polls against. Returns null if the device or the disk is outside the
 * caller's org -- a foreign disk id and an unknown one get identical answers
 * (global constraints), so the org always comes from the caller, never the
 * body.
 */
export async function requestNfcWrite(
  orgId: string, deviceId: string, diskId: string, now: Date,
): Promise<number | null> {
  const db = getDb();
  const [disk] = await db.select({ id: disks.id }).from(disks)
    .where(and(eq(disks.id, diskId), eq(disks.orgId, orgId))).limit(1);
  if (!disk) return null;
  const [r] = await db.update(devices).set({
    nfcWriteSeq: sql`${devices.nfcWriteSeq} + 1`, nfcWriteDiskId: diskId,
    nfcWriteExpiresAt: new Date(now.getTime() + NFC_WRITE_TTL_MS),
    nfcWriteResultSeq: null, nfcWriteResult: null, nfcWriteResultUid: null,
  }).where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId))).returning({ seq: devices.nfcWriteSeq });
  return r?.seq ?? null;
}

/** Bumps the cursor and clears the disk, but only if `seq` is still the
 *  current request -- a stale cancel must not clobber a newer one. */
export async function cancelNfcWrite(deviceId: string, seq: number): Promise<void> {
  await getDb().update(devices).set({ nfcWriteSeq: sql`${devices.nfcWriteSeq} + 1`, nfcWriteDiskId: null })
    .where(and(eq(devices.id, deviceId), eq(devices.nfcWriteSeq, seq)));
}

/** The stored result for `seq`, or null if it is not (yet, or ever) the
 *  answer to that exact request. */
export async function readWriteResult(deviceId: string, seq: number): Promise<{ result: string; uid: string | null } | null> {
  const [r] = await getDb().select({
    resultSeq: devices.nfcWriteResultSeq, result: devices.nfcWriteResult, uid: devices.nfcWriteResultUid,
  }).from(devices).where(eq(devices.id, deviceId)).limit(1);
  return r && r.resultSeq === seq && r.result ? { result: r.result, uid: r.uid } : null;
}

/**
 * This org's boards and whether each has a reader, for the fob button: the
 * pages draw it only when one reports 'present', and /api/nfc/write chooses
 * among them (chooseNfcDevice). Org-scoped here, so a board of another org
 * never reaches either.
 */
export async function listNfcDevices(orgId: string) {
  return getDb().select({ id: devices.id, name: devices.name, nfcReader: devices.nfcReader })
    .from(devices).where(eq(devices.orgId, orgId)).orderBy(asc(devices.name), asc(devices.id));
}

/** The disk's title and number, or null when it is not this org's -- the
 *  write route names the disk back to the dialog, and a foreign id must get
 *  the same null as an unknown one. */
export async function readDiskForNfc(orgId: string, diskId: string): Promise<{ title: string; diskNo: number } | null> {
  const [r] = await getDb().select({ title: games.title, diskNo: disks.diskNo }).from(disks)
    .innerJoin(games, eq(games.id, disks.gameId))
    .where(and(eq(disks.id, diskId), eq(disks.orgId, orgId))).limit(1);
  return r ?? null;
}

/** Every disk of the given titles, in disk order -- the library card's
 *  "which disk?" choice for a multi-disk set. Loaded with the page only when
 *  the org has a reader, so a library without one pays nothing. */
export async function listDisksForNfc(orgId: string, gameIds: string[]) {
  if (gameIds.length === 0) return [];
  return getDb().select({ id: disks.id, gameId: disks.gameId, diskNo: disks.diskNo }).from(disks)
    .where(and(eq(disks.orgId, orgId), inArray(disks.gameId, gameIds)))
    .orderBy(asc(disks.gameId), asc(disks.diskNo), asc(disks.id));
}

/** The write-request columns of one board, or null when the board is not
 *  this org's. nfcWriteStatus (rules.ts) reads a request's state from it. */
export async function readNfcWriteState(orgId: string, deviceId: string) {
  const [r] = await getDb().select({
    nfcWriteSeq: devices.nfcWriteSeq, nfcWriteExpiresAt: devices.nfcWriteExpiresAt,
    nfcWriteResultSeq: devices.nfcWriteResultSeq, nfcWriteResult: devices.nfcWriteResult,
    nfcWriteResultUid: devices.nfcWriteResultUid,
  }).from(devices).where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId))).limit(1);
  return r ?? null;
}
