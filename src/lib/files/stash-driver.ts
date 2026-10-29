// src/lib/files/stash-driver.ts
// The STASH: driver (Files spec 2026-10-29 §4.2, increment 2): the org's loose files, by NAME, from amiga_uploads rows.
// It lists, reads, collects and writes; a .lha/.lzh/.zip opens as a read-only folder of its members. Org isolation is
// listStash's (and every store call's): another org's rows are never loaded, so its names are simply not found.
// StashBusy and a missing blob become Refused at this boundary. SERVER ONLY.
import { getDb } from '@/db';
import { diskStore } from '@/lib/storage';
import { deleteStash, insertStash, listStash, moveStash, setStashMeta, StashBusy, STASH_FULL, type NewStashEntry, type StashRow } from '@/lib/stash';
import { storeSendBytes } from '@/lib/send-http';
import { mapLimit } from '@/lib/pool';
import { isArchiveName, MAX_ARCHIVE_BYTES } from '@/lib/archive';
import { protectionString } from '@/lib/adffs/dir';
import { uploadFailureText } from '@/lib/from-amiga-ui';
import { UPLOAD_AREA_MAX_BYTES, UPLOAD_AREA_MAX_FILES } from '@/lib/amiga-upload-limits';
import { formatPath, parsePath, type FsPath } from './path';
import { keepBothName, rowsUnder, sameStashName, STASH_FILE_MAX, stashTree, type StashNode } from './stash-paths';
import { openArchive, type OpenedArchive } from './stash-archive';
import {
  checkComment, checkName, itemResult, refuse, Refused, REMOVE_FAILED,
  type CopyMove, type FileBytes, type FsCtx, type IncomingItem, type IncomingTop, type OnClash, type OpCtx, type OpItem, type Outcome, type VolumeDriver,
} from './driver';
import type { Crumb, FsEntry, Listing } from './types';

const ROOT: Crumb = { label: 'STASH:', path: 'STASH:' };
const stashPath = (names: readonly string[]) => formatPath({ device: 'STASH', segments: [...names] });
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
/** What a folder without a row of its own, or a member whose archive records none, shows: no bits set. */
const NO_BITS = protectionString(0);
export const STILL_ARRIVING = 'still arriving from the Amiga';
const iso = (d: Date | null) => d?.toISOString() ?? null;

export type LoadedStash = { rows: StashRow[]; tree: StashNode };

export async function loadStash(ctx: FsCtx): Promise<LoadedStash> {
  const rows = await listStash(getDb(), ctx.orgId);
  return { rows, tree: stashTree(rows) };
}

// ---- paths ----------------------------------------------------------------------------------------------------

/** Walks `segs` down folders; stops at a file with what is left in `rest`. `shown` are the names as the tree spells them. */
function descend(root: StashNode, segs: readonly string[]): { node: StashNode; shown: string[]; rest: string[] } | null {
  let node = root;
  const shown: string[] = [];
  for (let k = 0; k < segs.length; k++) {
    if (node.kind !== 'dir') return { node, shown, rest: segs.slice(k) };
    const hit = node.children.find((c) => sameStashName(c.name, segs[k]));
    if (!hit) return null;
    node = hit;
    shown.push(hit.name);
  }
  return { node, shown, rest: [] };
}

/** A stored file that opens as a folder: what kind 'archive' means. */
function isArchiveRow(node: StashNode, row: StashRow | undefined): row is StashRow & { blobSha256: string } {
  return node.kind === 'file' && !!row && row.status === 'stored' && !!row.blobSha256 && isArchiveName(node.name);
}

/** Inside an archive: the archive's own name and row, the names down to it, and the member path below it. */
type InArchive = { name: string; row: StashRow & { blobSha256: string }; shown: string[]; inner: string[] };
type Loc = { at: 'stash'; node: StashNode; row: StashRow | undefined; shown: string[] } | ({ at: 'archive' } & InArchive);

/** Null: not there, or a path that goes on through a file that is not an archive. */
function locate(s: LoadedStash, p: FsPath): Loc | null {
  const d = descend(s.tree, p.segments);
  if (!d) return null;
  const row = d.node.row === null ? undefined : s.rows[d.node.row];
  if (!d.rest.length) return { at: 'stash', node: d.node, row, shown: d.shown };
  if (!isArchiveRow(d.node, row)) return null;
  return { at: 'archive', name: d.node.name, row, shown: d.shown, inner: d.rest };
}

async function readBlob(sha256: string): Promise<Uint8Array> {
  return diskStore.read(sha256).catch((): never => refuse('blob_unavailable', 503));
}

// ---- archives -------------------------------------------------------------------------------------------------

type Members = { opened: OpenedArchive; tree: StashNode };

/** Over the cap by its row's size, refused before the blob is read; null from openArchive is "Can't open this archive". */
async function openRow(name: string, row: StashRow & { blobSha256: string }, accept?: (path: string) => boolean): Promise<Members> {
  if (row.sizeBytes > MAX_ARCHIVE_BYTES) refuse('archive_unreadable', 422);
  const opened = await openArchive(name, await readBlob(row.blobSha256), accept);
  if (!opened) refuse('archive_unreadable', 422);
  // Rows of the tree: the readable files first (index < files.length), then the members it could not decode.
  const tree = stashTree([...opened.files, ...opened.unreadable].map((m) => ({ path: m.path.join('/'), kind: 'file' as const })));
  return { opened, tree };
}

/** Members at or under `inner` (case-insensitive, as names compare everywhere in STASH:); `path` is memberPath's. */
const under = (inner: readonly string[]) => (path: string) => {
  const segs = path.split('/').filter(Boolean);
  return segs.length >= inner.length && inner.every((s, i) => sameStashName(s, segs[i]));
};

function memberOf(m: Members, node: StashNode) {
  const i = node.row!;
  const files = m.opened.files;
  return i < files.length ? { file: files[i], unreadable: null } : { file: null, unreadable: m.opened.unreadable[i - files.length].reason };
}

async function listArchive(loc: InArchive): Promise<Listing | null> {
  const m = await openRow(loc.name, loc.row);
  const d = descend(m.tree, loc.inner);
  if (!d || d.rest.length || d.node.kind !== 'dir') return null;
  const here = [...loc.shown, ...d.shown];
  const entries = d.node.children.map((c): FsEntry => {
    const path = stashPath([...here, c.name]);
    if (c.kind === 'dir') return { name: c.name, kind: 'dir', path, size: null, date: null, protection: NO_BITS, comment: null, marks: [] };
    const { file, unreadable } = memberOf(m, c);
    return {
      name: c.name, kind: 'file', path, size: file?.bytes.length ?? null, date: iso(file?.date ?? null),
      protection: file?.protection == null ? NO_BITS : protectionString(file.protection), comment: file?.comment ?? null,
      marks: unreadable ? [`can't open — ${unreadable}`] : [],
    };
  });
  const members = m.opened.files.length + m.opened.unreadable.length;
  return { path: stashPath(here), crumbs: crumbsOf(here), entries, writable: false, readOnlyReason: 'archive', disk: null,
    meta: `${count(members, 'file')} in the archive` };
}

// ---- list -----------------------------------------------------------------------------------------------------

function crumbsOf(shown: readonly string[]): Crumb[] {
  return [ROOT, ...shown.map((label, i) => ({ label, path: stashPath(shown.slice(0, i + 1)) }))];
}

function marksOf(row: StashRow): string[] {
  const marks: string[] = [];
  if (row.source === 'amiga' && row.deviceName) marks.push(`from ${row.deviceName}`);
  if (row.status === 'receiving') marks.push(`arriving ${row.sizeBytes ? Math.min(99, Math.floor((row.receivedBytes * 100) / row.sizeBytes)) : 0}%`);
  if (row.status === 'failed') marks.push(`failed — ${uploadFailureText(row.errorCode)}`);
  if (row.libraryDiskId) marks.push('in the library');
  return marks;
}

function entryOf(s: LoadedStash, c: StashNode, here: readonly string[]): FsEntry {
  const row = c.row === null ? undefined : s.rows[c.row];
  const path = stashPath([...here, c.name]);
  const meta = { date: iso(row?.date ?? null), protection: row ? protectionString(row.protection) : NO_BITS, comment: row?.comment || null };
  if (c.kind === 'dir') return { name: c.name, kind: 'dir', path, size: null, ...meta, marks: [] };
  return { name: c.name, kind: isArchiveRow(c, row) ? 'archive' : 'file', path, size: row!.sizeBytes, ...meta, marks: marksOf(row!) };
}

async function list(ctx: FsCtx, p: FsPath): Promise<Listing | null> {
  const s = await loadStash(ctx);
  const loc = locate(s, p);
  if (!loc) return null;
  if (loc.at === 'archive') return listArchive(loc);
  if (loc.node.kind === 'file') return isArchiveRow(loc.node, loc.row) ? listArchive({ name: loc.node.name, row: loc.row, shown: loc.shown, inner: [] }) : null;
  const children = loc.node.children;
  let meta: string;
  if (loc.shown.length) {
    const dirs = children.filter((c) => c.kind === 'dir').length;
    meta = `${count(dirs, 'folder')} · ${count(children.length - dirs, 'file')}`;
  } else {
    // What counts against the org's limit (insertStash): every row stored or arriving, folders with a row too.
    const live = s.rows.filter((r) => r.status !== 'failed');
    const bytes = live.reduce((a, r) => a + r.sizeBytes, 0);
    meta = `${count(live.length, 'file')} · ${mb(bytes)} of ${UPLOAD_AREA_MAX_BYTES / (1024 * 1024)} MB · kept 30 days`;
  }
  return { path: stashPath(loc.shown), crumbs: crumbsOf(loc.shown), entries: children.map((c) => entryOf(s, c, loc.shown)),
    writable: true, readOnlyReason: null, disk: null, meta };
}

// ---- read -----------------------------------------------------------------------------------------------------

async function read(ctx: FsCtx, p: FsPath): Promise<FileBytes | null> {
  const loc = locate(await loadStash(ctx), p);
  if (!loc) return null;
  if (loc.at === 'stash') {
    const row = loc.row;
    if (loc.node.kind === 'file' && row?.status === 'receiving') refuse('unsupported', 409, STILL_ARRIVING);
    if (loc.node.kind !== 'file' || !row || row.status !== 'stored' || !row.blobSha256) return null;
    return { name: loc.node.name, bytes: await readBlob(row.blobSha256), date: row.date, protection: protectionString(row.protection), comment: row.comment || null };
  }
  // One member: only it is inflated (ruling 5).
  const exact = (path: string) => under(loc.inner)(path) && path.split('/').filter(Boolean).length === loc.inner.length;
  const m = await openRow(loc.name, loc.row, exact);
  const d = descend(m.tree, loc.inner);
  if (!d || d.rest.length || d.node.kind !== 'file') return null;
  const { file, unreadable } = memberOf(m, d.node);
  if (!file) refuse('archive_unreadable', 422, unreadable!);
  return { name: d.node.name, bytes: file.bytes, date: file.date, protection: file.protection == null ? NO_BITS : protectionString(file.protection), comment: file.comment };
}

// ---- collect --------------------------------------------------------------------------------------------------

/**
 * One entry walked for a copy, a folder before what it holds. A stored file carries its sha256 and NOT its bytes
 * (ruling 13): the writer that needs them reads them, after checking sizes from the rows. A file still arriving
 * anywhere in it refuses the whole collect; a failed file holds no bytes and is left out.
 */
function collectStash(s: LoadedStash, node: StashNode, rel: string[], out: IncomingItem[]) {
  const row = node.row === null ? undefined : s.rows[node.row];
  if (node.kind === 'dir') {
    out.push({ rel, kind: 'dir', ...(row ? { id: row.id } : {}), date: row?.date ?? null, protection: row?.protection ?? 0, comment: row?.comment || null });
    for (const c of node.children) collectStash(s, c, [...rel, c.name], out);
    return;
  }
  if (!row || row.status === 'failed') return;
  if (row.status === 'receiving') refuse('unsupported', 409, STILL_ARRIVING);
  if (!row.blobSha256) return;
  out.push({ rel, kind: 'file', sha256: row.blobSha256, size: row.sizeBytes, id: row.id, date: row.date, protection: row.protection, comment: row.comment || null });
}

function collectMembers(m: Members, node: StashNode, rel: string[], out: IncomingItem[]) {
  if (node.kind === 'dir') {
    out.push({ rel, kind: 'dir', date: null, protection: 0, comment: null });
    for (const c of node.children) collectMembers(m, c, [...rel, c.name], out);
    return;
  }
  const { file, unreadable } = memberOf(m, node);
  // Never a short copy: a member it cannot decode refuses the whole collect.
  if (!file) refuse('archive_unreadable', 422, unreadable!);
  out.push({ rel, kind: 'file', bytes: file.bytes, date: file.date, protection: file.protection ?? 0, comment: file.comment });
}

async function collect(ctx: FsCtx, p: FsPath): Promise<IncomingItem[] | null> {
  const s = await loadStash(ctx);
  const loc = locate(s, p);
  if (!loc) return null;
  const out: IncomingItem[] = [];
  if (loc.at === 'stash') {
    if (!loc.shown.length) return null;   // STASH: itself is not an entry
    if (loc.node.kind === 'file' && loc.row?.status === 'failed') return null;
    collectStash(s, loc.node, [loc.node.name], out);
    return out;
  }
  const m = await openRow(loc.name, loc.row, under(loc.inner));
  const d = descend(m.tree, loc.inner);
  if (!d || d.rest.length) return null;
  collectMembers(m, d.node, [d.node.name], out);
  return out;
}

// ---- writes ---------------------------------------------------------------------------------------------------

const ARCHIVE = 'archive';
const same = sameStashName;
const segsOf = (path: string) => path.split('/').filter(Boolean);
/** `inner` is `outer` or below it, by the names the tree shows. */
const shownWithin = (inner: readonly string[], outer: readonly string[]) =>
  inner.length >= outer.length && outer.every((n, i) => same(inner[i], n));

function mustParse(raw: string): FsPath {
  const p = parsePath(raw);
  if (!p || p.device !== 'STASH') refuse('not_found', 404);
  return p;
}

/** A STASH: folder to write into: an archive (or a path inside one) is read-only, a file or nothing is not found. */
function folderAt(s: LoadedStash, p: FsPath): { node: StashNode; shown: string[] } {
  const loc = locate(s, p);
  if (loc?.at === 'archive' || (loc && isArchiveRow(loc.node, loc.row))) refuse('read_only', 409, ARCHIVE);
  if (!loc || loc.node.kind !== 'dir') refuse('not_found', 404);
  return { node: loc.node, shown: loc.shown };
}

/** An entry an op changes: in STASH: itself (not its root), never inside an archive. */
function entryAt(s: LoadedStash, raw: string): { node: StashNode; row: StashRow | undefined; shown: string[] } {
  const loc = locate(s, mustParse(raw));
  if (!loc) refuse('not_found', 404);
  if (loc.at === 'archive') refuse('read_only', 409, ARCHIVE);
  if (!loc.shown.length) refuse('unsupported', 400, 'not an entry in STASH:');
  return { node: loc.node, row: loc.row, shown: loc.shown };
}

/**
 * A name a copy brings into STASH: is kept as it is, longer than a disk allows if it came that way (from an archive):
 * only what no path can carry is refused. A name the person types (makedir, rename) passes checkName.
 */
function checkCopiedName(name: string) {
  const p = parsePath(`STASH:/${name}`);
  if (!p || p.segments.length !== 1) refuse('bad_name', 400, 'bad-char');
}

/**
 * The row ids a replace deletes: refused when the clashing entry is (or holds) the source, as LIBRARY: refuses it, and
 * when a file under it is still arriving from the Amiga (an upload in flight is never deleted by a replace).
 */
function replaceable(s: LoadedStash, folder: readonly string[], clash: StashNode, source: string): string[] {
  const p = parsePath(source);
  if (p?.device === 'STASH' && shownWithin(p.segments, [...folder, clash.name])) {
    if (p.segments.length === folder.length + 1) refuse('name_exists', 409, 'same file');
    refuse('cycle', 400);
  }
  const rows = rowsUnder(clash).map((i) => s.rows[i]);
  if (rows.some((r) => r.status === 'receiving')) refuse('unsupported', 409, STILL_ARRIVING);
  return rows.map((r) => r.id);
}

/** A move's sources, before anything is written: entries of STASH: itself (not archive members), nothing arriving. */
async function mustRemove(ctx: FsCtx, sources: string[]): Promise<void> {
  const s = await loadStash(ctx);
  for (const raw of sources) {
    const e = entryAt(s, raw);
    if (rowsUnder(e.node).some((i) => s.rows[i].status === 'receiving')) refuse('unsupported', 409, STILL_ARRIVING);
  }
}

const live = (rows: StashRow[]) => rows.filter((r) => r.status !== 'failed');

/** The limit insertStash holds under its lock, checked first from the rows loaded, so a refused copy stores no bytes. */
function mustHaveRoom(s: LoadedStash, entries: { sizeBytes: number }[], replaceIds: string[]) {
  const kept = live(s.rows).filter((r) => !replaceIds.includes(r.id));
  const bytes = kept.reduce((a, r) => a + r.sizeBytes, 0) + entries.reduce((a, e) => a + e.sizeBytes, 0);
  if (kept.length + entries.length > UPLOAD_AREA_MAX_FILES || bytes > UPLOAD_AREA_MAX_BYTES) refuse('stash_full', 409, STASH_FULL);
}

async function insertAll(ctx: FsCtx, source: 'browser' | 'copy', entries: NewStashEntry[], replaceIds: string[] = []) {
  const r = await insertStash(getDb(), ctx.orgId, source, entries, { replaceIds });
  if (!r.ok) refuse('stash_full', 409, STASH_FULL);
  return r.ids;
}

type Pending = NewStashEntry & { bytes?: Uint8Array };

/**
 * Entries from another device (or from STASH: itself) written into one STASH: folder: every row in ONE insertStash, all
 * or nothing, the org's limits checked before any byte is stored. Every folder copied gets a row, so its date, bits and
 * comment come along (and it counts, as empty folders do). A clash is per top-level name: `ask` writes nothing,
 * `keep-both` stores <name>_1, `replace` deletes what held the name in the same transaction.
 */
/** `placed`: where each written top now is in STASH: (its keep-both name, when it took one). */
export type StashWriteOutcome = Outcome & { placed?: { source: string; path: string }[] };

export async function writeStash(ctx: OpCtx, dir: FsPath, tops: IncomingTop[], onClash: OnClash, source: 'browser' | 'copy'): Promise<StashWriteOutcome> {
  const s = await loadStash(ctx);
  const folder = folderAt(s, dir);
  const results = new Map<string, OpItem>();
  const placed: string[] = [];
  const planned: { top: IncomingTop; name: string; clash: StashNode | null }[] = [];
  for (const top of tops) {
    const name = top.items[0]?.rel[0] ?? '';
    const item = itemResult(top.source, () => {
      if (!top.items.length) refuse('not_found', 404);
      for (const i of top.items) {
        i.rel.forEach(checkCopiedName);
        if (i.kind !== 'file') continue;
        const size = i.bytes?.length ?? i.size;
        if (size === undefined || (!i.bytes && !i.sha256)) refuse('failed', 500, `${i.rel.join('/')} came without its bytes`);
        if (size > STASH_FILE_MAX) refuse('too_large', 413, '20 MB per file');
      }
      if (placed.some((n) => same(n, name))) refuse('name_exists', 409, 'two sources share a name');
    });
    if (!item.ok) { results.set(top.source, item); continue; }
    placed.push(name);
    planned.push({ top, name, clash: folder.node.children.find((c) => same(c.name, name)) ?? null });
  }
  if (onClash === 'ask') {
    const clashes = planned.filter((p) => p.clash).map((p) => ({ source: p.top.source, name: p.name, dest: stashPath(folder.shown) }));
    if (clashes.length) return { kind: 'clashes', clashes };
  }

  const taken = (n: string) => folder.node.children.some((c) => same(c.name, n)) || placed.some((p) => same(p, n));
  const entries: Pending[] = [];
  const replaceIds: string[] = [];
  const written: string[] = [];
  const placedAt: { source: string; path: string }[] = [];
  for (const p of planned) {
    results.set(p.top.source, itemResult(p.top.source, () => {
      if (p.clash && onClash === 'skip') return;
      let name = p.name;
      if (p.clash && onClash === 'keep-both') { name = keepBothName(name, taken); placed.push(name); }
      if (p.clash && onClash === 'replace') replaceIds.push(...replaceable(s, folder.shown, p.clash, p.top.source));
      for (const i of p.top.items) {
        entries.push({ path: [...folder.shown, name, ...i.rel.slice(1)].join('/'), kind: i.kind, sha256: i.sha256 ?? null, bytes: i.bytes,
          sizeBytes: i.kind === 'file' ? (i.bytes?.length ?? i.size!) : 0, date: i.date, protection: i.protection, comment: i.comment ?? '' });
      }
      written.push(p.top.source);
      placedAt.push({ source: p.top.source, path: stashPath([...folder.shown, name]) });
    }));
  }
  if (entries.length) {
    mustHaveRoom(s, entries, replaceIds);
    // Up to 12 stores at a time (a 60 s function), every one before the single insert: all or nothing as before.
    const toStore = entries.filter((e) => e.kind === 'file' && !e.sha256);
    const stored = await mapLimit(toStore, 12, (e) => storeSendBytes(e.bytes!));
    toStore.forEach((e, k) => { e.sha256 = stored[k]; });
    await insertAll(ctx, source, entries.map((e): NewStashEntry => ({ path: e.path, kind: e.kind, sha256: e.sha256, sizeBytes: e.sizeBytes,
      date: e.date, protection: e.protection, comment: e.comment })), replaceIds);
  }
  return { kind: 'done', items: tops.map((t) => results.get(t.source)!), written, placed: placedAt };
}

/** A move inside STASH: rewrites paths; no bytes move and nothing new counts against the limit. */
async function moveWithin(ctx: OpCtx, req: CopyMove): Promise<Outcome> {
  const s = await loadStash(ctx);
  const folder = folderAt(s, mustParse(req.dest));
  type Src = { raw: string; node: StashNode; shown: string[] };
  const srcs: Src[] = [];
  for (const raw of req.sources) {
    const e = entryAt(s, raw);
    if (e.node.kind === 'dir' && shownWithin(folder.shown, e.shown)) refuse('cycle', 400);
    // Ruling 6: before anything changes (moveStash would refuse it too, but after a replace had deleted).
    if (rowsUnder(e.node).some((i) => s.rows[i].status === 'receiving')) refuse('unsupported', 409, STILL_ARRIVING);
    srcs.push({ raw, node: e.node, shown: e.shown });
  }

  const results = new Map<string, OpItem>();
  const placed: string[] = [];
  const planned: (Src & { clash: StashNode | null; noop: boolean })[] = [];
  for (const src of srcs) {
    const name = src.node.name;
    const parent = src.shown.slice(0, -1);
    const noop = parent.length === folder.shown.length && shownWithin(parent, folder.shown);   // moved to where it is
    const item = itemResult(src.raw, () => {
      if (!noop && placed.some((n) => same(n, name))) refuse('name_exists', 409, 'two sources share a name');
    });
    if (!item.ok) { results.set(src.raw, item); continue; }
    placed.push(name);
    planned.push({ ...src, noop, clash: noop ? null : folder.node.children.find((c) => same(c.name, name)) ?? null });
  }
  if (req.onClash === 'ask') {
    const clashes = planned.filter((p) => p.clash).map((p) => ({ source: p.raw, name: p.node.name, dest: stashPath(folder.shown) }));
    if (clashes.length) return { kind: 'clashes', clashes };
  }

  const taken = (n: string) => folder.node.children.some((c) => same(c.name, n)) || placed.some((p) => same(p, n));
  const moves: { id: string; path: string }[] = [];
  const replaceIds: string[] = [];
  const written: string[] = [];
  for (const p of planned) {
    results.set(p.raw, itemResult(p.raw, () => {
      if (p.noop || (p.clash && req.onClash === 'skip')) return;
      let name = p.node.name;
      if (p.clash && req.onClash === 'keep-both') { name = keepBothName(name, taken); placed.push(name); }
      if (p.clash && req.onClash === 'replace') {
        replaceIds.push(...replaceable(s, folder.shown, p.clash, p.raw));
      }
      const depth = p.shown.length - 1;
      for (const i of rowsUnder(p.node)) {
        const row = s.rows[i];
        moves.push({ id: row.id, path: [...folder.shown, name, ...segsOf(row.path).slice(depth + 1)].join('/') });
      }
      written.push(p.raw);
    }));
  }
  // The move first: if the delete then fails, both are still there (shown keep-both), nothing is lost.
  await moveStash(getDb(), ctx.orgId, moves);
  await deleteStash(getDb(), ctx.orgId, replaceIds);
  return { kind: 'done', items: req.sources.map((r) => results.get(r)!), written };
}

async function within(ctx: OpCtx, req: CopyMove): Promise<Outcome> {
  if (req.op === 'move') return moveWithin(ctx, req);
  const s = await loadStash(ctx);
  const dest = mustParse(req.dest);
  const folder = folderAt(s, dest);
  const tops: IncomingTop[] = [];
  for (const raw of req.sources) {
    const p = mustParse(raw);
    const loc = locate(s, p);
    if (loc?.at === 'stash' && loc.node.kind === 'dir' && shownWithin(folder.shown, loc.shown)) refuse('cycle', 400);
    // Stored files come as their sha-256: a copy inside STASH: stores no new bytes.
    const items = await collect(ctx, p);
    if (!items) refuse('not_found', 404);
    tops.push({ source: raw, items });
  }
  return writeStash(ctx, dest, tops, req.onClash, 'copy');
}

/**
 * Delete. With `unchanged` (a move's second half), a source goes only while its rows are exactly the ones collected,
 * with the bits and comment they had; otherwise it stays and its item says so (REMOVE_FAILED). A failed stub under it
 * holds no bytes and goes with it.
 */
async function remove(ctx: OpCtx, sources: string[], unchanged?: ReadonlyMap<string, IncomingItem[]>): Promise<Outcome> {
  const s = await loadStash(ctx);
  const ids: string[] = [];
  const results = new Map<string, OpItem>();
  for (const raw of sources) {
    if (!unchanged) {
      ids.push(...rowsUnder(entryAt(s, raw).node).map((i) => s.rows[i].id));
      continue;
    }
    try {
      const e = entryAt(s, raw);
      const collected = new Map((unchanged.get(raw) ?? []).filter((i) => i.id !== undefined).map((i) => [i.id!, i] as const));
      const rows = rowsUnder(e.node).map((i) => s.rows[i]);
      const now = live(rows);
      const asCollected = now.length === collected.size && now.every((r) => {
        const c = collected.get(r.id);
        return !!c && c.kind === r.kind && c.protection === r.protection && (c.comment ?? '') === r.comment
          && (r.kind === 'dir' || c.sha256 === r.blobSha256);
      });
      if (!asCollected) refuse('conflict', 409, REMOVE_FAILED);
      ids.push(...rows.map((r) => r.id));
    } catch (err) {
      if (!(err instanceof Refused)) throw err;
      results.set(raw, { source: raw, ok: false, refusal: { code: err.refusal.code, detail: REMOVE_FAILED } });
    }
  }
  await deleteStash(getDb(), ctx.orgId, ids);
  return { kind: 'done', items: sources.map((r) => results.get(r) ?? { source: r, ok: true }) };
}

async function makedir(ctx: OpCtx, dir: FsPath, name: string): Promise<Outcome> {
  checkName(name);
  const s = await loadStash(ctx);
  const folder = folderAt(s, dir);
  if (folder.node.children.some((c) => same(c.name, name))) refuse('name_exists', 409);
  await insertAll(ctx, 'copy', [{ path: [...folder.shown, name].join('/'), kind: 'dir', sha256: null, sizeBytes: 0, date: null, protection: 0, comment: '' }]);
  return { kind: 'done', items: [{ source: stashPath([...folder.shown, name]), ok: true }] };
}

/** Every row under the entry takes the new name at its depth; an implicit folder is its children's paths only. */
async function rename(ctx: OpCtx, source: string, name: string): Promise<Outcome> {
  checkName(name);
  const s = await loadStash(ctx);
  const e = entryAt(s, source);
  const parent = e.shown.slice(0, -1);
  const siblings = descend(s.tree, parent)!.node.children;
  if (siblings.some((c) => c !== e.node && same(c.name, name))) refuse('name_exists', 409);
  const depth = e.shown.length - 1;
  await moveStash(getDb(), ctx.orgId, rowsUnder(e.node).map((i) => ({
    id: s.rows[i].id, path: [...parent, name, ...segsOf(s.rows[i].path).slice(depth + 1)].join('/'),
  })));
  return { kind: 'done', items: [{ source, ok: true }] };
}

/** Protection and/or comment; a folder without a row of its own gets one to carry them (R2). */
async function setMeta(ctx: OpCtx, sources: string[], meta: { protection?: number; comment?: string }): Promise<Outcome> {
  if (meta.protection !== undefined && (!Number.isInteger(meta.protection) || meta.protection < 0 || meta.protection > 0xff)) {
    refuse('unsupported', 400, 'protection is 8 bits');
  }
  if (meta.comment !== undefined) checkComment(meta.comment);
  if (meta.protection === undefined && meta.comment === undefined) refuse('unsupported', 400, 'nothing to change');
  const s = await loadStash(ctx);
  const ids: string[] = [];
  const dirs: NewStashEntry[] = [];
  for (const raw of sources) {
    const e = entryAt(s, raw);
    if (e.row) ids.push(e.row.id);
    else dirs.push({ path: e.shown.join('/'), kind: 'dir', sha256: null, sizeBytes: 0, date: null, protection: meta.protection ?? 0, comment: meta.comment ?? '' });
  }
  if (dirs.length) await insertAll(ctx, 'copy', dirs);
  await setStashMeta(getDb(), ctx.orgId, ids, meta);
  return { kind: 'done', items: sources.map((source) => ({ source, ok: true })) };
}

/** What Add to library needs of a path: a row of STASH: itself, or a member of an archive (which it does not take). */
export async function stashEntryOf(ctx: FsCtx, p: FsPath): Promise<{ in: 'stash'; row: StashRow | null } | { in: 'archive' } | null> {
  return guarded(async () => {
    const loc = locate(await loadStash(ctx), p);
    if (!loc || (loc.at === 'stash' && !loc.shown.length)) return null;
    return loc.at === 'archive' ? { in: 'archive' } : { in: 'stash', row: loc.row ?? null };
  });
}

// ---- the driver -----------------------------------------------------------------------------------------------

/** StashBusy (a subtree with a file the board is still sending) is the driver's refusal, whichever method met it. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (e instanceof StashBusy) refuse('unsupported', 409, STILL_ARRIVING);
    throw e;
  }
}

export const stashDriver: VolumeDriver = {
  device: 'STASH',
  list: (ctx, p) => guarded(() => list(ctx, p)),
  read: (ctx, p) => guarded(() => read(ctx, p)),
  collect: (ctx, p) => guarded(() => collect(ctx, p)),
  within: (ctx, req) => guarded(() => within(ctx, req)),
  write: (ctx, dir, tops, onClash) => guarded(() => writeStash(ctx, dir, tops, onClash, 'copy')),
  remove: (ctx, sources, unchanged) => guarded(() => remove(ctx, sources, unchanged)),
  mustRemove: (ctx, sources) => guarded(() => mustRemove(ctx, sources)),
  makedir: (ctx, dir, name) => guarded(() => makedir(ctx, dir, name)),
  rename: (ctx, source, name) => guarded(() => rename(ctx, source, name)),
  setMeta: (ctx, sources, meta) => guarded(() => setMeta(ctx, sources, meta)),
};
