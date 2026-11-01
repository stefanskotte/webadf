// NET: volumes (spec 2026-10-30 §4): the queue of requests from Files to a board's Amiga (list volumes, list a drawer,
// fetch a file). Answers are remembered REMEMBER_MS, arrive in pieces, and a request nobody answers times out.
import { and, asc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import type { Db } from '@/db';
import { devices } from '@/db/schema/devices';
import { remoteRequests } from '@/db/schema/remote-requests';
import { transfers } from '@/db/schema/transfers';
import { amigaUploads, amigaUploadChunks } from '@/db/schema/amiga-uploads';
import { STAGING } from '@/lib/stash';
import { amigaFoldSql } from '@/lib/amiga-fold';
import {
  ALIVE_PIECE_MS, FAILED_SHOWN_MS, GET_TIMEOUT_MS, LIST_TIMEOUT_MS, PANE_GIVE_UP_MS, REMEMBER_MS, REQUEST_KEEP_MS, REQ_FETCH_MAX,
  MOVE_PROTO, WRITE_KINDS, type WriteKind,
} from './remote-limits';
import { MOVE_OLD_TRANSFER } from './remote-browse';
import { newRequestId, parseAnswerLine, type EntryInfo, type VolumeInfo, type WriteArgs } from './remote-wire';

export type RemoteRow = typeof remoteRequests.$inferSelect;
/**
 * Where a get's file goes. `moveSource` (phase 2, plan W7): the Files path a move removes once every get of its job
 * naming it is done. `relay` (plan W8): a copy onto another volume -- on arrival the file is handed to that board's queue
 * with the absolute path and clash mode, held meanwhile as internal staging (never a STASH: row).
 */
export type GetTarget = { dest: string; rel: string[]; replace: boolean; library: { collectionId: string | null } | null;
  moveSource?: string; relay?: { deviceId: string; dest: string; onClash: 'keep' | 'replace' | 'skip'; moveSource?: string };
  /** A moved drawer's drawers as the copy walked them, itself included (Amiga paths): removed after its files (§9). */
  moveDrawers?: string[];
  /** The file as the copy's walk saw it (final review I-1): removed only while a fresh listing still shows it so. */
  moveSeen?: { size: number; date: string };
  /** A moved drawer's drawers the copy into STASH: left out, holding no file (item 9: why a drawer was kept). */
  moveLeft?: string[];
  /** The fresh listings a settling move asked for (their request ids) before it removes anything off a volume. */
  moveVerify?: string[];
  /** Who made the copy (a move's removal and a relay's queue row are theirs). */
  userId?: string };
/** A write request (spec 2026-10-31 §2.3): `label` the object in the pane's words, `icon` a `.info` taken along (W9). */
export type WriteReq = { kind: WriteKind; amigaPath: string; args?: WriteArgs; icon?: boolean; ensure?: boolean; label: string;
  /** DELETE exactly this object (protocol 5, spec 2026-10-31 §9): what a move removes. */
  one?: boolean;
  /** A part of a move (§9): the Files path it moves, and the entry of it this request copies (`Pack/E`). */
  move?: { source: string; item?: string } };
/** What a write request's `target` holds: its arguments, its label, whether it is an icon taken along. */
/** `ensure`: a MKDIR a copy needs, where a drawer already there (`exists`) is as good as made. */
export type WriteTarget = WriteArgs & { label: string; icon?: boolean; ensure?: boolean; moved?: string;
  /** A move's part (§9): the source it moves and the entry it copies; cleared once the move settled. */
  moveSource?: string; moveItem?: string;
  /** A move's removal said, not sent: what it kept (net-moves.ts), and why (item 9). */
  kept?: boolean; keptWhy?: string };
export type ListingState =
  | { state: 'ready'; row: RemoteRow; ageMs: number }
  | { state: 'pending'; row: RemoteRow }
  | { state: 'failed'; row: RemoteRow }
  | { state: 'none' };

const BAD = { errorCode: 'bad', errorText: 'Transfer sent an answer webadf could not read' };
const ms = (now: Date, back: number) => new Date(now.getTime() - back);
const WRITES: string[] = [...WRITE_KINDS];
export const isWriteKind = (k: string): k is WriteKind => WRITES.includes(k);
/** The one-line requests that time out as listings do: listings and writes (a write's DEL pieces are its signs of life). */
const LINE_KINDS = ['vols', 'dir', ...WRITE_KINDS];

/**
 * The board is busy now, so Transfer answers nothing else meanwhile (A500 bench 2026-10-31; phase 2 §4.4): a get's file
 * going up, a queue file going down (a send, or a copy onto a volume), an Amiga-side upload, or another request whose
 * answer is arriving in pieces (a drawer DELETE sending DEL, a long listing: final review C3). The last two
 * have no clock of their own: the board's receiver report (send_rx_at, stamped by every chunk) is it.
 */
function boardMoving(cut: Date) {
  return sql`(exists (select 1 from remote_requests g
      where g.device_id = remote_requests.device_id and g.kind = 'get' and (
        (g.status = 'fetching' and g.active_at >= ${cut}) or (g.status = 'done' and g.answered_at >= ${cut})))
    or exists (select 1 from remote_requests w where w.device_id = remote_requests.device_id and w.id <> remote_requests.id
      and w.status = 'sent' and w.pieces > 0 and w.active_at >= ${cut})
    or exists (select 1 from devices d where d.id = remote_requests.device_id and d.send_rx_at >= ${cut} and (
      exists (select 1 from transfers t where t.device_id = d.id and t.status = 'sending' and t.active_at >= ${cut})
      or exists (select 1 from amiga_uploads u where u.device_id = d.id and u.status = 'receiving' and u.source = 'amiga'
        and u.active_at >= ${cut}))))`;
}

/** Requests nobody answered fail `timeout`, so a pane never waits on a board that went away. */
export async function expireStale(db: Db, now = new Date()): Promise<void> {
  const list = inArray(remoteRequests.kind, LINE_KINDS);
  const cutList = ms(now, LIST_TIMEOUT_MS);
  // One behind a copy (A500 bench 2026-10-31): Transfer answers nothing while a file moves, so a listing (or a write)
  // still waiting, or taken by the board and held with nothing answered, has its 60 s run from when the file last moved.
  // Its pieces (ENT, DEL) are signs of life too: its 60 s run from the last one.
  const noCopy = sql`not ${boardMoving(cutList)}`;
  await db.update(remoteRequests).set({ status: 'failed', errorCode: 'timeout', errorText: '', answeredAt: now }).where(or(
    and(list, eq(remoteRequests.status, 'sent'), lt(sql`coalesce(${remoteRequests.activeAt}, ${remoteRequests.sentAt})`, cutList),
      or(sql`${remoteRequests.pieces} > 0`, noCopy)),
    and(list, eq(remoteRequests.status, 'waiting'), lt(remoteRequests.createdAt, cutList), noCopy),
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
  // A placement that never ended (the process died mid-way, R1) fails as one that could not be placed: its file is not
  // coming again, so not `timeout`, which a late arrival revives.
  await db.update(remoteRequests).set({ status: 'failed', errorCode: 'io', errorText: 'it could not be placed', answeredAt: now })
    .where(and(eq(remoteRequests.kind, 'get'), eq(remoteRequests.status, 'placing'), lt(remoteRequests.activeAt, cutGet)));
}

/**
 * The Amiga path of the board's get whose file is moving now (it moved within the last LIST_TIMEOUT_MS), else null: a
 * listing asked for meanwhile waits for it (A500 bench 2026-10-31), and the pane says so.
 */
export async function copyMoving(db: Db, deviceId: string, now = new Date()): Promise<string | null> {
  const cut = ms(now, LIST_TIMEOUT_MS);
  const [g] = await db.select({ path: remoteRequests.amigaPath }).from(remoteRequests).where(and(
    eq(remoteRequests.deviceId, deviceId), eq(remoteRequests.kind, 'get'), eq(remoteRequests.status, 'fetching'),
    gte(remoteRequests.activeAt, cut),
  )).orderBy(sql`${remoteRequests.activeAt} desc`).limit(1);
  if (g) return g.path;
  // A queue file going down, or an Amiga-side upload going up (§4.4 minor 2), while the board's receiver report is fresh;
  // an upload only while its own chunks come (one Transfer stopped mid-file stays receiving: A500 bench 2026-10-31).
  const [d] = await db.select({ at: devices.sendRxAt }).from(devices).where(eq(devices.id, deviceId));
  if (!d?.at || d.at < cut) return null;
  const [t] = await db.select({ path: sql<string>`coalesce(${transfers.amigaDest}, ${transfers.path})` }).from(transfers)
    // A row left sending when Transfer stopped mid-file is not moving (plan 2026-11-01-net-consistency, item 8): only
    // one whose chunks came lately.
    .where(and(eq(transfers.deviceId, deviceId), eq(transfers.status, 'sending'), gte(transfers.activeAt, cut))).limit(1);
  if (t) return t.path;
  const [u] = await db.select({ path: amigaUploads.path }).from(amigaUploads)
    .where(and(eq(amigaUploads.deviceId, deviceId), eq(amigaUploads.status, 'receiving'), eq(amigaUploads.source, 'amiga'),
      gte(amigaUploads.activeAt, cut))).limit(1);
  return u?.path ?? null;
}

/**
 * The board's drawer DELETE whose DEL pieces are coming now (one came within ALIVE_PIECE_MS), in the pane's words, and
 * how many entries it has removed; else null. Transfer answers nothing else meanwhile (A500 bench 2026-10-31: 597 entries
 * in 89 s), so a listing asked for then waits for it, and the pane says so.
 */
export async function deleteRunning(db: Db, deviceId: string, now = new Date()): Promise<{ label: string; removed: number } | null> {
  const [r] = await db.select({ amigaPath: remoteRequests.amigaPath, target: remoteRequests.target, answer: remoteRequests.answer })
    .from(remoteRequests).where(and(eq(remoteRequests.deviceId, deviceId), eq(remoteRequests.kind, 'delete'), eq(remoteRequests.status, 'sent'),
      sql`${remoteRequests.pieces} > 0`, gte(remoteRequests.activeAt, ms(now, ALIVE_PIECE_MS))))
    .orderBy(sql`${remoteRequests.activeAt} desc`).limit(1);
  if (!r) return null;
  return { label: (r.target as WriteTarget | null)?.label ?? r.amigaPath, removed: (r.answer as { removed?: number } | null)?.removed ?? 0 };
}

/** A listing arriving in pieces shows life only while one came within ALIVE_PIECE_MS (§4.4 minor 1). */
export function pendingAlive(row: Pick<RemoteRow, 'pieces' | 'activeAt'>, now = new Date()): boolean {
  return row.pieces > 0 && !!row.activeAt && now.getTime() - row.activeAt.getTime() < ALIVE_PIECE_MS;
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
    sql`${amigaFoldSql(remoteRequests.amigaPath)} = ${amigaFoldSql(amigaPath)}`,
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
  // Stuck counts from its last sign of life -- the board took it, or a piece came (A500 bench 2026-10-31: a 1000-entry
  // drawer arrives over ~36 s, and a Refresh meanwhile must not start it over).
  const stuck = (s: ListingState) => a.fresh && s.state === 'pending' &&
    now.getTime() - (s.row.activeAt ?? s.row.createdAt).getTime() >= PANE_GIVE_UP_MS;
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

/**
 * Fresh listings a move asks for itself (final review I-1): before it removes anything off a volume it reads each drawer
 * it copied files out of again, under its job id, so the req route hands the answers back to it (afterRequestAnswered).
 * They are ordinary listings once answered. Takes the caller's transaction.
 */
export async function addListings(
  db: Pick<Db, 'insert' | 'update'>, a: { orgId: string; deviceId: string; jobId: string; paths: string[] }, now = new Date(),
): Promise<string[]> {
  if (a.paths.length === 0) return [];
  const rows = await db.insert(remoteRequests).values(a.paths.map((amigaPath) => ({
    id: newRequestId(), orgId: a.orgId, deviceId: a.deviceId, kind: 'dir', amigaPath, fetchId: a.jobId, createdAt: now,
  }))).returning({ id: remoteRequests.id });
  await db.update(devices).set({ reqVersion: sql`${devices.reqVersion} + 1` }).where(eq(devices.id, a.deviceId));
  return rows.map((r) => r.id);
}

/**
 * A Files operation's writes (spec 2026-10-31 §4.1): one row each, 1 ms apart in the order given (plan W10: the wire's
 * "oldest first" is the job's order), all under `jobId`, one version bump, and the 24 h cleanup.
 */
export async function addWrites(
  db: Db, a: { orgId: string; deviceId: string; jobId: string; writes: WriteReq[] }, now = new Date(),
): Promise<string[]> {
  if (a.writes.length === 0) return [];
  return db.transaction(async (tx) => {
    await tx.delete(remoteRequests).where(lt(remoteRequests.createdAt, ms(now, REQUEST_KEEP_MS)));
    const rows = await tx.insert(remoteRequests).values(a.writes.map((w, k) => ({
      id: newRequestId(), orgId: a.orgId, deviceId: a.deviceId, kind: w.kind, amigaPath: w.amigaPath, fetchId: a.jobId,
      target: { ...(w.args ?? {}), label: w.label, ...(w.icon ? { icon: true } : {}), ...(w.ensure ? { ensure: true } : {}),
        ...(w.one ? { one: true } : {}),
        ...(w.move ? { moveSource: w.move.source, ...(w.move.item !== undefined ? { moveItem: w.move.item } : {}) } : {}) } satisfies WriteTarget,
      createdAt: new Date(now.getTime() + k),
    }))).returning({ id: remoteRequests.id, createdAt: remoteRequests.createdAt });
    await tx.update(devices).set({ reqVersion: sql`${devices.reqVersion} + 1` }).where(eq(devices.id, a.deviceId));
    return rows.sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime()).map((r) => r.id);
  });
}

const parentOf = (path: string) => {
  const c = path.indexOf(':');
  const slash = path.lastIndexOf('/');
  return slash > c ? path.slice(0, slash) : path.slice(0, c + 1);
};

/** The drawers whose remembered listing a finished write changed (plan W12), and the drawers under a deleted one. */
function writeTouches(r: RemoteRow): { paths: string[]; under: string[] } {
  const to = (r.target as WriteTarget | null)?.to;
  if (r.kind === 'rename') return { paths: [parentOf(r.amigaPath), ...(to ? [parentOf(to)] : []), r.amigaPath], under: [r.amigaPath] };
  if (r.kind === 'delete') return { paths: [parentOf(r.amigaPath), r.amigaPath], under: [r.amigaPath] };
  return { paths: [parentOf(r.amigaPath)], under: [] };
}

/**
 * Forget remembered drawer listings (plan W12): a done answer for one of `paths` (case-insensitive), or for a drawer
 * under one of `under`, is marked stale, so the next visit asks the Amiga again.
 */
export async function dropMemory(db: Pick<Db, 'update'>, deviceId: string, paths: string[], under: string[] = []): Promise<void> {
  if (paths.length === 0 && under.length === 0) return;
  // Both sides folded by the one Amiga fold, in SQL (plan 2026-11-01-net-consistency, item 7).
  const at = amigaFoldSql(remoteRequests.amigaPath);
  const conds = [
    ...(paths.length ? [sql`${at} in (${sql.join(paths.map((x) => amigaFoldSql(x)), sql`, `)})`] : []),
    ...under.map((u) => sql`${at} like ${amigaFoldSql(`${u.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`)}`),
  ];
  await db.update(remoteRequests).set({ status: 'stale' }).where(and(
    eq(remoteRequests.deviceId, deviceId), eq(remoteRequests.kind, 'dir'), eq(remoteRequests.status, 'done'), or(...conds),
  ));
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
    // A write goes only to a board that reports writing on (spec 2026-10-31 §3); one that does not fails it here, so
    // a 1.22 board never sees one and nothing waits for a switch that is off (plan W11).
    const [d] = await tx.select({ rxProto: devices.rxProto, browseOn: devices.browseOn, writeOn: devices.writeOn }).from(devices).where(eq(devices.id, deviceId));
    if (!d || !((d.rxProto ?? 0) >= 4 && d.browseOn && d.writeOn)) {
      await tx.update(remoteRequests).set({ status: 'failed', errorCode: 'readonly', errorText: 'Writing is off in Transfer', answeredAt: now })
        .where(and(eq(remoteRequests.deviceId, deviceId), eq(remoteRequests.status, 'waiting'), inArray(remoteRequests.kind, WRITES)));
    }
    // DELETE … one (a move's removal, spec 2026-10-31 §9) only to Transfer 2.6: one older would delete a whole drawer.
    if (!d || (d.rxProto ?? 0) < MOVE_PROTO) {
      await tx.update(remoteRequests).set({ status: 'failed', errorCode: 'proto', errorText: `Copied, but the original could not be removed — ${MOVE_OLD_TRANSFER}`, answeredAt: now })
        .where(and(eq(remoteRequests.deviceId, deviceId), eq(remoteRequests.status, 'waiting'), eq(remoteRequests.kind, 'delete'),
          sql`(${remoteRequests.target}->>'one')::boolean is true`));
    }
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
    // Every piece is a sign of life: a listing's timeout runs from its last one (A500 bench 2026-10-31), a get's too.
    const set: Partial<RemoteRow> = { pieces: r.pieces + 1, activeAt: now };
    let end: 'done' | 'failed' | null = null;
    if (isWriteKind(r.kind)) {
      end = writeLines(r, rid, p.lines, set);
      if (p.last && end === null) { Object.assign(set, BAD); end = 'failed'; }
      if (end) Object.assign(set, { status: end, answeredAt: now });
      await tx.update(remoteRequests).set(set).where(eq(remoteRequests.id, rid));
      if (end === 'done' || (end === 'failed' && (set.answer as { removed?: number } | undefined)?.removed)) {
        const t = writeTouches(r);
        await dropMemory(tx, deviceId, t.paths, t.under);
      }
      return { ok: true as const };
    }
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
    // A get the board ended with an error mid-file: its staging (a copy between volumes) is no use to anyone now, so it
    // goes with its chunks at once, not at the daily sweep (plan 2026-11-01-net-consistency, item 3). A copy into
    // STASH: keeps its row: that is the person's, shown as it is.
    if (r.kind === 'get' && end === 'failed' && r.uploadId) {
      const hit = await tx.update(amigaUploads).set({ status: 'deleted' })
        .where(and(eq(amigaUploads.id, r.uploadId), eq(amigaUploads.source, STAGING), eq(amigaUploads.status, 'receiving')))
        .returning({ id: amigaUploads.id });
      if (hit.length) await tx.delete(amigaUploadChunks).where(eq(amigaUploadChunks.uploadId, r.uploadId));
    }
    return { ok: true as const };
  });
}

/**
 * A write's answer lines (spec 2026-10-31 §2.3): DEL counts up (DELETE only), DONE ends it, ERR stops it -- an icon
 * taken along that is not there is no failure (plan W9). The count removed stays in `answer.removed`. Null: not ended.
 */
function writeLines(r: RemoteRow, rid: string, lines: string[], set: Partial<RemoteRow>): 'done' | 'failed' | null {
  let removed = (r.answer as { removed?: number } | null)?.removed ?? 0;
  let end: 'done' | 'failed' | null = null;
  let kept = false;
  for (const line of lines) {
    const a = parseAnswerLine(rid, line);
    if (a?.t === 'del' && r.kind === 'delete') { removed = Math.max(removed, a.count); continue; }
    if (a?.t === 'done' && !a.cut) { if (r.kind === 'delete') removed = a.count; end = 'done'; break; }
    if (a?.t === 'err') {
      const t = r.target as WriteTarget | null;
      if ((a.code === 'notfound' && t?.icon) || (a.code === 'exists' && t?.ensure)) { end = 'done'; break; }
      // A move's DELETE … one (§9): a drawer something new is in stays (said, not a failure); one gone already is gone.
      if (r.kind === 'delete' && t?.one && (a.code === 'notempty' || a.code === 'notfound')) { kept = a.code === 'notempty'; end = 'done'; break; }
      Object.assign(set, { errorCode: a.code, errorText: a.text }); end = 'failed'; break;
    }
    Object.assign(set, BAD); end = 'failed'; break;
  }
  if (r.kind === 'delete') set.answer = { removed, ...(kept ? { kept: true } : {}) };
  return end;
}

export async function getForUpload(db: Db, deviceId: string, rid: string): Promise<RemoteRow | null> {
  const [r] = await db.select().from(remoteRequests).where(and(
    eq(remoteRequests.id, rid), eq(remoteRequests.deviceId, deviceId), eq(remoteRequests.kind, 'get'), liveGet(),
  ));
  return r ?? null;
}

/**
 * A get settled. `onlyFrom`: only while it is in that state (a placement settles only the get it claimed, `placing`, so a
 * later error never turns a done get failed). Whether it was settled now.
 */
export async function settleGet(db: Pick<Db, 'update'>, rid: string, outcome: { ok: true } | { ok: false; code: string; text: string }, now = new Date(),
  onlyFrom?: string): Promise<boolean> {
  const set = outcome.ok
    ? { status: 'done', answeredAt: now }
    : { status: 'failed', errorCode: outcome.code, errorText: outcome.text, answeredAt: now };
  const hit = await db.update(remoteRequests).set(set)
    .where(and(eq(remoteRequests.id, rid), ...(onlyFrom ? [eq(remoteRequests.status, onlyFrom)] : []))).returning({ id: remoteRequests.id });
  return hit.length > 0;
}

/**
 * The get whose file upload `uploadId` is, claimed for its placement (plan 2026-11-01-net-consistency, R1): one UPDATE
 * moves it from live to `placing`, so of two closes of one upload (the board's 30 s retry) only one places the file. Null
 * when no live get names the upload (placed already, being placed, or ended).
 */
export async function claimGet(db: Pick<Db, 'update' | 'select'>, uploadId: string, now = new Date()): Promise<RemoteRow | null> {
  const live = and(eq(remoteRequests.uploadId, uploadId), eq(remoteRequests.kind, 'get'), liveGet());
  const [g] = await db.update(remoteRequests).set({ status: 'placing', activeAt: now, errorCode: null, errorText: null, answeredAt: null })
    .where(and(live, inArray(remoteRequests.id, db.select({ id: remoteRequests.id }).from(remoteRequests).where(live)
      .orderBy(sql`${remoteRequests.createdAt} desc`).limit(1))))
    .returning();
  return g ?? null;
}
