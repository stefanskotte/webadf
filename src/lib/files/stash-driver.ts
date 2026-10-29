// src/lib/files/stash-driver.ts
// The STASH: driver (Files spec 2026-10-29 §4.2, increment 2): the org's loose files, by NAME, from amiga_uploads rows.
// This task lists, reads and collects; a .lha/.lzh/.zip opens as a read-only folder of its members. Task 5 adds the
// writes. Org isolation is listStash's: another org's rows are never loaded, so its names are simply not found.
// StashBusy and a missing blob become Refused at this boundary. SERVER ONLY.
import { getDb } from '@/db';
import { diskStore } from '@/lib/storage';
import { listStash, StashBusy, type StashRow } from '@/lib/stash';
import { isArchiveName, MAX_ARCHIVE_BYTES } from '@/lib/archive';
import { protectionString } from '@/lib/adffs/dir';
import { uploadFailureText } from '@/lib/from-amiga-ui';
import { UPLOAD_AREA_MAX_BYTES } from '@/lib/amiga-upload-limits';
import { formatPath, type FsPath } from './path';
import { sameStashName, stashTree, type StashNode } from './stash-paths';
import { openArchive, type OpenedArchive } from './stash-archive';
import { refuse, type FileBytes, type FsCtx, type IncomingItem, type VolumeDriver } from './driver';
import type { Crumb, FsEntry, Listing } from './types';

const ROOT: Crumb = { label: 'STASH:', path: 'STASH:' };
const stashPath = (names: readonly string[]) => formatPath({ device: 'STASH', segments: [...names] });
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
/** What a folder without a row of its own, or a member whose archive records none, shows: no bits set. */
const NO_BITS = protectionString(0);
const STILL_ARRIVING = 'still arriving from the Amiga';
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
    out.push({ rel, kind: 'dir', date: row?.date ?? null, protection: row?.protection ?? 0, comment: row?.comment || null });
    for (const c of node.children) collectStash(s, c, [...rel, c.name], out);
    return;
  }
  if (!row || row.status === 'failed') return;
  if (row.status === 'receiving') refuse('unsupported', 409, STILL_ARRIVING);
  if (!row.blobSha256) return;
  out.push({ rel, kind: 'file', sha256: row.blobSha256, date: row.date, protection: row.protection, comment: row.comment || null });
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
};
