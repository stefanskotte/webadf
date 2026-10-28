// src/lib/files/library.ts
// LIBRARY: (spec 2026-10-29 §4.1): titles → disks → a disk's AmigaDOS folders. SERVER ONLY.
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks, entitlements, games } from '@/db/schema/catalog';
import { diskStore } from '@/lib/storage';
import { readVolume, readUsage, readFile, geometryOf, HD_GEOMETRY, type AdfEntry } from '@/lib/adffs';
import { sameName } from '@/lib/adffs/write';
import { findHolder, mountedReason } from '@/lib/disk-holder';
import { isLocal } from '@/lib/remote-hidden';
import { formatPath, type FsPath } from './path';
import type { Crumb, DiskInfo, FsEntry, Listing } from './types';

export type FsCtx = { orgId: string; userId: string | null };
export type ResolvedDisk = { info: DiskInfo; bytes: Uint8Array; root: AdfEntry[]; rootBlock: number; intl: boolean };

const ROOT: Crumb = { label: 'LIBRARY:', path: 'LIBRARY:' };
const lib = (...segs: string[]) => formatPath({ device: 'LIBRARY', segments: segs });
const diskName = (d: { label: string | null; diskNo: number }) => d.label ?? `Disk ${d.diskNo}`;

export async function loadDisk(ctx: FsCtx, gameId: string, diskId: string): Promise<ResolvedDisk | null> {
  const db = getDb();
  const [row] = await db
    .select({ id: disks.id, gameId: disks.gameId, diskNo: disks.diskNo, label: disks.label, sha256: disks.sha256,
      imageFormat: disks.imageFormat, title: games.title })
    .from(disks)
    .innerJoin(entitlements, and(eq(entitlements.orgId, disks.orgId), eq(entitlements.sha256, disks.sha256)))
    .innerJoin(games, and(eq(games.id, disks.gameId), eq(games.orgId, ctx.orgId), isLocal(games)))
    .where(and(eq(disks.id, diskId), eq(disks.gameId, gameId), eq(disks.orgId, ctx.orgId), isLocal(disks)))
    .limit(1);
  if (!row) return null;
  const bytes = await diskStore.read(row.sha256);
  const vol = readVolume(bytes);
  const usage = vol.ok ? readUsage(bytes) : null;
  const holder = await findHolder(db, ctx.orgId, row.sha256);
  const info: DiskInfo = {
    diskId: row.id, gameId: row.gameId, title: row.title, label: diskName(row),
    filesystem: vol.ok ? vol.volume.filesystem : null, hd: geometryOf(bytes)?.blockCount === HD_GEOMETRY.blockCount,
    usedBytes: usage?.usedBytes ?? null, freeBytes: usage?.freeBytes ?? null, totalBytes: usage?.totalBytes ?? null,
    holder: holder?.name ?? null, imageFormat: row.imageFormat, volumeName: vol.ok ? vol.volume.name : null, sha256: row.sha256,
  };
  return { info, bytes, root: vol.ok ? vol.root : [], rootBlock: vol.ok ? vol.rootBlock : 0, intl: vol.ok ? vol.volume.intl : false };
}

export function resolveInDisk(d: ResolvedDisk, names: string[]) {
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

function toEntry(base: string[], e: AdfEntry): FsEntry {
  return { name: e.name, kind: e.kind, path: lib(...base, e.name), size: e.kind === 'file' ? e.sizeBytes : null,
    date: e.modifiedAt?.toISOString() ?? null, protection: e.protection, comment: e.comment, marks: [] };
}

export async function listLibrary(ctx: FsCtx, p: FsPath): Promise<Listing | null> {
  const db = getDb();
  const [gameId, diskId, ...names] = p.segments;
  if (!gameId) {
    const rows = await db.select({ id: games.id, title: games.title }).from(games)
      .where(and(eq(games.orgId, ctx.orgId), isLocal(games))).orderBy(asc(games.sortTitle), asc(games.id));
    return { path: 'LIBRARY:', crumbs: [ROOT], writable: false, readOnlyReason: null, disk: null,
      meta: `${rows.length} titles`,
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
      meta: `${rows.length} ${rows.length === 1 ? 'disk' : 'disks'}` };
  }
  const d = await loadDisk(ctx, gameId, diskId);
  if (!d) return null;
  const at = resolveInDisk(d, names);
  if (!at || (at.entry && at.entry.kind !== 'dir')) return null;
  const children = at.entry ? at.entry.children : d.root;
  const base = [gameId, diskId, ...(names.length ? names : [])];
  const readOnlyReason = d.info.holder ? mountedReason(d.info.holder)
    : d.info.imageFormat === 'hfe' ? 'hfe_read_only' : !d.info.filesystem ? 'no_filesystem' : null;
  const dirs = children.filter((c) => c.kind === 'dir').length;
  const crumbs: Crumb[] = [ROOT, titleCrumb, { label: d.info.label, path: lib(gameId, diskId) }];
  names.forEach((_, i) => crumbs.push({ label: resolveInDisk(d, names.slice(0, i + 1))!.entry!.name, path: lib(gameId, diskId, ...names.slice(0, i + 1)) }));
  return { path: formatPath(p), crumbs, entries: children.map((c) => toEntry(base, c)), writable: readOnlyReason === null,
    readOnlyReason, disk: d.info, meta: `${dirs} folders · ${children.length - dirs} files` };
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
