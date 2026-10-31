// NET: volumes (spec 2026-10-30 §4): the queue of requests from Files to a board's Amiga (list volumes, list a drawer,
// fetch a file). Answers are remembered REMEMBER_MS, arrive in pieces, and a request nobody answers times out.
import { and, asc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import type { Db } from '@/db';
import { devices } from '@/db/schema/devices';
import { remoteRequests } from '@/db/schema/remote-requests';
import { FAILED_SHOWN_MS, GET_TIMEOUT_MS, LIST_TIMEOUT_MS, PANE_GIVE_UP_MS, REMEMBER_MS, REQUEST_KEEP_MS, REQ_FETCH_MAX } from './remote-limits';
import { newRequestId, parseAnswerLine, type EntryInfo, type VolumeInfo } from './remote-wire';

export type RemoteRow = typeof remoteRequests.$inferSelect;
export type GetTarget = { dest: string; rel: string[]; replace: boolean; library: { collectionId: string | null } | null };
export type ListingState =
  | { state: 'ready'; row: RemoteRow; ageMs: number }
  | { state: 'pending'; row: RemoteRow }
  | { state: 'failed'; row: RemoteRow }
  | { state: 'none' };

const BAD = { errorCode: 'bad', errorText: 'Transfer sent an answer webadf could not read' };
const ms = (now: Date, back: number) => new Date(now.getTime() - back);

/** Requests nobody answered fail `timeout`, so a pane never waits on a board that went away. */
export async function expireStale(db: Db, now = new Date()): Promise<void> {
  const list = inArray(remoteRequests.kind, ['vols', 'dir']);
  const cutList = ms(now, LIST_TIMEOUT_MS);
  // A waiting one behind a copy (A500 bench 2026-10-31): Transfer answers nothing while a get's file moves and the board
  // fetches nothing meanwhile, so its 60 s run from when the board's copy last moved, not from the ask.
  await db.update(remoteRequests).set({ status: 'failed', errorCode: 'timeout', errorText: '', answeredAt: now }).where(or(
    and(list, eq(remoteRequests.status, 'sent'), lt(remoteRequests.sentAt, cutList)),
    and(list, eq(remoteRequests.status, 'waiting'), lt(remoteRequests.createdAt, cutList), sql`not exists (select 1 from remote_requests g
      where g.device_id = remote_requests.device_id and g.kind = 'get' and (
        (g.status = 'fetching' and g.active_at >= ${cutList}) or (g.status = 'done' and g.answered_at >= ${cutList})))`),
  ));
  // A get times out after 10 minutes with no get activity (fix round 1 ruling): its own once fetching; while only sent,
  // the board's -- Transfer works through the batch one file at a time, so one queued behind busy siblings is not lost.
  const cutGet = ms(now, GET_TIMEOUT_MS);
  const own = sql`coalesce(${remoteRequests.activeAt}, ${remoteRequests.sentAt})`;
  await db.update(remoteRequests).set({ status: 'failed', errorCode: 'timeout', errorText: 'stopped answering', answeredAt: now }).where(and(
    eq(remoteRequests.kind, 'get'),
    or(
      and(eq(remoteRequests.status, 'fetching'), lt(own, cutGet)),
      and(eq(remoteRequests.status, 'sent'), lt(own, cutGet), sql`not exists (select 1 from remote_requests b
        where b.device_id = remote_requests.device_id and b.kind = 'get' and coalesce(b.active_at, b.sent_at) >= ${cutGet})`),
    ),
  ));
}

/**
 * The Amiga path of the board's get whose file is moving now (it moved within the last LIST_TIMEOUT_MS), else null: a
 * listing asked for meanwhile waits for it (A500 bench 2026-10-31), and the pane says so.
 */
export async function copyMoving(db: Db, deviceId: string, now = new Date()): Promise<string | null> {
  const [g] = await db.select({ path: remoteRequests.amigaPath }).from(remoteRequests).where(and(
    eq(remoteRequests.deviceId, deviceId), eq(remoteRequests.kind, 'get'), eq(remoteRequests.status, 'fetching'),
    gte(remoteRequests.activeAt, ms(now, LIST_TIMEOUT_MS)),
  )).orderBy(sql`${remoteRequests.activeAt} desc`).limit(1);
  return g?.path ?? null;
}

/** A get its file can still arrive for: sent or fetching, or failed only by the timeout (a late arrival revives it). */
export const liveGet = () => or(inArray(remoteRequests.status, ['sent', 'fetching']),
  and(eq(remoteRequests.status, 'failed'), eq(remoteRequests.errorCode, 'timeout')));

/**
 * A sign of life from a get's file (its upload opened, a chunk stored): the get is fetching again from `now`, a
 * timed-out one revived. `uploadId`, at the open, ties the upload to the get.
 */
export async function touchGet(db: Pick<Db, 'update'>, by: { id: string } | { uploadId: string }, now: Date, uploadId?: string): Promise<void> {
  await db.update(remoteRequests).set({ status: 'fetching', activeAt: now, errorCode: null, errorText: null, answeredAt: null,
    ...(uploadId ? { uploadId } : {}) })
    .where(and('id' in by ? eq(remoteRequests.id, by.id) : eq(remoteRequests.uploadId, by.uploadId), eq(remoteRequests.kind, 'get'), liveGet()));
}

export async function latestFor(db: Db, deviceId: string, kind: 'vols' | 'dir', amigaPath: string, now = new Date()): Promise<ListingState> {
  await expireStale(db, now);
  const [row] = await db.select().from(remoteRequests).where(and(
    eq(remoteRequests.deviceId, deviceId), eq(remoteRequests.kind, kind),
    sql`lower(${remoteRequests.amigaPath}) = lower(${amigaPath})`,
  )).orderBy(sql`${remoteRequests.createdAt} desc`).limit(1);
  if (!row) return { state: 'none' };
  if (row.status === 'waiting' || row.status === 'sent') return { state: 'pending', row };
  const answered = row.answeredAt ? now.getTime() - row.answeredAt.getTime() : Infinity;
  if (row.status === 'done' && answered < REMEMBER_MS) return { state: 'ready', row, ageMs: answered };
  if (row.status === 'failed' && answered < FAILED_SHOWN_MS) return { state: 'failed', row };
  return { state: 'none' };
}

export async function requestListing(
  db: Db, a: { orgId: string; deviceId: string; kind: 'vols' | 'dir'; amigaPath: string; fresh: boolean }, now = new Date(),
): Promise<ListingState> {
  // Two panes on one drawer share one request; a visit within the memory reuses the answer, a Refresh does not. A
  // Refresh after the pane gave up (PANE_GIVE_UP_MS) asks again: the stuck request fails `timeout` (final review).
  const stuck = (s: ListingState) => a.fresh && s.state === 'pending' && now.getTime() - s.row.createdAt.getTime() >= PANE_GIVE_UP_MS;
  const keep = (s: ListingState) => (s.state === 'pending' && !stuck(s)) || (s.state !== 'none' && s.state !== 'pending' && !a.fresh);
  const cur = await latestFor(db, a.deviceId, a.kind, a.amigaPath, now);
  if (keep(cur)) return cur;
  return db.transaction(async (tx) => {
    // Serialise on the board (the row bumped below), then look again: a concurrent ask may have inserted meanwhile.
    await tx.select({ id: devices.id }).from(devices).where(eq(devices.id, a.deviceId)).for('update');
    const again = await latestFor(tx as unknown as Db, a.deviceId, a.kind, a.amigaPath, now);
    if (keep(again)) return again;
    if (again.state === 'pending') {
      await tx.update(remoteRequests).set({ status: 'failed', errorCode: 'timeout', errorText: '', answeredAt: now })
        .where(eq(remoteRequests.id, again.row.id));
    }
    await tx.delete(remoteRequests).where(lt(remoteRequests.createdAt, ms(now, REQUEST_KEEP_MS)));
    const [row] = await tx.insert(remoteRequests).values({
      id: newRequestId(), orgId: a.orgId, deviceId: a.deviceId, kind: a.kind, amigaPath: a.amigaPath, createdAt: now,
    }).returning();
    await tx.update(devices).set({ reqVersion: sql`${devices.reqVersion} + 1` }).where(eq(devices.id, a.deviceId));
    return { state: 'pending' as const, row };
  });
}

export async function addGets(
  db: Db, a: { orgId: string; deviceId: string; fetchId: string; files: { amigaPath: string; target: GetTarget }[] }, now = new Date(),
): Promise<string[]> {
  if (a.files.length === 0) return [];
  return db.transaction(async (tx) => {
    const rows = await tx.insert(remoteRequests).values(a.files.map((f) => ({
      id: newRequestId(), orgId: a.orgId, deviceId: a.deviceId, kind: 'get', amigaPath: f.amigaPath,
      target: f.target, fetchId: a.fetchId, createdAt: now,
    }))).returning({ id: remoteRequests.id });
    await tx.update(devices).set({ reqVersion: sql`${devices.reqVersion} + 1` }).where(eq(devices.id, a.deviceId));
    return rows.map((r) => r.id);
  });
}

// A listing a pane waits on goes before a copy's gets (final review): 64 gets must not starve it for minutes.
const listingsFirst = sql`case when ${remoteRequests.kind} = 'get' then 1 else 0 end`;
const handOrder = (r: RemoteRow) => (r.kind === 'get' ? 1 : 0);

/**
 * The board's GET /api/device/req: at most REQ_FETCH_MAX waiting requests, listings first, then oldest first. The
 * board fetches only when req_version moves (§4.2), so when any are left waiting the version is bumped again here.
 */
export async function takeWaiting(db: Db, deviceId: string, now = new Date()): Promise<RemoteRow[]> {
  return db.transaction(async (tx) => {
    const waiting = and(eq(remoteRequests.deviceId, deviceId), eq(remoteRequests.status, 'waiting'));
    const picked = await tx.select({ id: remoteRequests.id }).from(remoteRequests).where(waiting)
      .orderBy(listingsFirst, asc(remoteRequests.createdAt), asc(remoteRequests.id)).limit(REQ_FETCH_MAX).for('update', { skipLocked: true });
    if (picked.length === 0) return [];
    const rows = await tx.update(remoteRequests).set({ status: 'sent', sentAt: now, activeAt: now })
      .where(inArray(remoteRequests.id, picked.map((p) => p.id))).returning();
    const [left] = await tx.select({ id: remoteRequests.id }).from(remoteRequests).where(waiting).limit(1);
    if (left) await tx.update(devices).set({ reqVersion: sql`${devices.reqVersion} + 1` }).where(eq(devices.id, deviceId));
    return rows.sort((a, b) => handOrder(a) - handOrder(b) || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  });
}

export async function answerPiece(
  db: Db, deviceId: string, rid: string, p: { piece: number; lines: string[]; last: boolean }, now = new Date(),
): Promise<{ ok: true } | { ok: false; status: 400 | 404 | 409 }> {
  return db.transaction(async (tx) => {
    const [r] = await tx.select().from(remoteRequests)
      .where(and(eq(remoteRequests.id, rid), eq(remoteRequests.deviceId, deviceId))).for('update');
    if (!r) return { ok: false as const, status: 404 as const };
    // A repeat after a lost reply changes nothing.
    if (r.status === 'done' || r.status === 'failed' || p.piece < r.pieces) return { ok: true as const };
    if (p.piece > r.pieces || (r.status !== 'sent' && r.status !== 'fetching')) return { ok: false as const, status: 409 as const };
    const prev = (r.answer ?? { volumes: [], entries: [] }) as { volumes: VolumeInfo[]; entries: EntryInfo[] };
    const set: Partial<RemoteRow> = { pieces: r.pieces + 1, ...(r.kind === 'get' ? { activeAt: now } : {}) };
    let end: 'done' | 'failed' | null = null;
    for (const line of p.lines) {
      const a = parseAnswerLine(rid, line);
      if (!a) { Object.assign(set, BAD); end = 'failed'; break; }
      if (a.t === 'vol' && r.kind === 'vols') prev.volumes.push(a.v);
      else if (a.t === 'ent' && r.kind === 'dir') prev.entries.push(a.e);
      else if (a.t === 'done' && r.kind !== 'get') { set.cut = a.cut; end = 'done'; }
      else if (a.t === 'err') { Object.assign(set, { errorCode: a.code, errorText: a.text }); end = 'failed'; break; }
      else if (a.t === 'got' && r.kind === 'get') set.status = 'fetching';
      else { Object.assign(set, BAD); end = 'failed'; break; }
    }
    // The last piece must end the answer (vols/dir: DONE or ERR; get: GOT or ERR).
    if (p.last && end === null && !(r.kind === 'get' && set.status === 'fetching')) { Object.assign(set, BAD); end = 'failed'; }
    if (r.kind !== 'get') set.answer = prev;
    if (end) Object.assign(set, { status: end, answeredAt: now });
    await tx.update(remoteRequests).set(set).where(eq(remoteRequests.id, rid));
    return { ok: true as const };
  });
}

export async function getForUpload(db: Db, deviceId: string, rid: string): Promise<RemoteRow | null> {
  const [r] = await db.select().from(remoteRequests).where(and(
    eq(remoteRequests.id, rid), eq(remoteRequests.deviceId, deviceId), eq(remoteRequests.kind, 'get'), liveGet(),
  ));
  return r ?? null;
}

export async function settleGet(db: Db, rid: string, outcome: { ok: true } | { ok: false; code: string; text: string }, now = new Date()): Promise<void> {
  const set = outcome.ok
    ? { status: 'done', answeredAt: now }
    : { status: 'failed', errorCode: outcome.code, errorText: outcome.text, answeredAt: now };
  await db.update(remoteRequests).set(set).where(eq(remoteRequests.id, rid));
}
