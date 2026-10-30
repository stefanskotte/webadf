// src/lib/files/net-driver.ts
// The NET: driver (Files spec 2026-10-29 §4.3, increment 3): NET: lists the org's boards that can receive files
// (firmware XFER_FW or newer), NET:/<deviceId> that board's Send-to-Amiga queue, each row addressed by its transfer id
// and named by its Amiga path (R1). A copy into NET:/<board> queues every file it brings, all or nothing (R3), keeping
// path, protection and comment (R2: Receive has no date). Delete cancels a waiting row and clears a finished one (R4).
// Nothing is copied or moved out of NET: (R5). A board that is not this org's, or cannot receive, is not found.
// NET: volumes (spec 2026-10-30 §4.3-4.6): NET:/<board> lists the Amiga's volumes then the Queue folder, the queue now
// being NET:/<board>/Queue; NET:/<board>/<Volume>/<drawer>/… is read, read-only, through a remote request the board
// answers (remote-requests.ts), remembered 2 minutes. SERVER ONLY.
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
import { latestFor, requestListing, type RemoteRow } from '@/lib/remote-requests';
import { browseBlock, errorWords } from '@/lib/remote-browse';
import { amigaPathOf, volumeLabel, type EntryInfo, type VolumeInfo } from '@/lib/remote-wire';
import { QUEUE_FOLDER } from '@/lib/remote-limits';
import { formatPath, parsePath, type FsPath } from './path';
import { Pending, refuse, type FsCtx, type IncomingTop, type OpCtx, type OpItem, type Outcome, type VolumeDriver } from './driver';
import { NET_COPY_OUT, NET_OPEN_VOLUME, NET_PICK_BOARD, NET_READ_ONLY, netEmpty } from './net-rules';
import type { Crumb, FsEntry, Listing } from './types';

const ROOT: Crumb = { label: 'NET:', path: 'NET:' };
const netPath = (...segs: string[]) => formatPath({ device: 'NET', segments: segs });
const MB = 1024 * 1024;
const iso = (ms: number) => new Date(ms).toISOString();

/** NET:/<board>/<Volume>/<entry>…: a file or drawer on a volume (not the volume itself, nor Queue): what a copy fetches (§4.5). */
export function isNetVolumePath(p: FsPath): boolean {
  return p.device === 'NET' && p.segments.length >= 3 && p.segments[1] !== QUEUE_FOLDER;
}

// ---- list -----------------------------------------------------------------------------------------------------

/** Whether `id` is a transfer of this org on this board: an old NET:/<board>/<transferId> path (§4.3). */
async function queueRowOf(ctx: FsCtx, board: string, id: string): Promise<boolean> {
  const [row] = await getDb().select({ id: transfers.id }).from(transfers)
    .where(and(eq(transfers.id, id), eq(transfers.orgId, ctx.orgId), eq(transfers.deviceId, board)));
  return !!row;
}

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
    return { name: view.path, kind: 'file', path: netPath(t.id, QUEUE_FOLDER, row.id), size: view.sizeBytes, date: iso(view.createdAt),
      protection: protectionString(row.protection), comment: row.comment || null, marks: [transferState(view).text] };
  });
  return { path: netPath(t.id, QUEUE_FOLDER), crumbs: [...boardCrumbs(t), { label: QUEUE_FOLDER, path: netPath(t.id, QUEUE_FOLDER) }],
    entries, writable: true, readOnlyReason: null, disk: null, queue: { deviceId: t.id, ...load },
    meta: `${load.files} waiting · ${(load.bytes / MB).toFixed(1)} of ${SEND_QUEUE_MAX_BYTES / MB} MB` };
}

const boardCrumbs = (t: SendTarget): Crumb[] => [ROOT, { label: t.name, path: netPath(t.id) }];
const freeText = (v: VolumeInfo) => `${(v.free / MB).toFixed(1)} MB free`;
type Answer = { volumes: VolumeInfo[]; entries: EntryInfo[] };
const answerOf = (row: RemoteRow) => (row.answer ?? { volumes: [], entries: [] }) as Answer;

/** §4.4: null when the board can be browsed now, else the first missing thing in the pane's words. */
export const browseOf = (t: SendTarget, now: number) => browseBlock({ online: t.online, firmware: t.firmwareVersion, rx: t.rx,
  rxProto: t.rxProto, browseOn: t.browseOn, name: t.name, offlineWords: targetState(t, now) });

/**
 * NET:/<board> (§5): the Amiga's volumes, in Transfer's order, then Queue. When they cannot be read (the board cannot be
 * browsed, or the volumes request failed) `net.browse` says why and Queue is listed alone: the queue works regardless.
 */
async function listBoardRoot(ctx: FsCtx, t: SendTarget, now: number, opts: { fresh?: boolean }): Promise<Listing> {
  const db = getDb();
  let block = browseOf(t, now);
  let volumes: VolumeInfo[] = [];
  let readAt: number | null = null;
  if (block === null) {
    const s = await requestListing(db, { orgId: ctx.orgId, deviceId: t.id, kind: 'vols', amigaPath: '', fresh: !!opts.fresh }, new Date(now));
    if (s.state === 'ready') { volumes = answerOf(s.row).volumes; readAt = now - s.ageMs; }
    else if (s.state === 'failed') block = errorWords(s.row.errorCode ?? '', s.row.errorText ?? '', t.name);
    else throw new Pending(`Reading volumes from ${t.name}…`);
  }
  const load = await queueLoad(db, t.id, new Date(now));
  const entries: FsEntry[] = volumes.map((v) => {
    const label = volumeLabel(v, volumes);
    return { name: label, kind: 'volume', path: netPath(t.id, label), size: null, sizeText: `${v.device} · ${freeText(v)}`,
      date: v.date, protection: null, comment: null, marks: [] };
  });
  entries.push({ name: QUEUE_FOLDER, kind: 'dir', path: netPath(t.id, QUEUE_FOLDER), size: null, date: null, protection: null,
    comment: null, marks: [`${load.files} waiting`] });
  return { path: netPath(t.id), crumbs: boardCrumbs(t), entries, writable: false, readOnlyReason: NET_OPEN_VOLUME, disk: null,
    net: { board: t.id, boardName: t.name, volume: null, amigaPath: null, readAt, cut: false, browse: block },
    meta: block ?? `${volumes.length} ${volumes.length === 1 ? 'volume' : 'volumes'}` };
}

/** The free space of the volume a pane is in, from a remembered volumes answer (never asked for on its own). */
async function volumeFree(t: SendTarget, volume: string, now: number): Promise<string> {
  const s = await latestFor(getDb(), t.id, 'vols', '', new Date(now));
  if (s.state !== 'ready') return '';
  const { volumes } = answerOf(s.row);
  const v = volumes.find((x) => volumeLabel(x, volumes) === volume);
  return v ? freeText(v) : '';
}

/**
 * NET:/<board>/<Volume>/<drawer>/… (§4.4, §4.6): a drawer as Transfer listed it; refused with the pane's words. Asked
 * and remembered by the path Transfer is sent (a labelled volume's device path); shown by the volume's label.
 */
async function listVolume(ctx: FsCtx, t: SendTarget, segs: string[], now: number, opts: { fresh?: boolean }): Promise<Listing | null> {
  const at = amigaPathOf(segs);
  if (!at) return null;
  const block = browseOf(t, now);
  if (block !== null) refuse('read_only', 409, block);
  const s = await requestListing(getDb(), { orgId: ctx.orgId, deviceId: t.id, kind: 'dir', amigaPath: at.amigaPath, fresh: !!opts.fresh }, new Date(now));
  if (s.state === 'failed') {
    const code = s.row.errorCode ?? '';
    const words = errorWords(code, s.row.errorText ?? '', t.name);
    if (code === 'notfound' || code === 'notdir') refuse('not_found', 404, words);
    if (code === 'timeout') refuse('failed', 504, words);
    refuse('read_only', 409, words);
  }
  if (s.state !== 'ready') throw new Pending(`Reading ${at.shown} from ${t.name}…`);
  const entries = answerOf(s.row).entries.map((e): FsEntry => ({ name: e.name, kind: e.dir ? 'dir' : 'file',
    path: netPath(t.id, ...segs, e.name), size: e.dir ? null : e.size, date: e.date, protection: protectionString(e.protection),
    comment: e.comment || null, marks: [] }));
  const crumbs: Crumb[] = [...boardCrumbs(t), { label: `${at.volume}:`, path: netPath(t.id, at.volume) },
    ...segs.slice(1).map((name, i) => ({ label: name, path: netPath(t.id, ...segs.slice(0, i + 2)) }))];
  return { path: netPath(t.id, ...segs), crumbs, entries, writable: false, readOnlyReason: NET_READ_ONLY, disk: null,
    net: { board: t.id, boardName: t.name, volume: at.volume, amigaPath: at.shown, readAt: now - s.ageMs, cut: !!s.row.cut, browse: null },
    meta: await volumeFree(t, at.volume, now) };
}

async function list(ctx: FsCtx, p: FsPath, opts: { fresh?: boolean } = {}): Promise<Listing | null> {
  const now = Date.now();
  if (p.segments.length === 0) return listBoards(ctx, now);
  const t = await findSendTarget(getDb(), ctx.orgId, p.segments[0], now);
  if (!t) return null;
  const [, second, ...rest] = p.segments;
  if (second === undefined) return listBoardRoot(ctx, t, now, opts);
  // Queue/<transferId> is a row, not a folder; so is an old NET:/<board>/<transferId> an open tab may hold (§4.3).
  if (second === QUEUE_FOLDER) return rest.length === 0 ? listQueue(ctx, t, now) : null;
  if (rest.length === 0 && await queueRowOf(ctx, t.id, second)) return null;
  return listVolume(ctx, t, p.segments.slice(1), now, opts);
}

// ---- write ----------------------------------------------------------------------------------------------------

/** The board a path names, refused as not found unless it is this org's and can receive (C5: the whole op's 404). */
async function boardOf(ctx: FsCtx, id: string): Promise<SendTarget> {
  const t = await findSendTarget(getDb(), ctx.orgId, id);
  if (!t) refuse('not_found', 404);
  return t;
}

/**
 * A copy into NET:/<board>/Queue (or the old NET:/<board>): every file of every top, by its path relative to the folder copied (NET: has no folders,
 * so an empty folder brings nothing). Refused whole before any byte is stored when a file is empty or over 4 MB, or
 * the copy does not fit beside what the board already holds; queueTransfers then holds the board's limits in one
 * transaction. NET: never clashes: Transfer saves Foo_2 rather than
 * overwrite, so `onClash` does not apply.
 */
async function write(ctx: OpCtx, dir: FsPath, tops: IncomingTop[]): Promise<Outcome> {
  if (dir.segments.length === 0) refuse('unsupported', 400, 'send to a board, not into a folder');
  const t = await boardOf(ctx, dir.segments[0]);
  const [, second, ...rest] = dir.segments;
  // A volume takes nothing in phase 1 (spec 2026-10-30 §5); a folder inside the queue is no place.
  if (second !== undefined && second !== QUEUE_FOLDER) refuse('read_only', 409, NET_READ_ONLY);
  if (rest.length) refuse('unsupported', 400, 'send to a board, not into a folder');
  if (!ctx.userId) refuse('unsupported', 400, 'signed-in person required');
  const files = tops.flatMap((top) => top.items.filter((i) => i.kind === 'file').map((i) => ({ i, path: i.rel.join('/') })));
  for (const { i, path } of files) {
    const size = i.bytes?.length ?? i.size;
    if (size === undefined || (!i.bytes && !i.sha256)) refuse('failed', 500, `${path} came without its bytes`);
    if (size > SEND_FILE_MAX) refuse('too_large', 413, `${path} is over 4 MB`);
    if (size === 0) refuse('unsupported', 400, netEmpty(path));
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
      case 'empty': return refuse('unsupported', 400, netEmpty(r.path ?? 'A file'));
      case 'queue_full': return refuse('queue_full', 409);
      case 'no_device': return refuse('not_found', 404);
      case 'no_blob': return refuse('failed', 409, `${r.path} is no longer stored`);
    }
  }
  return { kind: 'done', items: tops.map((top) => ({ source: top.source, ok: true })), queued: r.ids.length };
}

// ---- remove ---------------------------------------------------------------------------------------------------

/**
 * Delete (R4), per row (NET:/<board>/Queue/<id>, or the old NET:/<board>/<id> an open tab may hold): a waiting or
 * sending one is cancelled, a finished (or lapsed) one cleared; a row that finished between the listing and the click
 * is cleared too. A board this org cannot send to refuses the whole op (C5); a row
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
    const named = p?.device !== 'NET' ? null
      : p.segments.length === 3 && p.segments[1] === QUEUE_FOLDER ? [p.segments[0], p.segments[2]]
        : p.segments.length === 2 && p.segments[1] !== QUEUE_FOLDER ? p.segments : null;
    const ok = named !== null && await (async () => {
      const [board, id] = named;
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
