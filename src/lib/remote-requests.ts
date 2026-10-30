// NET: volumes (spec 2026-10-30 §4): the queue of requests from Files to a board's Amiga (list volumes, list a drawer,
// fetch a file). Answers are remembered REMEMBER_MS, arrive in pieces, and a request nobody answers times out.
import { and, asc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { Db } from '@/db';
import { devices } from '@/db/schema/devices';
import { remoteRequests } from '@/db/schema/remote-requests';
import { FAILED_SHOWN_MS, GET_TIMEOUT_MS, LIST_TIMEOUT_MS, REMEMBER_MS, REQUEST_KEEP_MS, REQ_FETCH_MAX } from './remote-limits';
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
  await db.update(remoteRequests).set({ status: 'failed', errorCode: 'timeout', errorText: '', answeredAt: now }).where(or(
    and(list, eq(remoteRequests.status, 'sent'), lt(remoteRequests.sentAt, cutList)),
    and(list, eq(remoteRequests.status, 'waiting'), lt(remoteRequests.createdAt, cutList)),
  ));
  await db.update(remoteRequests).set({ status: 'failed', errorCode: 'timeout', errorText: 'stopped answering', answeredAt: now }).where(and(
    eq(remoteRequests.kind, 'get'), inArray(remoteRequests.status, ['sent', 'fetching']), lt(remoteRequests.sentAt, ms(now, GET_TIMEOUT_MS)),
  ));
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
  const cur = await latestFor(db, a.deviceId, a.kind, a.amigaPath, now);
  // Two panes on one drawer share one request; a visit within the memory reuses the answer, a Refresh does not.
  if (cur.state === 'pending' || (cur.state !== 'none' && !a.fresh)) return cur;
  return db.transaction(async (tx) => {
    // Serialise on the board (the row bumped below), then look again: a concurrent ask may have inserted meanwhile.
    await tx.select({ id: devices.id }).from(devices).where(eq(devices.id, a.deviceId)).for('update');
    const again = await latestFor(tx as unknown as Db, a.deviceId, a.kind, a.amigaPath, now);
    if (again.state === 'pending' || (again.state !== 'none' && !a.fresh)) return again;
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

export async function takeWaiting(db: Db, deviceId: string, now = new Date()): Promise<RemoteRow[]> {
  return db.transaction(async (tx) => {
    const picked = await tx.select({ id: remoteRequests.id }).from(remoteRequests)
      .where(and(eq(remoteRequests.deviceId, deviceId), eq(remoteRequests.status, 'waiting')))
      .orderBy(asc(remoteRequests.createdAt)).limit(REQ_FETCH_MAX).for('update', { skipLocked: true });
    if (picked.length === 0) return [];
    const rows = await tx.update(remoteRequests).set({ status: 'sent', sentAt: now })
      .where(inArray(remoteRequests.id, picked.map((p) => p.id))).returning();
    return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
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
    const set: Partial<RemoteRow> = { pieces: r.pieces + 1 };
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
    eq(remoteRequests.id, rid), eq(remoteRequests.deviceId, deviceId), eq(remoteRequests.kind, 'get'),
    inArray(remoteRequests.status, ['fetching', 'sent']),
  ));
  return r ?? null;
}

export async function settleGet(db: Db, rid: string, outcome: { ok: true } | { ok: false; code: string; text: string }, now = new Date()): Promise<void> {
  const set = outcome.ok
    ? { status: 'done', answeredAt: now }
    : { status: 'failed', errorCode: outcome.code, errorText: outcome.text, answeredAt: now };
  await db.update(remoteRequests).set(set).where(eq(remoteRequests.id, rid));
}
