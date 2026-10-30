// src/lib/files/net-fetch.ts
// NET: volumes, copy out of a volume (spec 2026-10-30 §4.5): a copy from NET:/<board>/<Volume>/… becomes one get per
// file, all under one fetch id. Drawers expand only from listings the Amiga answered within the last 2 minutes (P3);
// clashes are decided now, against the destination's names (P4). The board relays Transfer's upload with the get's id,
// so openUpload stores it at the copy's target (source 'copy', P6) and, once closed, placeFetched settles the get --
// adding a disk image to the library first when the copy was onto LIBRARY: (P5). SERVER ONLY.
import { and, asc, eq, inArray } from 'drizzle-orm';
import { getDb, type Db } from '@/db';
import { devices } from '@/db/schema/devices';
import { amigaUploads } from '@/db/schema/amiga-uploads';
import { remoteRequests } from '@/db/schema/remote-requests';
import { findSendTarget } from '@/lib/send-targets';
import { addGets, expireStale, latestFor, liveGet, settleGet, type GetTarget, type RemoteRow } from '@/lib/remote-requests';
import { amigaPathOf, newRequestId, type EntryInfo } from '@/lib/remote-wire';
import { errorWords } from '@/lib/remote-browse';
import { FETCH_MAX_BYTES, FETCH_MAX_FILES } from '@/lib/remote-limits';
import { UPLOAD_FILE_MAX } from '@/lib/amiga-upload-limits';
import { libraryEligible } from '@/lib/from-amiga-ui';
import { listStash } from '@/lib/stash';
import { addUploadToLibrary } from '@/lib/stash-library';
import { addGameToCollection } from '@/lib/collections';
import { formatPath, parsePath, type FsPath } from './path';
import { refuse, skippedItem, type Clash, type CopyMove, type OpCtx, type OpItem, type Outcome } from './driver';
import { browseOf, isNetVolumePath } from './net-driver';
import { shelfDest } from './shelf';
import { ADDED_UNFILED } from './shelf-rules';
import { keepBothName, sameStashName, stashFind, stashTree } from './stash-paths';

const NET_READ_ONLY = 'Read-only for now';
const RELIST = 'List the drawer again and retry';
const MB = 1024 * 1024;

type File = { amigaPath: string; rel: string[]; size: number };
type Top = { source: string; dir: boolean; files: File[] };

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
  if (!e.dir) return { source, dir: false, files: [{ amigaPath: pathOf(segs), rel: [e.name], size: e.size }] };
  const files: File[] = [];
  if (!walkDrawers) return { source, dir: true, files };
  const walk = async (at: string[], rel: string[]) => {
    for (const c of await remembered(deviceId, at, now)) {
      if (c.dir) await walk([...at, c.name], [...rel, c.name]);
      else files.push({ amigaPath: pathOf([...at, c.name]), rel: [...rel, c.name], size: c.size });
    }
  };
  await walk(segs, [e.name]);
  return { source, dir: true, files };
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
  if (req.op === 'move') refuse('read_only', 409, NET_READ_ONLY);
  const t = await findSendTarget(getDb(), ctx.orgId, board!, now.getTime());
  if (!t) refuse('not_found', 404);
  const block = browseOf(t, now.getTime());
  if (block !== null) refuse('read_only', 409, block);
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
  const files = tops.flatMap((top) => top.files.map((f) => ({ amigaPath: f.amigaPath,
    target: { dest: formatPath(dest), rel: f.rel, replace: replace.has(top), library } satisfies GetTarget })));
  await addGets(getDb(), { orgId: ctx.orgId, deviceId: t.id, fetchId, files }, now);
  for (const top of tops) if (!results.has(top.source)) results.set(top.source, { source: top.source, ok: true });
  return { kind: 'done', items: req.sources.map((s) => results.get(s)!), ...(files.length ? { fetching: { id: fetchId, files: files.length } } : {}) };
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
  if (target.library) {
    const r = await addUploadToLibrary(g.orgId, uploadId);
    if (!r.ok) return settleGet(db, g.id, { ok: false, code: r.error, text: r.reason ?? LIBRARY_WORDS[r.error] }, now);
    if (target.library.collectionId && !(await addGameToCollection(g.orgId, target.library.collectionId, r.gameId))) {
      return settleGet(db, g.id, { ok: false, code: 'not_found', text: ADDED_UNFILED }, now);
    }
  }
  await settleGet(db, g.id, { ok: true }, now);
}

export type FetchProgress = {
  total: number; done: number; failed: { name: string; reason: string }[]; waiting: number; board: string; arrived: string[];
};

/**
 * One copy's progress (§4.5), this org's only. A get the board has not fetched (offline) waits without a timeout of its
 * own; one sent and not done within 10 minutes fails "<board> stopped answering" (expireStale).
 */
export async function fetchProgress(db: Db, orgId: string, fetchId: string, now: Date): Promise<FetchProgress | null> {
  await expireStale(db, now);
  const rows = await db.select().from(remoteRequests)
    .where(and(eq(remoteRequests.fetchId, fetchId), eq(remoteRequests.orgId, orgId), eq(remoteRequests.kind, 'get')))
    .orderBy(asc(remoteRequests.createdAt), asc(remoteRequests.id));
  if (rows.length === 0) return null;
  const [d] = await db.select({ name: devices.name }).from(devices).where(eq(devices.id, rows[0].deviceId));
  const board = d?.name ?? 'The board';
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
    total: rows.length, done: rows.filter((r) => r.status === 'done').length, failed,
    waiting: rows.filter((r) => r.status !== 'done' && r.status !== 'failed').length, board,
    arrived: doneIds.flatMap((id) => (paths.has(id) ? [formatPath({ device: 'STASH', segments: paths.get(id)!.split('/') })] : [])),
  };
}
