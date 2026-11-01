// src/lib/files/net-write.ts
// NET: volumes phase 2 (spec 2026-10-31 §4.1): the Files operations that change the Amiga's own disks, turned into what
// the board carries -- one remote request per Makedir, Rename, Delete, Protect or comment (MKDIR, RENAME, DELETE,
// PROTECT, NOTE), and one queue row per file of a copy onto a volume (the extended FILE). Every request and row of one
// operation shares a job id; the pane follows the job (jobProgress). Nothing here waits for the Amiga: an op answers
// once its requests are queued, and refuses at once when the board cannot write (writeBlock). SERVER ONLY.
import { getDb, type Db } from '@/db';
import { findSendTarget } from '@/lib/send-targets';
import { targetState, type SendTarget } from '@/lib/send-ui';
import { storeSendBytes } from '@/lib/send-http';
import { mapLimit } from '@/lib/pool';
import { MOVE_OLD_TRANSFER, writeBlock } from '@/lib/remote-browse';
import { addWrites, latestFor, type WriteReq } from '@/lib/remote-requests';
import { amigaPathOf, newRequestId, type EntryInfo } from '@/lib/remote-wire';
import { DRAWER_ICON_PROTO, FETCH_MAX_BYTES, FETCH_MAX_FILES, MOVE_PROTO, QUEUE_FOLDER } from '@/lib/remote-limits';
import { SEND_FILE_MAX, queueTransfers, type ClashMode, type QueueFile } from '@/lib/transfers';
import { formatPath, parsePath, type FsPath } from './path';
import {
  checkComment, checkName, refuse, skippedItem, type Clash, type FsCtx, type IncomingTop, type OnClash, type OpCtx, type OpItem, type Outcome,
} from './driver';
import { keepBothName, sameStashName } from './stash-paths';

export const RELIST = 'List the drawer again and retry';
const MB = 1024 * 1024;
const INFO = '.info';

/** NET:/<board>/<Volume>/<entry>…: a file or drawer on a volume (not the volume itself, nor Queue). */
export function isNetVolumePath(p: FsPath): boolean {
  return p.device === 'NET' && p.segments.length >= 3 && p.segments[1] !== QUEUE_FOLDER;
}
/** NET:/<board>/<Volume>[/<drawer>…]: a volume or a drawer on one, a place things can be made or copied into. */
export function isNetVolumeDir(p: FsPath): boolean {
  return p.device === 'NET' && p.segments.length >= 2 && p.segments[1] !== QUEUE_FOLDER;
}

/** The words that keep a board from being written to now, or null (spec 2026-10-31 §4.2). */
export const writeOf = (t: SendTarget, now: number) => writeBlock({ online: t.online, firmware: t.firmwareVersion, rx: t.rx,
  rxProto: t.rxProto, browseOn: t.browseOn, writeOn: t.writeOn, name: t.name, offlineWords: targetState(t, now) });

/** The board a path names, refused as not found unless it is this org's, and refused with the words unless it can write. */
export async function writableBoard(ctx: FsCtx, id: string, now = Date.now(), db: Db = getDb()): Promise<SendTarget> {
  const t = await findSendTarget(db, ctx.orgId, id, now);
  if (!t) refuse('not_found', 404);
  const block = writeOf(t, now);
  if (block) refuse('read_only', 409, block);
  return t;
}

/** An Amiga path one level down: `Work:` + `a` = `Work:a`, `Work:a` + `b` = `Work:a/b`. */
export const joinAmiga = (base: string, ...names: string[]) =>
  names.reduce((at, n) => (at.endsWith(':') ? `${at}${n}` : `${at}/${n}`), base);
/** The drawer an Amiga path is in: `Work:a/b` → `Work:a`, `Work:a` → `Work:`. */
export const amigaParent = (path: string) => {
  const c = path.indexOf(':');
  const slash = path.lastIndexOf('/');
  return slash > c ? path.slice(0, slash) : path.slice(0, c + 1);
};

type Place = { board: string; segs: string[]; amiga: string; shown: string; volume: string };
/** A NET: volume path's Amiga path (what Transfer is sent) and its words (`shown`); null for anything else. */
export function placeOf(p: FsPath | null): Place | null {
  if (!p || !isNetVolumeDir(p)) return null;
  const at = amigaPathOf(p.segments.slice(1));
  return at ? { board: p.segments[0], segs: p.segments.slice(1), amiga: at.amigaPath, shown: at.shown, volume: at.volume } : null;
}
const placeOfRaw = (raw: string) => placeOf(parsePath(raw));
const netPath = (board: string, ...segs: string[]) => formatPath({ device: 'NET', segments: [board, ...segs] });

/** The remembered entries of a drawer (within the 2 minutes), or null: nothing here asks the Amiga (plan W4). */
async function rememberedEntries(boardId: string, amiga: string): Promise<EntryInfo[] | null> {
  const s = await latestFor(getDb(), boardId, 'dir', amiga);
  return s.state === 'ready' ? ((s.row.answer ?? { entries: [] }) as { entries: EntryInfo[] }).entries : null;
}
/** The drawer's remembered entries, or the op refused: a clash check needs to know what is there (plan W4). */
async function mustRemember(boardId: string, amiga: string): Promise<EntryInfo[]> {
  const e = await rememberedEntries(boardId, amiga);
  if (!e) refuse('conflict', 409, RELIST);
  return e;
}
const has = (entries: EntryInfo[] | null, name: string) => !!entries?.some((e) => sameStashName(e.name, name));
const isInfo = (name: string) => name.toLowerCase().endsWith(INFO) && name.length > INFO.length;

/**
 * The icon request for an object (plan W9): `<name>.info` beside it is taken along when the remembered parent holds it,
 * or when nothing is remembered (then a missing one is no failure); never for a .info itself, nor one picked as well.
 */
function iconOf(entries: EntryInfo[] | null, name: string, picked: (n: string) => boolean): { name: string; known: boolean } | null {
  if (isInfo(name)) return null;
  const icon = `${name}${INFO}`;
  if (picked(icon)) return null;
  if (entries === null) return { name: icon, known: false };
  const hit = entries.find((e) => sameStashName(e.name, icon));
  return hit ? { name: hit.name, known: true } : null;
}

const done = (items: OpItem[], job: string, writes: number, files = 0): Outcome =>
  ({ kind: 'done', items, ...(writes + files > 0 ? { job: { id: job, files, writes } } : {}) });

// ---- Makedir, Rename, Delete, Protect, comment ----------------------------------------------------------------------

export async function makedirOnVolume(ctx: OpCtx, dir: FsPath, name: string): Promise<Outcome> {
  checkName(name);
  const at = placeOf(dir);
  if (!at) refuse('not_found', 404);
  const t = await writableBoard(ctx, at.board);
  if (has(await rememberedEntries(t.id, at.amiga), name)) refuse('name_exists', 409);
  const job = newRequestId();
  await addWrites(getDb(), { orgId: ctx.orgId, deviceId: t.id, jobId: job,
    writes: [{ kind: 'mkdir', amigaPath: joinAmiga(at.amiga, name), label: joinAmiga(at.shown, name),
      // Workbench shows a drawer without an icon only under Show All Files: from protocol 6 Transfer gives it the
      // Amiga's own default drawer icon (a copy's drawers bring their own .info, so only a Makedir asks).
      ...((t.rxProto ?? 0) >= DRAWER_ICON_PROTO ? { args: { drawerIcon: true } } : {}) }] });
  return done([{ source: netPath(at.board, ...at.segs, name), ok: true }], job, 1);
}

export async function renameOnVolume(ctx: OpCtx, source: string, name: string): Promise<Outcome> {
  checkName(name);
  const at = placeOfRaw(source);
  if (!at) refuse('not_found', 404);
  if (at.segs.length < 2) refuse('unsupported', 400, 'Rename a volume on the Amiga');
  const t = await writableBoard(ctx, at.board);
  const old = at.segs[at.segs.length - 1];
  const parent = amigaParent(at.amiga);
  const shownParent = amigaParent(at.shown);
  const entries = await rememberedEntries(t.id, parent);
  if (entries?.some((e) => sameStashName(e.name, name) && !sameStashName(e.name, old))) refuse('name_exists', 409);
  const writes: WriteReq[] = [{ kind: 'rename', amigaPath: at.amiga, args: { to: joinAmiga(parent, name) }, label: at.shown }];
  const icon = iconOf(entries, old, () => false);
  if (icon && !isInfo(name)) {
    writes.push({ kind: 'rename', amigaPath: joinAmiga(parent, icon.name), args: { to: joinAmiga(parent, `${name}${INFO}`) },
      icon: !icon.known, label: joinAmiga(shownParent, icon.name) });
  }
  const job = newRequestId();
  await addWrites(getDb(), { orgId: ctx.orgId, deviceId: t.id, jobId: job, writes });
  return done([{ source, ok: true }], job, writes.length);
}

/** Sources grouped by board, each board checked writable once; a source not on a volume is not found (that item). */
async function byBoard(ctx: FsCtx, sources: string[]): Promise<Map<SendTarget, { raw: string; at: Place }[]>> {
  const boards = new Map<string, SendTarget>();
  const out = new Map<SendTarget, { raw: string; at: Place }[]>();
  for (const raw of sources) {
    const at = placeOfRaw(raw);
    if (!at || at.segs.length < 2) refuse('not_found', 404);
    const t = boards.get(at.board) ?? await writableBoard(ctx, at.board);
    boards.set(at.board, t);
    out.set(t, [...(out.get(t) ?? []), { raw, at }]);
  }
  return out;
}

/**
 * Delete on a volume (spec 2026-10-31 §4.1, W3): one DELETE per source -- a drawer with everything in it, by Transfer --
 * and its icon (W9). The confirm is the pane's. Each item is ok once queued; the job says how it went.
 */
export async function removeOnVolume(ctx: OpCtx, sources: string[], opts: { jobId?: string } = {}): Promise<Outcome> {
  const items: OpItem[] = [];
  let writes = 0;
  // A move's removal joins the move's job (net-moves.ts), so its progress waits for it.
  const job = opts.jobId ?? newRequestId();
  for (const [t, list] of await byBoard(ctx, sources)) {
    const picked = new Set(list.map((x) => x.at.amiga.toLowerCase()));
    const reqs: WriteReq[] = [];
    for (const { raw, at } of list) {
      const name = at.segs[at.segs.length - 1];
      const parent = amigaParent(at.amiga);
      reqs.push({ kind: 'delete', amigaPath: at.amiga, label: at.shown });
      const icon = iconOf(await rememberedEntries(t.id, parent), name, (n) => picked.has(joinAmiga(parent, n).toLowerCase()));
      if (icon) reqs.push({ kind: 'delete', amigaPath: joinAmiga(parent, icon.name), icon: !icon.known, label: joinAmiga(amigaParent(at.shown), icon.name) });
      items.push({ source: raw, ok: true });
    }
    await addWrites(getDb(), { orgId: ctx.orgId, deviceId: t.id, jobId: job, writes: reqs });
    writes += reqs.length;
  }
  return done(items, job, writes);
}

/**
 * A move's second half off a volume (spec 2026-10-31 §9): exactly what was copied -- one DELETE … one per copied file,
 * then each copied drawer deepest first, each with `one`, so a drawer something new was saved into stays (Transfer
 * answers notempty: the job says it was kept). Never a drawer whole, never an icon that was not copied. Needs the
 * board writable and on Transfer 2.6; refuses (Refused) otherwise, and nothing is sent.
 */
export async function removeCopiedOnVolume(ctx: OpCtx, source: string, files: string[], drawers: string[], jobId: string): Promise<void> {
  const { t, shown } = await volumeMoveBoard(ctx, source);
  const depth = (p: string) => p.slice(p.indexOf(':') + 1).split('/').filter(Boolean).length;
  const once = (xs: string[]) => xs.filter((x, k) => xs.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === k);
  const reqs: WriteReq[] = [...once(files), ...once(drawers).sort((a, b) => depth(b) - depth(a))]
    .map((p) => ({ kind: 'delete', amigaPath: p, one: true, label: shown(p) }));
  await addWrites(getDb(), { orgId: ctx.orgId, deviceId: t.id, jobId, writes: reqs });
}

/**
 * The board a move off a volume removes its copied source on, refused (Refused) unless it can write now and runs
 * Transfer 2.6; and the pane's words for an Amiga path under the source (a labelled volume's device path by its label).
 */
export async function volumeMoveBoard(ctx: FsCtx, source: string, db: Db = getDb()): Promise<{ t: SendTarget; shown: (p: string) => string }> {
  const at = placeOfRaw(source);
  if (!at || at.segs.length < 2) refuse('not_found', 404);
  const t = await writableBoard(ctx, at.board, Date.now(), db);
  if ((t.rxProto ?? 0) < MOVE_PROTO) refuse('unsupported', 409, MOVE_OLD_TRANSFER);
  return { t, shown: (p: string) => (p.toLowerCase().startsWith(at.amiga.toLowerCase()) ? at.shown + p.slice(at.amiga.length) : p) };
}

/** Protect (PROTECT, the bits as AmigaDOS stores them) or a comment (NOTE) on volume entries. */
export async function setMetaOnVolume(ctx: OpCtx, sources: string[], meta: { protection?: number; comment?: string }): Promise<Outcome> {
  if (meta.comment !== undefined) checkComment(meta.comment);
  const items: OpItem[] = [];
  let writes = 0;
  const job = newRequestId();
  for (const [t, list] of await byBoard(ctx, sources)) {
    const reqs: WriteReq[] = list.map(({ at }) => (meta.comment !== undefined
      ? { kind: 'note', amigaPath: at.amiga, args: { comment: meta.comment }, label: at.shown }
      : { kind: 'protect', amigaPath: at.amiga, args: { protection: (meta.protection ?? 0) >>> 0 }, label: at.shown }));
    await addWrites(getDb(), { orgId: ctx.orgId, deviceId: t.id, jobId: job, writes: reqs });
    writes += reqs.length;
    for (const { raw } of list) items.push({ source: raw, ok: true });
  }
  return done(items, job, writes);
}

/** Refuses unless every volume source's board can write now: what a move asks before it copies (spec §4.1). */
export async function mustRemoveOnVolume(ctx: FsCtx, sources: string[]): Promise<void> {
  await byBoard(ctx, sources);
}

// ---- Copy onto a volume ---------------------------------------------------------------------------------------------

/** A Files clash answer as Transfer's mode: Keep both is `keep`, as is a copy with no clash seen ("ask" answered none). */
export const clashMode = (onClash: OnClash): ClashMode => (onClash === 'replace' ? 'replace' : onClash === 'skip' ? 'skip' : 'keep');

/**
 * A copy (or move) onto a volume (spec 2026-10-31 §4.1, W5): one queue row per file, in the order the copy walked them,
 * with the absolute path and the clash mode; Makedirs (`ensure`) for the drawers that hold no file, so empty drawers
 * arrive too. Clashes are decided against the destination's remembered listing (plan W4); keep both renames the top now
 * (a drawer arrives beside the one there). The limits are phase 1's (64 files, 16 MB, 4 MB a file) and the board's
 * queue's. A move's sources go once their rows are delivered (`moveSource`, plan W7): nothing is `written` now.
 */
export async function copyOntoVolume(ctx: OpCtx, dir: FsPath, tops: IncomingTop[], onClash: OnClash, opts: { move?: boolean } = {}): Promise<Outcome> {
  const at = placeOf(dir);
  if (!at) refuse('not_found', 404);
  const t = await writableBoard(ctx, at.board);
  if (!ctx.userId) refuse('unsupported', 400, 'signed-in person required');
  const entries = await mustRemember(t.id, at.amiga);
  const results = new Map<string, OpItem>();
  const clashes: Clash[] = [];
  const going: { top: IncomingTop; name: string; mode: ClashMode }[] = [];
  const taken = (n: string) => has(entries, n) || going.some((g) => sameStashName(g.name, n));
  for (const top of tops) {
    const name = top.items[0]?.rel[0];
    if (!name) { results.set(top.source, { source: top.source, ok: true }); continue; }
    if (going.some((g) => sameStashName(g.name, name))) refuse('name_exists', 409, 'two sources share a name');
    if (!has(entries, name)) { going.push({ top, name, mode: clashMode(onClash) }); continue; }
    if (onClash === 'ask') { clashes.push({ source: top.source, name, dest: formatPath(dir) }); continue; }
    if (onClash === 'skip') { results.set(top.source, skippedItem(top.source)); continue; }
    if (onClash === 'replace') { going.push({ top, name, mode: 'replace' }); continue; }
    going.push({ top, name: keepBothName(name, taken), mode: 'keep' });
  }
  if (clashes.length) return { kind: 'clashes', clashes };

  const sizeOf = (i: IncomingTop['items'][number]) => i.bytes?.length ?? i.size;
  // An empty file goes too (plan 2026-11-01-net-consistency R10; was left out, final review I-3): the board sends no chunk
  // for size 0 and Transfer finishes such a FILE at once.
  const files = going.flatMap((g) => g.top.items.filter((i) => i.kind === 'file').map((i) => ({ g, i, rel: [g.name, ...i.rel.slice(1)] })));
  for (const { i, rel } of files) {
    const size = sizeOf(i);
    if (size === undefined || (!i.bytes && !i.sha256)) refuse('failed', 500, `${rel.join('/')} came without its bytes`);
    if (size > SEND_FILE_MAX) refuse('too_large', 413, `${rel.join('/')} is over 4 MB`);
  }
  if (files.length > FETCH_MAX_FILES) refuse('too_large', 413, `at most ${FETCH_MAX_FILES} files at a time`);
  if (files.reduce((n, f) => n + (f.i.bytes?.length ?? f.i.size!), 0) > FETCH_MAX_BYTES) refuse('too_large', 413, `at most ${FETCH_MAX_BYTES / MB} MB at a time`);

  // Drawers holding no file arrive by a Makedir each, parents first; a drawer made meanwhile is as good (`ensure`).
  const holdsFile = (rel: string[]) => files.some((f) => f.rel.length > rel.length && rel.every((s, k) => sameStashName(s, f.rel[k])));
  // A move's Makedirs are parts of it (spec §9): each names the entry it copies (its rel as collected).
  const mkdirs: WriteReq[] = going.flatMap((g) => g.top.items.filter((i) => i.kind === 'dir').map((i) => [g.name, ...i.rel.slice(1)])
    .filter((rel) => !holdsFile(rel))
    .flatMap((rel) => rel.map((_, k) => rel.slice(0, k + 1)))
    .filter((rel, k, all) => all.findIndex((x) => x.join('/').toLowerCase() === rel.join('/').toLowerCase()) === k)
    .map((rel) => ({ kind: 'mkdir' as const, amigaPath: joinAmiga(at.amiga, ...rel), ensure: true, label: joinAmiga(at.shown, ...rel),
      ...(opts.move ? { move: { source: g.top.source, item: [g.top.items[0].rel[0], ...rel.slice(1)].join('/') } } : {}) })));

  const shas = await mapLimit(files, 12, ({ i }) => (i.sha256 ? Promise.resolve(i.sha256) : storeSendBytes(i.bytes!)));
  const queue: QueueFile[] = files.map(({ g, i, rel }, k) => ({ path: rel[rel.length - 1], sha256: shas[k], sizeBytes: i.bytes?.length ?? i.size!,
    protection: i.protection, comment: i.comment ?? '', ...(i.bytes ? { bytes: i.bytes } : {}),
    dest: joinAmiga(at.amiga, ...rel), onClash: g.mode, ...(opts.move ? { moveSource: g.top.source, moveItem: i.rel.join('/') } : {}) }));
  const job = newRequestId();
  // The queue first: a copy it refuses makes no drawers on the Amiga either (final review I-4).
  if (queue.length) {
    const r = await queueTransfers(getDb(), { orgId: ctx.orgId, deviceId: t.id, userId: ctx.userId, files: queue, jobId: job });
    if (!r.ok) {
      switch (r.reason) {
        case 'bad_name': return refuse('bad_name', 400, r.path);
        case 'too_large': return refuse('too_large', 413, `${r.path} is over 4 MB`);
        case 'empty': return refuse('unsupported', 400, `${r.path ?? 'A file'} is empty`);
        case 'queue_full': return refuse('queue_full', 409);
        case 'no_device': return refuse('not_found', 404);
        case 'no_blob': return refuse('failed', 409, `${r.path} is no longer stored`);
      }
    }
  }
  if (mkdirs.length) await addWrites(getDb(), { orgId: ctx.orgId, deviceId: t.id, jobId: job, writes: mkdirs });
  for (const g of going) results.set(g.top.source, { source: g.top.source, ok: true });
  return { kind: 'done', items: tops.map((x) => results.get(x.source)!), written: [],
    ...(queue.length + mkdirs.length ? { job: { id: job, files: queue.length, writes: mkdirs.length } } : {}) };
}

// ---- Move within one volume -------------------------------------------------------------------------------------

/** Two places on one board's one volume (case-insensitive, as AmigaDOS compares): a move between them is a RENAME. */
export function sameVolume(a: Place, b: Place): boolean {
  return a.board === b.board && a.amiga.slice(0, a.amiga.indexOf(':')).toLowerCase() === b.amiga.slice(0, b.amiga.indexOf(':')).toLowerCase();
}

/**
 * Move inside one volume (spec 2026-10-31 §4.1): a RENAME of each source into the drawer, its icon along. Clashes against
 * the destination's remembered listing (W4): Replace deletes what is there first (W10: the DELETE goes before the
 * RENAME), Keep both renames, Skip leaves it. A drawer never goes inside itself.
 */
export async function moveWithinVolume(ctx: OpCtx, sources: string[], dest: string, onClash: OnClash): Promise<Outcome> {
  const to = placeOfRaw(dest);
  if (!to) refuse('not_found', 404);
  const t = await writableBoard(ctx, to.board);
  const entries = await mustRemember(t.id, to.amiga);
  const froms = sources.map((raw) => ({ raw, at: placeOfRaw(raw) }));
  const picked = new Set(froms.map((f) => f.at?.amiga.toLowerCase()));
  const items: OpItem[] = [];
  const clashes: Clash[] = [];
  const writes: WriteReq[] = [];
  const going: string[] = [];
  for (const { raw, at } of froms) {
    if (!at || at.segs.length < 2 || !sameVolume(at, to)) refuse('unsupported', 400, 'Move within one volume');
    const name = at.segs[at.segs.length - 1];
    const lower = at.amiga.toLowerCase();
    if (to.amiga.toLowerCase() === lower || to.amiga.toLowerCase().startsWith(`${lower}/`)) refuse('cycle', 409);
    if (amigaParent(at.amiga).toLowerCase() === to.amiga.toLowerCase()) refuse('name_exists', 409, 'same file');
    let target = name;
    const parent = amigaParent(at.amiga);
    const icon = iconOf(await rememberedEntries(t.id, parent), name, (n) => picked.has(joinAmiga(parent, n).toLowerCase()));
    if (has(entries, name) || going.some((g) => sameStashName(g, name))) {
      if (onClash === 'ask') { clashes.push({ source: raw, name, dest }); continue; }
      if (onClash === 'skip') { items.push(skippedItem(raw)); continue; }
      if (onClash === 'replace') {
        writes.push({ kind: 'delete', amigaPath: joinAmiga(to.amiga, name), label: joinAmiga(to.shown, name) });
        // The replaced object's own icon goes too when the moved one brings its own (plan 2026-11-01-net-consistency,
        // item 6): else the icon's RENAME meets it and fails `exists`. Without a moved icon the target's stays.
        const old = entries.find((e) => sameStashName(e.name, `${name}${INFO}`));
        if (icon?.known && old && !isInfo(name)) {
          writes.push({ kind: 'delete', amigaPath: joinAmiga(to.amiga, old.name), icon: true, label: joinAmiga(to.shown, old.name) });
        }
      } else target = keepBothName(name, (n) => has(entries, n) || going.some((g) => sameStashName(g, n)));
    }
    going.push(target);
    writes.push({ kind: 'rename', amigaPath: at.amiga, args: { to: joinAmiga(to.amiga, target) }, label: at.shown });
    if (icon && !isInfo(target)) {
      writes.push({ kind: 'rename', amigaPath: joinAmiga(parent, icon.name), args: { to: joinAmiga(to.amiga, `${target}${INFO}`) },
        icon: !icon.known, label: joinAmiga(amigaParent(at.shown), icon.name) });
    }
    items.push({ source: raw, ok: true });
  }
  if (clashes.length) return { kind: 'clashes', clashes };
  const job = newRequestId();
  await addWrites(getDb(), { orgId: ctx.orgId, deviceId: t.id, jobId: job, writes });
  return done(items, job, writes.length);
}
