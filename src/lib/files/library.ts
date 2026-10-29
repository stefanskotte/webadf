// src/lib/files/library.ts
// LIBRARY: (spec 2026-10-29 §4.1): titles → disks → a disk's AmigaDOS folders. SERVER ONLY.
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { blobs, disks, entitlements, games } from '@/db/schema/catalog';
import { diskStore } from '@/lib/storage';
import { readVolume, readUsage, readFile, geometryOf, HD_GEOMETRY, type AdfEntry } from '@/lib/adffs';
import { sameName } from '@/lib/adffs/write';
import { findHolder, mountedReason } from '@/lib/disk-holder';
import { isLocal } from '@/lib/remote-hidden';
import { readTop, tallyTop, zipReadTops, type ReadTop } from '@/lib/disk-zip';
import { formatPath, isWithin, type FsPath } from './path';
import { ZIP_MAX_BYTES } from './transfer';
import type { FsCtx } from './driver';
import type { Crumb, DiskInfo, FsEntry, Listing } from './types';

export type { FsCtx };
export type ResolvedDisk = { info: DiskInfo; bytes: Uint8Array; root: AdfEntry[]; rootBlock: number; intl: boolean };

const ROOT: Crumb = { label: 'LIBRARY:', path: 'LIBRARY:' };
const lib = (...segs: string[]) => formatPath({ device: 'LIBRARY', segments: segs });
const diskName = (d: { label: string | null; diskNo: number }) => d.label ?? `Disk ${d.diskNo}`;
/** "1 folder", "2 folders": the listing's meta line counts in words. */
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The disk's row exists but its image cannot be read from the store: the one failure the routes call blob_unavailable. */
export class BlobUnavailableError extends Error {
  constructor(readonly sha256: string, cause: unknown) { super(`disk image ${sha256} is unavailable`, { cause }); }
}

export async function loadDisk(ctx: FsCtx, gameId: string, diskId: string): Promise<ResolvedDisk | null> {
  const db = getDb();
  const [row] = await db
    .select({ id: disks.id, gameId: disks.gameId, diskNo: disks.diskNo, label: disks.label, sha256: disks.sha256,
      imageFormat: disks.imageFormat, title: games.title, tosecName: disks.tosecName, matchState: blobs.matchState })
    .from(disks)
    .innerJoin(entitlements, and(eq(entitlements.orgId, disks.orgId), eq(entitlements.sha256, disks.sha256)))
    .innerJoin(games, and(eq(games.id, disks.gameId), eq(games.orgId, ctx.orgId), isLocal(games)))
    // Global, and LEFT: a blob the sweeper has not reached has no match yet, the same as 'none'.
    .leftJoin(blobs, eq(blobs.sha256, disks.sha256))
    .where(and(eq(disks.id, diskId), eq(disks.gameId, gameId), eq(disks.orgId, ctx.orgId), isLocal(disks)))
    .limit(1);
  if (!row) return null;
  const bytes = await diskStore.read(row.sha256).catch((e) => { throw new BlobUnavailableError(row.sha256, e); });
  const vol = readVolume(bytes);
  const usage = vol.ok ? readUsage(bytes) : null;
  const holder = await findHolder(db, ctx.orgId, row.sha256);
  const info: DiskInfo = {
    diskId: row.id, gameId: row.gameId, title: row.title, label: diskName(row),
    filesystem: vol.ok ? vol.volume.filesystem : null, hd: geometryOf(bytes)?.blockCount === HD_GEOMETRY.blockCount,
    usedBytes: usage?.usedBytes ?? null, freeBytes: usage?.freeBytes ?? null, totalBytes: usage?.totalBytes ?? null,
    holder: holder?.name ?? null, imageFormat: row.imageFormat, volumeName: vol.ok ? vol.volume.name : null, sha256: row.sha256,
    intl: vol.ok ? vol.volume.intl : false,
    // disks.tosecName also holds the uploaded filename until a real match overwrites it, stamping 'matched' in the
    // same write (the Browse page's D-W-3 rule): only then is there an identity to lose.
    tosecName: row.matchState === 'matched' ? row.tosecName : null,
  };
  return { info, bytes, root: vol.ok ? vol.root : [], rootBlock: vol.ok ? vol.rootBlock : 0, intl: vol.ok ? vol.volume.intl : false };
}

/** Walk `names` down from the root. Takes only the tree, so ops.ts can resolve against an edit's own bytes too. */
export function resolveInDisk(d: Pick<ResolvedDisk, 'root' | 'rootBlock' | 'intl'>, names: string[]) {
  let children = d.root; let dirBlock = d.rootBlock; let parentBlock = d.rootBlock; let entry: AdfEntry | null = null;
  for (const [i, n] of names.entries()) {
    const hit = children.find((c) => sameName(c.name, n, d.intl));
    if (!hit) return null;
    entry = hit; parentBlock = dirBlock;
    if (hit.kind === 'dir') { children = hit.children; dirBlock = hit.block; }
    else if (i !== names.length - 1) return null;
  }
  return { entry, parentBlock, dirBlock };
}

/** Why a disk's folders cannot be written, or null: a board holds it, it is an HFE original, or it has no filesystem. */
export function readOnlyReasonOf(info: DiskInfo): string | null {
  return info.holder ? mountedReason(info.holder)
    : info.imageFormat === 'hfe' ? 'hfe_read_only' : !info.filesystem ? 'no_filesystem' : null;
}

/** Files and folders under a folder, at any depth. The listing already holds the whole tree, so this reads nothing. */
export function countInside(children: AdfEntry[]): { files: number; folders: number } {
  let files = 0; let folders = 0;
  for (const c of children) {
    if (c.kind !== 'dir') { files++; continue; }
    const sub = countInside(c.children);
    folders += 1 + sub.folders; files += sub.files;
  }
  return { files, folders };
}

function toEntry(base: string[], e: AdfEntry): FsEntry {
  return { name: e.name, kind: e.kind, path: lib(...base, e.name), size: e.kind === 'file' ? e.sizeBytes : null,
    date: e.modifiedAt?.toISOString() ?? null, protection: e.protection, comment: e.comment, marks: [],
    ...(e.kind === 'dir' ? { inside: countInside(e.children) } : {}) };
}

export async function listLibrary(ctx: FsCtx, p: FsPath): Promise<Listing | null> {
  const db = getDb();
  const [gameId, diskId, ...names] = p.segments;
  if (!gameId) {
    const rows = await db.select({ id: games.id, title: games.title }).from(games)
      .where(and(eq(games.orgId, ctx.orgId), isLocal(games))).orderBy(asc(games.sortTitle), asc(games.id));
    return { path: 'LIBRARY:', crumbs: [ROOT], writable: false, readOnlyReason: null, disk: null,
      meta: count(rows.length, 'title'),
      entries: rows.map((g) => ({ name: g.title, kind: 'title', path: lib(g.id), size: null, date: null, protection: null, comment: null, marks: [] })) };
  }
  const [game] = await db.select({ title: games.title }).from(games)
    .where(and(eq(games.id, gameId), eq(games.orgId, ctx.orgId), isLocal(games))).limit(1);
  if (!game) return null;
  const titleCrumb = { label: game.title, path: lib(gameId) };
  if (!diskId) {
    const rows = await db.select({ id: disks.id, diskNo: disks.diskNo, label: disks.label, sizeBytes: disks.sizeBytes, sha256: disks.sha256 })
      .from(disks)
      .innerJoin(entitlements, and(eq(entitlements.orgId, disks.orgId), eq(entitlements.sha256, disks.sha256)))
      .where(and(eq(disks.gameId, gameId), eq(disks.orgId, ctx.orgId), isLocal(disks))).orderBy(asc(disks.diskNo));
    const entries: FsEntry[] = [];
    for (const d of rows) {
      const holder = await findHolder(db, ctx.orgId, d.sha256);
      entries.push({ name: diskName(d), kind: 'disk', path: lib(gameId, d.id), size: d.sizeBytes, date: null, protection: null,
        comment: null, marks: holder ? [`in a drive of ${holder.name}`] : [] });
    }
    return { path: lib(gameId), crumbs: [ROOT, titleCrumb], entries, writable: false, readOnlyReason: null, disk: null,
      meta: count(rows.length, 'disk') };
  }
  const d = await loadDisk(ctx, gameId, diskId);
  if (!d) return null;
  const at = resolveInDisk(d, names);
  if (!at || (at.entry && at.entry.kind !== 'dir')) return null;
  const children = at.entry ? at.entry.children : d.root;
  const base = [gameId, diskId, ...(names.length ? names : [])];
  const readOnlyReason = readOnlyReasonOf(d.info);
  const dirs = children.filter((c) => c.kind === 'dir').length;
  const crumbs: Crumb[] = [ROOT, titleCrumb, { label: d.info.label, path: lib(gameId, diskId) }];
  names.forEach((_, i) => crumbs.push({ label: resolveInDisk(d, names.slice(0, i + 1))!.entry!.name, path: lib(gameId, diskId, ...names.slice(0, i + 1)) }));
  return { path: formatPath(p), crumbs, entries: children.map((c) => toEntry(base, c)), writable: readOnlyReason === null,
    readOnlyReason, disk: d.info, meta: `${count(dirs, 'folder')} · ${count(children.length - dirs, 'file')}` };
}

export async function readLibraryFile(ctx: FsCtx, p: FsPath) {
  const [gameId, diskId, ...names] = p.segments;
  if (!gameId || !diskId || !names.length) return null;
  const d = await loadDisk(ctx, gameId, diskId);
  const at = d && resolveInDisk(d, names);
  if (!d || !at?.entry || at.entry.kind !== 'file') return null;
  const f = readFile(d.bytes, at.entry.block);
  if (!f) return null;
  return { name: at.entry.name, bytes: f.bytes, date: at.entry.modifiedAt, protection: at.entry.protection, comment: at.entry.comment };
}

/** The multi-file download's caps (spec 2026-10-29 §3.3): beyond either the answer is 413 too_large. */
export const ZIP_LIMITS = { maxEntries: 1000, maxBytes: ZIP_MAX_BYTES };

/**
 * Several LIBRARY: files and folders, from any disks, as one .zip: each at the top under its own name, a folder with
 * everything under it. An entry inside another selected folder of the same disk is already in the zip and is not
 * added twice. Null when any path is not a file or folder inside a disk this org has. Throws BlobUnavailableError.
 *
 * The disks are loaded one at a time and each is read out (its files only, at most the cap) before the next: a
 * selection over a cap stops at the disk that crosses it, and no more than one image is held at once.
 */
export async function zipLibraryPaths(ctx: FsCtx, paths: FsPath[]) {
  const byDisk = new Map<string, { gameId: string; diskId: string; at: { i: number; p: FsPath; names: string[] }[] }>();
  for (const [i, p] of paths.entries()) {
    const [gameId, diskId, ...names] = p.segments;
    if (p.device !== 'LIBRARY' || !gameId || !diskId || !names.length) return null;
    const key = `${gameId}/${diskId}`;
    const g = byDisk.get(key) ?? { gameId, diskId, at: [] };
    g.at.push({ i, p, names });
    byDisk.set(key, g);
  }
  let entries = 0; let bytes = 0;
  const read: { i: number; top: ReadTop }[] = [];
  for (const g of byDisk.values()) {
    const d = await loadDisk(ctx, g.gameId, g.diskId);
    if (!d) return null;
    const picked: { i: number; p: FsPath; entry: AdfEntry }[] = [];
    for (const a of g.at) {
      const entry = resolveInDisk(d, a.names)?.entry;
      if (!entry) return null;
      picked.push({ i: a.i, p: a.p, entry });
    }
    const tops = picked.filter((a, k) => !picked.some((b, j) => j !== k
      && (b.entry.block === a.entry.block ? j < k : isWithin(a.p, b.p, (x, y) => sameName(x, y, d.intl)))));
    for (const t of tops) { const n = tallyTop(t.entry); entries += n.entries; bytes += n.bytes; }
    if (entries > ZIP_LIMITS.maxEntries || bytes > ZIP_LIMITS.maxBytes) return { ok: false as const, reason: 'too_large' as const };
    for (const t of tops) {
      const r = readTop(d.bytes, t.entry);
      if ('unreadable' in r) return { ok: false as const, reason: 'unreadable' as const, name: r.unreadable };
      read.push({ i: t.i, top: r });
    }
  }
  // In the order the paths came, as one zip: a later top sharing a name is the one numbered.
  read.sort((a, b) => a.i - b.i);
  return { ok: true as const, zip: zipReadTops(read.map((r) => r.top)) };
}
