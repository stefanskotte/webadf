// src/lib/files/net-fetch.ts
// NET: volumes, copy out of a volume (spec 2026-10-30 §4.5): a copy from NET:/<board>/<Volume>/… becomes one get per
// file, all under one fetch id. Drawers expand only from listings the Amiga answered within the last 2 minutes (P3);
// clashes are decided now, against the destination's names (P4). The board relays Transfer's upload with the get's id,
// so openUpload stores it at the copy's target (source 'copy', P6) and, once closed, placeFetched settles the get --
// adding a disk image to the library first when the copy was onto LIBRARY: (P5). Phase 2 (spec 2026-10-31 §4.1): a
// move out of a volume deletes each source once its files are stored (net-moves.ts); a copy or move onto another volume
// fetches each file and hands it to that board's queue as it arrives (plan W8); the progress covers every part of a job
// (jobProgress). SERVER ONLY.
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { getDb, type Db } from '@/db';
import { devices } from '@/db/schema/devices';
import { amigaUploads } from '@/db/schema/amiga-uploads';
import { remoteRequests } from '@/db/schema/remote-requests';
import { transfers } from '@/db/schema/transfers';
import { findSendTarget } from '@/lib/send-targets';
import { addGets, addWrites, dropMemory, expireStale, latestFor, liveGet, settleGet, type GetTarget, type RemoteRow, type WriteReq, type WriteTarget } from '@/lib/remote-requests';
import { amigaPathOf, newRequestId, type EntryInfo } from '@/lib/remote-wire';
import { errorWords, MOVE_OLD_TRANSFER, writeErrorWords } from '@/lib/remote-browse';
import { MOVE_PROTO, WRITE_KINDS } from '@/lib/remote-limits';
import { failureText } from '@/lib/send-ui';
import { queueTransfers, type ClashMode } from '@/lib/transfers';
import { FETCH_MAX_BYTES, FETCH_MAX_FILES } from '@/lib/remote-limits';
import { UPLOAD_FILE_MAX } from '@/lib/amiga-upload-limits';
import { libraryEligible } from '@/lib/from-amiga-ui';
import { listStash } from '@/lib/stash';
import { addUploadToLibrary } from '@/lib/stash-library';
import { addGameToCollection } from '@/lib/collections';
import { formatPath, parsePath, type FsPath } from './path';
import { refuse, skippedItem, type Clash, type CopyMove, type OpCtx, type OpItem, type Outcome } from './driver';
import { browseOf, isNetVolumePath } from './net-driver';
import { clashMode, joinAmiga, moveWithinVolume, mustRemoveOnVolume, placeOf, sameVolume, writableBoard } from './net-write';
import { settleMoveOfGet, settleMoveOfTransfer, settleMovesOfJob } from './net-moves';
import { shelfDest } from './shelf';
import { ADDED_UNFILED } from './shelf-rules';
import { keepBothName, sameStashName, stashFind, stashTree } from './stash-paths';

const RELIST = 'List the drawer again and retry';
const MB = 1024 * 1024;

type File = { amigaPath: string; rel: string[]; size: number };
/** `drawers`: every drawer of a drawer top as the walk found it, the top included (Amiga paths): what a move removes. */
type Top = { source: string; dir: boolean; files: File[]; drawers: string[] };

/** The remembered entries of `segs` (volume first) on the board, or the op refused: P3 never asks the Amiga here. */
async function remembered(deviceId: string, segs: string[], now: Date): Promise<EntryInfo[]> {
  const at = amigaPathOf(segs);
  if (!at) refuse('not_found', 404);
  const s = await latestFor(getDb(), deviceId, 'dir', at.amigaPath, now);
  if (s.state !== 'ready') refuse('conflict', 409, RELIST);
  return ((s.row.answer ?? { entries: [] }) as { entries: EntryInfo[] }).entries;
}

/**
 * One source walked: a file, or every file under a drawer (an empty drawer brings nothing), rel[0] its own name. With
 * `walkDrawers` false a drawer is not walked (onto LIBRARY:, where it is refused whole): it brings nothing.
 */
async function expand(deviceId: string, source: string, segs: string[], now: Date, walkDrawers = true): Promise<Top> {
  const name = segs[segs.length - 1];
  const e = (await remembered(deviceId, segs.slice(0, -1), now)).find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!e) refuse('conflict', 409, RELIST);
  const pathOf = (s: string[]) => amigaPathOf(s)!.amigaPath;
  if (!e.dir) return { source, dir: false, files: [{ amigaPath: pathOf(segs), rel: [e.name], size: e.size }], drawers: [] };
  const files: File[] = [];
  const drawers: string[] = [];
  if (!walkDrawers) return { source, dir: true, files, drawers };
  const walk = async (at: string[], rel: string[]) => {
    drawers.push(pathOf(at));
    for (const c of await remembered(deviceId, at, now)) {
      if (c.dir) await walk([...at, c.name], [...rel, c.name]);
      else files.push({ amigaPath: pathOf([...at, c.name]), rel: [...rel, c.name], size: c.size });
    }
  };
  await walk(segs, [e.name]);
  return { source, dir: true, files, drawers };
}

/** Where the copy goes: a STASH: folder, or the library (its root or a collection) by way of the STASH: root (P5). */
async function destOf(ctx: OpCtx, raw: string): Promise<{ dest: FsPath; library: GetTarget['library'] }> {
  const p = parsePath(raw);
  if (!p) refuse('not_found', 404);
  if (p.device === 'STASH') return { dest: p, library: null };
  const shelf = await shelfDest(ctx, p);
  if (shelf?.level === 'title') refuse('unsupported', 400, 'Copy onto LIBRARY: or a collection');
  if (shelf) return { dest: { device: 'STASH', segments: [] }, library: { collectionId: shelf.collection?.id ?? null } };
  return refuse('unsupported', 400, 'Copy to STASH: or LIBRARY:');
}

/** Copy out of a NET: volume (§4.5): one get per file, all or nothing against the limits; refused before any is asked. */
export async function startFetch(ctx: OpCtx, req: CopyMove): Promise<Outcome> {
  const now = new Date();
  const srcs = req.sources.map((s) => parsePath(s));
  const board = srcs[0]?.segments[0];
  if (!srcs.every((p): p is FsPath => !!p && isNetVolumePath(p) && p.segments[0] === board)) refuse('unsupported', 400, 'Copy from one board at a time');
  // A move asks first whether the Amiga can delete the sources (the write switch); each goes once its files are stored.
  if (req.op === 'move') await mustRemoveOnVolume(ctx, req.sources);
  const t = await findSendTarget(getDb(), ctx.orgId, board!, now.getTime());
  if (!t) refuse('not_found', 404);
  const block = browseOf(t, now.getTime());
  if (block !== null) refuse('read_only', 409, block);
  // A move removes only what it copied, one object at a time (spec 2026-10-31 §9): Transfer 2.6, or Copy.
  if (req.op === 'move') mustMoveOff(t);
  const { dest, library } = await destOf(ctx, req.dest);

  const results = new Map<string, OpItem>();
  const tops: Top[] = [];
  for (const [i, p] of (srcs as FsPath[]).entries()) {
    const top = await expand(t.id, req.sources[i], p.segments.slice(1), now, !library);
    // Onto LIBRARY: only a disk image goes (the existing Add to library reason for anything else; a drawer, unwalked,
    // as a folder -- the words the pane refuses it with before asking, shelf-rules NOT_A_FOLDER).
    if (library && (top.dir || !libraryEligible(top.files[0].rel[0], top.files[0].size))) {
      results.set(top.source, { source: top.source, ok: false, refusal: { code: 'not_a_disk_image', ...(top.dir ? { detail: 'a folder' } : {}) } });
    } else tops.push(top);
  }
  const all = tops.flatMap((x) => x.files);
  const big = all.find((f) => f.size > UPLOAD_FILE_MAX);
  if (big) refuse('too_large', 413, `${big.rel.join('/')} is over 4 MB`);
  if (all.length > FETCH_MAX_FILES) refuse('too_large', 413, `at most ${FETCH_MAX_FILES} files at a time`);
  if (all.reduce((n, f) => n + f.size, 0) > FETCH_MAX_BYTES) refuse('too_large', 413, `at most ${FETCH_MAX_BYTES / MB} MB at a time`);

  // P4: a top whose name the destination folder holds. The library's way in (the STASH: root) always keeps both.
  const replace = new Set<Top>();
  if (!library) {
    const node = stashFind(stashTree((await listStash(getDb(), ctx.orgId, now)).filter((r) => r.status !== 'failed')), dest.segments);
    const taken = (n: string) => !!node && node.kind === 'dir' && node.children.some((c) => sameStashName(c.name, n));
    const clashes: Clash[] = tops.filter((x) => taken(x.files[0]?.rel[0] ?? '')).map((x) => ({ source: x.source, name: x.files[0].rel[0], dest: formatPath(dest) }));
    if (clashes.length && req.onClash === 'ask') return { kind: 'clashes', clashes };
    for (const c of clashes) {
      const top = tops.find((x) => x.source === c.source)!;
      if (req.onClash === 'skip') { results.set(top.source, skippedItem(top.source)); top.files = []; }
      else if (req.onClash === 'replace') replace.add(top);
      else {
        // Keep both: the top takes its keep-both name now, so a drawer arrives beside the one there, not merged into it.
        const fresh = keepBothName(c.name, taken);
        for (const f of top.files) f.rel = [fresh, ...f.rel.slice(1)];
      }
    }
  }
  const fetchId = newRequestId();
  const move = req.op === 'move' ? (top: Top) => ({ moveSource: top.source, ...(top.drawers.length ? { moveDrawers: top.drawers } : {}),
    ...(ctx.userId ? { userId: ctx.userId } : {}) }) : () => ({});
  const files = tops.flatMap((top) => top.files.map((f) => ({ amigaPath: f.amigaPath,
    target: { dest: formatPath(dest), rel: f.rel, replace: replace.has(top), library, ...move(top) } satisfies GetTarget })));
  await addGets(getDb(), { orgId: ctx.orgId, deviceId: t.id, fetchId, files }, now);
  for (const top of tops) if (!results.has(top.source)) results.set(top.source, { source: top.source, ok: true });
  return { kind: 'done', items: req.sources.map((s) => results.get(s)!), ...(files.length ? { fetching: { id: fetchId, files: files.length } } : {}) };
}

/**
 * A copy or move from a volume onto a volume (spec 2026-10-31 §4.1). A move within one volume is a RENAME
 * (moveWithinVolume). Anything else goes up and down (plan W8): each file is fetched as a copy out is, and on arrival
 * handed to the destination board's queue with its absolute path and clash mode; a move's source goes once every file
 * of it is delivered there. Clashes are decided now against the destination's remembered listing (W4); drawers that
 * hold no file are made there (`ensure`).
 */
export async function volumeToVolume(ctx: OpCtx, req: CopyMove): Promise<Outcome> {
  const to = placeOf(parsePath(req.dest));
  if (!to) refuse('not_found', 404);
  const froms = req.sources.map((s) => placeOf(parsePath(s)));
  if (!froms.every((f) => !!f && f.segs.length >= 2)) refuse('unsupported', 400, 'Copy from one board at a time');
  if (req.op === 'move' && froms.every((f) => sameVolume(f!, to))) return moveWithinVolume(ctx, req.sources, req.dest, req.onClash);
  const now = new Date();
  const board = froms[0]!.board;
  if (!froms.every((f) => f!.board === board)) refuse('unsupported', 400, 'Copy from one board at a time');
  const t = await findSendTarget(getDb(), ctx.orgId, board, now.getTime());
  if (!t) refuse('not_found', 404);
  const block = browseOf(t, now.getTime());
  if (block !== null) refuse('read_only', 409, block);
  const dt = await writableBoard(ctx, to.board, now.getTime());
  if (req.op === 'move') { await mustRemoveOnVolume(ctx, req.sources); mustMoveOff(t); }
  const there = (await latestFor(getDb(), dt.id, 'dir', to.amiga, now));
  if (there.state !== 'ready') refuse('conflict', 409, RELIST);
  const entries = ((there.row.answer ?? { entries: [] }) as { entries: EntryInfo[] }).entries;

  const results = new Map<string, OpItem>();
  const tops: (Top & { name: string; mode: ClashMode; dirs: string[][] })[] = [];
  const clashes: Clash[] = [];
  const taken = (n: string) => entries.some((e) => sameStashName(e.name, n)) || tops.some((x) => sameStashName(x.name, n));
  for (const [i, f] of froms.entries()) {
    const top = await expand(t.id, req.sources[i], f!.segs, now);
    const name = f!.segs[f!.segs.length - 1];
    const dirs = top.dir ? await drawersOf(t.id, f!.segs, now) : [];
    if (!entries.some((e) => sameStashName(e.name, name))) { tops.push({ ...top, name, mode: clashMode(req.onClash), dirs }); continue; }
    if (req.onClash === 'ask') { clashes.push({ source: top.source, name, dest: req.dest }); continue; }
    if (req.onClash === 'skip') { results.set(top.source, skippedItem(top.source)); continue; }
    if (req.onClash === 'replace') { tops.push({ ...top, name, mode: 'replace', dirs }); continue; }
    tops.push({ ...top, name: keepBothName(name, taken), mode: 'keep', dirs });
  }
  if (clashes.length) return { kind: 'clashes', clashes };
  const all = tops.flatMap((x) => x.files);
  const big = all.find((f) => f.size > UPLOAD_FILE_MAX);
  if (big) refuse('too_large', 413, `${big.rel.join('/')} is over 4 MB`);
  if (all.length > FETCH_MAX_FILES) refuse('too_large', 413, `at most ${FETCH_MAX_FILES} files at a time`);
  if (all.reduce((n, f) => n + f.size, 0) > FETCH_MAX_BYTES) refuse('too_large', 413, `at most ${FETCH_MAX_BYTES / MB} MB at a time`);

  const job = newRequestId();
  const gets = tops.flatMap((top) => top.files.map((f) => {
    const rel = [top.name, ...f.rel.slice(1)];
    return { amigaPath: f.amigaPath, target: { dest: 'STASH:', rel: [rel[rel.length - 1]], replace: false, library: null,
      relay: { deviceId: dt.id, dest: joinAmiga(to.amiga, ...rel), onClash: top.mode, ...(req.op === 'move' ? { moveSource: top.source } : {}) },
      ...(req.op === 'move' && top.drawers.length ? { moveDrawers: top.drawers } : {}),
      ...(ctx.userId ? { userId: ctx.userId } : {}) } satisfies GetTarget };
  }));
  // Drawers holding no file arrive by a Makedir each on the destination (parents first; one there already is as good).
  const holds = (rel: string[]) => tops.some((x) => x.files.some((f) => { const r = [x.name, ...f.rel.slice(1)]; return r.length > rel.length && rel.every((s, k) => sameStashName(s, r[k])); }));
  // A move's Makedirs are parts of it (spec §9): its source goes only once they are made too.
  const mk: WriteReq[] = tops.flatMap((top) => top.dirs.map((d) => [top.name, ...d]).filter((rel) => !holds(rel))
    .flatMap((rel) => rel.map((_, k) => ({ rel: rel.slice(0, k + 1), source: top.source }))))
    .filter((x, k, list) => list.findIndex((y) => y.rel.join('/').toLowerCase() === x.rel.join('/').toLowerCase()) === k)
    .map(({ rel, source }) => ({ kind: 'mkdir', amigaPath: joinAmiga(to.amiga, ...rel), ensure: true, label: joinAmiga(to.shown, ...rel),
      ...(req.op === 'move' ? { move: { source } } : {}) }));
  if (mk.length) await addWrites(getDb(), { orgId: ctx.orgId, deviceId: dt.id, jobId: job, writes: mk }, now);
  await addGets(getDb(), { orgId: ctx.orgId, deviceId: t.id, fetchId: job, files: gets }, now);
  for (const top of tops) results.set(top.source, { source: top.source, ok: true });
  return { kind: 'done', items: req.sources.map((s) => results.get(s)!),
    ...(gets.length + mk.length ? { job: { id: job, files: gets.length, writes: mk.length } } : {}) };
}

/** A Move that copies off a volume removes only what it copied, by DELETE … one: Transfer 2.6 (spec 2026-10-31 §9). */
function mustMoveOff(t: { rxProto: number | null }) {
  if ((t.rxProto ?? 0) < MOVE_PROTO) refuse('unsupported', 409, MOVE_OLD_TRANSFER);
}

/** Every drawer below a remembered drawer, as paths relative to it (for the Makedirs of empty ones). */
async function drawersOf(deviceId: string, segs: string[], now: Date): Promise<string[][]> {
  const out: string[][] = [[]];
  const walk = async (at: string[], rel: string[]) => {
    for (const c of await remembered(deviceId, at, now)) if (c.dir) { out.push([...rel, c.name]); await walk([...at, c.name], [...rel, c.name]); }
  };
  await walk(segs, []);
  return out;
}

const LIBRARY_WORDS: Record<string, string> = {
  not_found: 'it is no longer in STASH:', not_a_disk_image: 'not a disk image', refused: 'the library refused it',
  ingest_failed: 'the library could not take it',
};

/**
 * After a stored close of an upload a get asked for: the library's part when the copy was onto LIBRARY:, then settled.
 * Never throws: the file is stored whatever happens here, so the board hears ok and the get alone fails (`io`).
 */
export async function placeFetched(db: Db, uploadId: string, now = new Date()): Promise<void> {
  // A get that timed out while its file was on the way is placed all the same (fix round 1 ruling): the file is here.
  const [g] = await db.select().from(remoteRequests).where(and(eq(remoteRequests.uploadId, uploadId), eq(remoteRequests.kind, 'get'), liveGet()));
  if (!g) return;
  try { await place(db, g, uploadId, now); } catch {
    await settleGet(db, g.id, { ok: false, code: 'io', text: 'it could not be placed' }, now).catch(() => {});
  }
}

async function place(db: Db, g: RemoteRow, uploadId: string, now: Date): Promise<void> {
  const target = g.target as GetTarget;
  if (target.relay) return relay(db, g, target, uploadId, now);
  if (target.library) {
    const r = await addUploadToLibrary(g.orgId, uploadId);
    if (!r.ok) return settleGet(db, g.id, { ok: false, code: r.error, text: r.reason ?? LIBRARY_WORDS[r.error] }, now);
    if (target.library.collectionId && !(await addGameToCollection(g.orgId, target.library.collectionId, r.gameId))) {
      return settleGet(db, g.id, { ok: false, code: 'not_found', text: ADDED_UNFILED }, now);
    }
  }
  await settleGet(db, g.id, { ok: true }, now);
  // A move out of a volume: its source goes once every file of it is stored (plan W7).
  if (target.moveSource) await settleMoveOfGet(db, g.id);
}

/**
 * A file on its way from one volume to another (plan W8): handed to the destination board's queue with its absolute
 * path and clash mode, then its STASH: row goes (it was only passing through). A queue that refuses it fails the get
 * with the words, and the file stays in STASH:, so nothing is lost.
 */
async function relay(db: Db, g: RemoteRow, target: GetTarget, uploadId: string, now: Date): Promise<void> {
  const r = target.relay!;
  const [u] = await db.select().from(amigaUploads).where(eq(amigaUploads.id, uploadId));
  if (!u?.blobSha256 || !target.userId) return settleGet(db, g.id, { ok: false, code: 'io', text: 'it could not be placed' }, now);
  const q = await queueTransfers(db, { orgId: g.orgId, deviceId: r.deviceId, userId: target.userId, jobId: g.fetchId ?? undefined, now, files: [{
    path: target.rel[target.rel.length - 1], sha256: u.blobSha256, sizeBytes: u.sizeBytes, protection: Number(u.protection), comment: u.comment,
    dest: r.dest, onClash: r.onClash, ...(r.moveSource ? { moveSource: r.moveSource } : {}) }] });
  if (!q.ok) {
    const words = q.reason === 'queue_full' ? "the board's queue is full" : q.reason === 'empty' ? 'it is empty' : 'it could not be queued';
    return settleGet(db, g.id, { ok: false, code: q.reason, text: words }, now);
  }
  await db.update(amigaUploads).set({ status: 'deleted' }).where(eq(amigaUploads.id, uploadId));
  await settleGet(db, g.id, { ok: true }, now);
}

/** After the board reported a queue row (the done route): a move onto a volume removes its source once all arrived. */
export async function afterTransferDone(db: Db, transferId: string): Promise<void> {
  await settleMoveOfTransfer(db, transferId);
  // The drawers a copy onto a volume changed are read afresh once the batch is through (plan W12): not file by file,
  // so a pane does not re-read the drawer (and wait behind the next file) between each.
  const [row] = await db.select({ deviceId: transfers.deviceId, dest: transfers.amigaDest, jobId: transfers.jobId }).from(transfers)
    .where(eq(transfers.id, transferId));
  if (!row?.dest) return;
  const volume = row.dest.slice(0, row.dest.indexOf(':') + 1).toLowerCase();
  const [busy] = await db.select({ id: transfers.id }).from(transfers).where(and(eq(transfers.deviceId, row.deviceId),
    inArray(transfers.status, ['queued', 'sending']), sql`lower(${transfers.amigaDest}) like ${`${volume.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}`)).limit(1);
  if (busy) return;
  const dests = row.jobId
    ? (await db.select({ dest: transfers.amigaDest }).from(transfers).where(eq(transfers.jobId, row.jobId))).map((x) => x.dest).filter((x): x is string => !!x)
    : [row.dest];
  const drawers = new Set<string>();
  for (const dest of dests) for (let at = amigaParentOf(dest); ; at = amigaParentOf(at)) { drawers.add(at); if (at.endsWith(':')) break; }
  await dropMemory(db, row.deviceId, [...drawers]);
}

const amigaParentOf = (path: string) => {
  const c = path.indexOf(':');
  const slash = path.lastIndexOf('/');
  return slash > c ? path.slice(0, slash) : path.slice(0, c + 1);
};

/**
 * One write of a job as the pane says it: `to` a RENAME's new path (in the pane's words where it can be), `entry` the
 * entry a DELETE stopped at (Transfer's text names it: "Libs/foo.library: object in use").
 */
export type JobWrite = { kind: string; label: string; to: string | null; status: 'waiting' | 'running' | 'done' | 'failed'; removed: number;
  reason: string | null; entry: string | null;
  /** An icon taken along or a drawer a copy needed: said only when it failed. */
  quiet: boolean;
  /** A move's removal that kept a drawer because something new is in it (spec 2026-10-31 §9): said, not a failure. */
  kept: boolean };
/**
 * A job's progress. `total`/`done`/`failed`/`waiting`: its files -- gets (a copy out) and queue rows (a copy onto a
 * volume; a relayed file once handed over); `skipped`: queue rows Transfer skipped; `writes`: its one-line writes.
 */
export type FetchProgress = {
  total: number; done: number; failed: { name: string; reason: string }[]; waiting: number; board: string; arrived: string[];
  skipped: number; writes: JobWrite[];
  /** `to`: the files go onto the Amiga (queue rows, or relayed); `from`: a copy out of a volume. */
  direction: 'to' | 'from';
};

/**
 * One copy's progress (§4.5), this org's only. A get the board has not fetched (offline) waits without a timeout of its
 * own; one sent and not done within 10 minutes fails "<board> stopped answering" (expireStale).
 */
export async function fetchProgress(db: Db, orgId: string, fetchId: string, now: Date): Promise<FetchProgress | null> {
  await expireStale(db, now);
  // A move whose parts all ended -- however they ended -- is settled here, so the job finishes (final review C2).
  await settleMovesOfJob(db, orgId, fetchId);
  const reqs = await db.select().from(remoteRequests)
    .where(and(eq(remoteRequests.fetchId, fetchId), eq(remoteRequests.orgId, orgId)))
    .orderBy(asc(remoteRequests.createdAt), asc(remoteRequests.id));
  const sent = await db.select().from(transfers).where(and(eq(transfers.jobId, fetchId), eq(transfers.orgId, orgId)))
    .orderBy(asc(transfers.createdAt), asc(transfers.id));
  if (reqs.length === 0 && sent.length === 0) return null;
  // The board the job is about: a copy onto a volume names the destination, a copy out the source.
  const boardId = sent[0]?.deviceId ?? reqs.find((r) => r.kind !== 'get')?.deviceId ?? reqs[0].deviceId;
  const [d] = await db.select({ name: devices.name }).from(devices).where(eq(devices.id, boardId));
  const board = d?.name ?? 'The board';
  // A move's get is not finished until its source is deleted (net-moves.ts drops the marker after).
  const moving = (r: RemoteRow) => r.status === 'done' && !!(r.target as GetTarget | null)?.moveSource;
  // A relayed file is its queue row once handed over: the get then counts no more.
  const rows = reqs.filter((r) => r.kind === 'get' && !((r.target as GetTarget).relay && r.status === 'done'));
  const writes: JobWrite[] = reqs.filter((r) => (WRITE_KINDS as readonly string[]).includes(r.kind)).map((r) => {
    const t = (r.target ?? {}) as WriteTarget;
    const status = r.status === 'waiting' ? 'waiting' : r.status === 'sent' ? 'running' : r.status === 'done' ? 'done' : 'failed';
    const text = r.errorText ?? '';
    const entry = r.kind === 'delete' && status === 'failed' && text.includes(': ') ? text.slice(0, text.indexOf(': ')) : null;
    return { kind: r.kind, label: t.label ?? r.amigaPath, to: t.to ?? null, status, removed: (r.answer as { removed?: number } | null)?.removed ?? 0,
      reason: status === 'failed' ? writeErrorWords(r.errorCode ?? '', text, board) : null, entry, quiet: !!(t.icon || t.ensure),
      kept: status === 'done' && !!((r.answer as { kept?: boolean } | null)?.kept || t.kept) };
  });
  const sentFailed = sent.filter((x) => x.status === 'failed' || x.status === 'expired' || x.status === 'cancelled').map((x) => ({
    name: x.path, reason: x.status === 'expired' ? `${board} did not take it within 24 h` : x.status === 'cancelled' ? 'cancelled'
      // A copy onto a volume's FILE refusals (Transfer 2.5): busy there is the old file in use, not Transfer busy.
      : x.amigaDest && ['readonly', 'wprot', 'full', 'denied', 'busy'].includes(x.errorCode ?? '') ? writeErrorWords(x.errorCode!, x.errorText ?? '', board)
      : failureText(x.errorCode, x.errorText),
  }));
  // A move's file is not finished until its source is removed (net-moves.ts clears the marker after).
  const settling = (x: { status: string; moveSource: string | null }) => x.status === 'delivered' && x.moveSource !== null;
  const sentCounts = {
    total: sent.length, done: sent.filter((x) => x.status === 'delivered' && !settling(x)).length,
    skipped: sent.filter((x) => x.status === 'skipped').length,
    waiting: sent.filter((x) => x.status === 'queued' || x.status === 'sending' || settling(x)).length,
  };
  const doneIds = rows.filter((r) => r.status === 'done' && r.uploadId).map((r) => r.uploadId!);
  const paths = doneIds.length
    ? new Map((await db.select({ id: amigaUploads.id, path: amigaUploads.path }).from(amigaUploads)
      .where(and(inArray(amigaUploads.id, doneIds), eq(amigaUploads.orgId, orgId)))).map((u) => [u.id, u.path] as const))
    : new Map<string, string>();
  const failed = rows.filter((r) => r.status === 'failed').map((r) => {
    const rel = (r.target as GetTarget).rel;
    const reason = r.errorCode === 'timeout' ? `${board} stopped answering` : errorWords(r.errorCode ?? '', r.errorText ?? '', board);
    return { name: rel[rel.length - 1], reason };
  });
  return {
    total: rows.length + sentCounts.total, done: rows.filter((r) => r.status === 'done' && !moving(r)).length + sentCounts.done,
    failed: [...failed, ...sentFailed],
    waiting: rows.filter((r) => (r.status !== 'done' && r.status !== 'failed') || moving(r)).length + sentCounts.waiting, board,
    arrived: doneIds.flatMap((id) => (paths.has(id) ? [formatPath({ device: 'STASH', segments: paths.get(id)!.split('/') })] : [])),
    skipped: sentCounts.skipped, writes,
    direction: sent.length || reqs.some((r) => r.kind === 'get' && (r.target as GetTarget).relay) ? 'to' : 'from',
  };
}
