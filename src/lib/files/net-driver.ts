// src/lib/files/net-driver.ts
// The NET: driver (Files spec 2026-10-29 §4.3, increment 3): NET: lists the org's boards that can receive files
// (firmware XFER_FW or newer), NET:/<deviceId> that board's Send-to-Amiga queue, each row addressed by its transfer id
// and named by its Amiga path (R1). A copy into NET:/<board> queues every file it brings, all or nothing (R3), keeping
// path, protection and comment (R2: Receive has no date). Delete cancels a waiting row and clears a finished one (R4).
// Nothing is copied or moved out of NET: (R5). A board that is not this org's, or cannot receive, is not found. SERVER ONLY.
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { transfers } from '@/db/schema/transfers';
import { cancelTransfer, clearTransfer, listTransfers, queueLoad, queueTransfers, sendSummaries, type QueueFile } from '@/lib/transfers';
import { listSendTargets, findSendTarget } from '@/lib/send-targets';
import { storeSendBytes, toView } from '@/lib/send-http';
import { receiverRunning, targetState, transferState, type SendTarget } from '@/lib/send-ui';
import { SEND_FILE_MAX, SEND_QUEUE_MAX_BYTES, SEND_QUEUE_MAX_FILES } from '@/lib/send-limits';
import { uploadBoards } from '@/lib/amiga-uploads';
import { mapLimit } from '@/lib/pool';
import { protectionString } from '@/lib/adffs/dir';
import { formatPath, parsePath, type FsPath } from './path';
import { refuse, type FsCtx, type IncomingTop, type OpCtx, type OpItem, type Outcome, type VolumeDriver } from './driver';
import { NET_COPY_OUT, NET_PICK_BOARD } from './net-rules';
import type { Crumb, FsEntry, Listing } from './types';

const ROOT: Crumb = { label: 'NET:', path: 'NET:' };
const netPath = (...segs: string[]) => formatPath({ device: 'NET', segments: segs });
const MB = 1024 * 1024;
const iso = (ms: number) => new Date(ms).toISOString();

// ---- list -----------------------------------------------------------------------------------------------------

/** R6: online / offline 3 h, Transfer running, what waits, and the key Transfer shows (fw 1.19.0+). */
function boardMarks(t: SendTarget, waiting: number, sending: boolean, key: string | null, now: number): string[] {
  const marks = [targetState(t, now)];
  if (receiverRunning(t, sending, now)) marks.push('Transfer running');
  if (waiting) marks.push(`${waiting} waiting`);
  if (key) marks.push(`key ${key}`);
  return marks;
}

async function listBoards(ctx: FsCtx, now: number): Promise<Listing> {
  const db = getDb();
  const [targets, summaries, keys] = await Promise.all([
    listSendTargets(db, ctx.orgId, now), sendSummaries(db, ctx.orgId, new Date(now)), uploadBoards(db, ctx.orgId),
  ]);
  const entries = targets.map((t): FsEntry => {
    const s = summaries[t.id];
    const key = keys.find((k) => k.id === t.id)?.key ?? null;
    return { name: t.name, kind: 'board', path: netPath(t.id), size: null, date: null, protection: null, comment: null,
      marks: boardMarks(t, (s?.waiting ?? 0) + (s?.sending ?? 0), !!s?.sending, key, now) };
  });
  return { path: 'NET:', crumbs: [ROOT], entries, writable: false, readOnlyReason: NET_PICK_BOARD, disk: null,
    meta: targets.length ? `${targets.length} ${targets.length === 1 ? 'board' : 'boards'}` : 'No board can receive files yet — firmware 1.15.0 or newer' };
}

async function listQueue(ctx: FsCtx, t: SendTarget, now: number): Promise<Listing> {
  const db = getDb();
  const [rows, load] = await Promise.all([listTransfers(db, ctx.orgId, t.id), queueLoad(db, t.id, new Date(now))]);
  const entries = rows.map((row): FsEntry => {
    const view = toView(row, now);
    return { name: view.path, kind: 'file', path: netPath(t.id, row.id), size: view.sizeBytes, date: iso(view.createdAt),
      protection: protectionString(row.protection), comment: row.comment || null, marks: [transferState(view).text] };
  });
  return { path: netPath(t.id), crumbs: [ROOT, { label: t.name, path: netPath(t.id) }], entries, writable: true, readOnlyReason: null,
    disk: null, queue: { deviceId: t.id, ...load },
    meta: `${load.files} waiting · ${(load.bytes / MB).toFixed(1)} of ${SEND_QUEUE_MAX_BYTES / MB} MB` };
}

async function list(ctx: FsCtx, p: FsPath): Promise<Listing | null> {
  const now = Date.now();
  if (p.segments.length === 0) return listBoards(ctx, now);
  if (p.segments.length !== 1) return null;
  const t = await findSendTarget(getDb(), ctx.orgId, p.segments[0], now);
  return t ? listQueue(ctx, t, now) : null;
}

// ---- write ----------------------------------------------------------------------------------------------------

/** The board a path names, refused as not found unless it is this org's and can receive (C5: the whole op's 404). */
async function boardOf(ctx: FsCtx, id: string): Promise<SendTarget> {
  const t = await findSendTarget(getDb(), ctx.orgId, id);
  if (!t) refuse('not_found', 404);
  return t;
}

/**
 * A copy into NET:/<board>: every file of every top, by its path relative to the folder copied (NET: has no folders,
 * so an empty folder brings nothing). Refused whole before any byte is stored when a file is empty or over 4 MB, or
 * the copy does not fit beside what the board already holds; queueTransfers then holds the board's limits in one
 * transaction. NET: never clashes: Transfer saves Foo_2 rather than
 * overwrite, so `onClash` does not apply.
 */
async function write(ctx: OpCtx, dir: FsPath, tops: IncomingTop[]): Promise<Outcome> {
  if (dir.segments.length !== 1) refuse('unsupported', 400, 'send to a board, not into a folder');
  const t = await boardOf(ctx, dir.segments[0]);
  if (!ctx.userId) refuse('unsupported', 400, 'signed-in person required');
  const files = tops.flatMap((top) => top.items.filter((i) => i.kind === 'file').map((i) => ({ i, path: i.rel.join('/') })));
  for (const { i, path } of files) {
    const size = i.bytes?.length ?? i.size;
    if (size === undefined || (!i.bytes && !i.sha256)) refuse('failed', 500, `${path} came without its bytes`);
    if (size > SEND_FILE_MAX) refuse('too_large', 413, `${path} is over 4 MB`);
    if (size === 0) refuse('unsupported', 400, `${path} is empty`);
  }
  // Over the board's queue (32 files / 16 MB, counting what already waits): refused before a byte is stored.
  // queueTransfers holds the limit again in its transaction, against a send that lands meanwhile.
  const load = await queueLoad(getDb(), t.id);
  const bytes = files.reduce((n, { i }) => n + (i.bytes?.length ?? i.size!), 0);
  if (load.files + files.length > SEND_QUEUE_MAX_FILES || load.bytes + bytes > SEND_QUEUE_MAX_BYTES) refuse('queue_full', 409);
  // Bytes a copy brings (a disk's files, an archive's members) go into the store, verified (storeSendBytes); a STASH:
  // file is already there under its sha-256.
  const shas = await mapLimit(files, 12, ({ i }) => (i.sha256 ? Promise.resolve(i.sha256) : storeSendBytes(i.bytes!)));
  const queue: QueueFile[] = files.map(({ i, path }, k) => ({ path, sha256: shas[k], sizeBytes: i.bytes?.length ?? i.size!,
    protection: i.protection, comment: i.comment ?? '', ...(i.bytes ? { bytes: i.bytes } : {}) }));
  const r = await queueTransfers(getDb(), { orgId: ctx.orgId, deviceId: t.id, userId: ctx.userId, files: queue });
  if (!r.ok) {
    switch (r.reason) {
      case 'bad_name': return refuse('bad_name', 400, r.path);
      case 'too_large': return refuse('too_large', 413, `${r.path} is over 4 MB`);
      case 'empty': return refuse('unsupported', 400, `${r.path} is empty`);
      case 'queue_full': return refuse('queue_full', 409);
      case 'no_device': return refuse('not_found', 404);
      case 'no_blob': return refuse('failed', 409, `${r.path} is no longer stored`);
    }
  }
  return { kind: 'done', items: tops.map((top) => ({ source: top.source, ok: true })), queued: r.ids.length };
}

// ---- remove ---------------------------------------------------------------------------------------------------

/**
 * Delete (R4), per row: a waiting or sending one is cancelled, a finished (or lapsed) one cleared; a row that finished
 * between the listing and the click is cleared too. A board this org cannot send to refuses the whole op (C5); a row
 * that is not on the board the path names is not found, that item only.
 */
async function remove(ctx: OpCtx, sources: string[]): Promise<Outcome> {
  const db = getDb();
  const boards = new Map<string, SendTarget>();
  const parsed = sources.map((raw) => ({ raw, p: parsePath(raw) }));
  for (const { p } of parsed) {
    const id = p?.segments[0];
    if (id !== undefined && !boards.has(id)) boards.set(id, await boardOf(ctx, id));
  }
  const items: OpItem[] = [];
  for (const { raw, p } of parsed) {
    const ok = p?.device === 'NET' && p.segments.length === 2 && await (async () => {
      const [board, id] = p.segments;
      const [row] = await db.select({ id: transfers.id }).from(transfers)
        .where(and(eq(transfers.id, id), eq(transfers.orgId, ctx.orgId), eq(transfers.deviceId, board)));
      if (!row) return false;
      // Cleared first: a lapsed waiting row reads expired and goes, rather than turning into a cancelled one.
      return (await clearTransfer(db, ctx.orgId, id)) || (await cancelTransfer(db, ctx.orgId, id)) || clearTransfer(db, ctx.orgId, id);
    })();
    items.push(ok ? { source: raw, ok: true } : { source: raw, ok: false, refusal: { code: 'not_found' } });
  }
  return { kind: 'done', items };
}

// ---- the driver -----------------------------------------------------------------------------------------------

const copyOut = (): never => refuse('unsupported', 400, NET_COPY_OUT);

export const netDriver: VolumeDriver = {
  device: 'NET',
  list,
  read: async () => null,
  collect: async () => copyOut(),
  within: async () => copyOut(),
  write: (ctx, dir, tops) => write(ctx, dir, tops),
  remove: (ctx, sources) => remove(ctx, sources),
  mustRemove: async () => copyOut(),
};
