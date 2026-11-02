// src/lib/files/disks-as-folders.ts
// Big copies part 2 (spec 2026-11-02): a library disk (a DSK row), or a title (a TTL row: its disks), copied onto a NET:
// volume arrives as one drawer per disk, named as the row is. No title drawer and never a drawer icon. Each disk stands
// or falls by itself: one that cannot go is refused by its own item while the others are queued. SERVER ONLY.
import { and, asc, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks, entitlements, games } from '@/db/schema/catalog';
import { mapLimit } from '@/lib/pool';
import { COPY_MAX_DISKS } from '@/lib/remote-limits';
import { isLocal } from '@/lib/remote-hidden';
import { SEND_FILE_MAX } from '@/lib/transfers';
import { checkName, groupBy, itemResult, refuse, type CopyMove, type IncomingItem, type IncomingTop, type OpCtx, type OpItem, type Outcome } from './driver';
import { BlobUnavailableError, diskName, loadDisk, type ResolvedDisk } from './library';
import { walk } from './library-driver';
import { libPath, opMemo, placeInLibrary, type LibraryPlace } from './library-paths';
import { copyOntoVolume, isNetVolumeDir } from './net-write';
import { parsePath, type FsPath } from './path';
import { COLLECTIONS_STAY, DISKS_STAY_IN_LIBRARY } from './shelf-rules';

const NOT_ROWS = 'disks and titles go on their own';

type TitleRow = Extract<LibraryPlace, { level: 'title' }>;
type DiskRow = Extract<LibraryPlace, { level: 'disk' }>;
const isRow = (at: LibraryPlace | null): at is TitleRow | DiskRow => at?.level === 'title' || (at?.level === 'disk' && at.names.length === 0);

type OneDisk = { source: string; gameId: string; diskId: string; name: string };
const notFound = (source: string): OpItem => ({ source, ok: false, refusal: { code: 'not_found' } });

/** The disks a title shows in its list, by title, in `diskNo` order. Reads no image. */
async function disksOfTitles(ctx: OpCtx, gameIds: string[]) {
  const rows = await getDb().select({ id: disks.id, gameId: disks.gameId, diskNo: disks.diskNo, label: disks.label }).from(disks)
    .innerJoin(entitlements, and(eq(entitlements.orgId, disks.orgId), eq(entitlements.sha256, disks.sha256)))
    .innerJoin(games, and(eq(games.id, disks.gameId), eq(games.orgId, ctx.orgId), isLocal(games)))
    .where(and(inArray(disks.gameId, gameIds), eq(disks.orgId, ctx.orgId), isLocal(disks))).orderBy(asc(disks.diskNo));
  return groupBy(rows, (r) => r.gameId);
}

/** One disk as a copy's top, or the item that says why it cannot go. */
async function collectDisk(ctx: OpCtx, { source, gameId, diskId, name }: OneDisk): Promise<IncomingTop | OpItem> {
  let d: ResolvedDisk | null;
  try { d = await loadDisk(ctx, gameId, diskId); } catch (e) {
    if (e instanceof BlobUnavailableError) return { source, ok: false, refusal: { code: 'blob_unavailable', detail: diskId } };
    throw e;
  }
  if (!d) return notFound(source);
  const disk = d;
  const items: IncomingItem[] = [];
  const checked = itemResult(source, () => {
    if (!disk.info.filesystem) refuse('unsupported', 400, `${name} cannot be read as files`);
    checkName(name);
    items.push({ rel: [name], kind: 'dir', date: null, protection: 0, comment: null });
    for (const entry of disk.root) walk(disk.bytes, entry, [name, entry.name], items);
    const big = items.find((i) => (i.bytes?.length ?? 0) > SEND_FILE_MAX);
    if (big) refuse('too_large', 413, `${name}: ${big.rel.slice(1).join('/')} is over 4 MB`);
  });
  return checked.ok ? { source, items } : checked;
}

/**
 * A copy of DSK and TTL rows onto a volume; null unless `dest` is a volume directory and a source is such a row (every
 * other copy goes on as it did). A selection over `COPY_MAX_DISKS` is refused whole before any image is read: the server
 * has no per-disk file count without decoding them.
 */
export async function copyDisksOntoVolume(ctx: OpCtx, req: CopyMove, dest: FsPath): Promise<Outcome | null> {
  if (!isNetVolumeDir(dest)) return null;
  const places = await mapLimit(req.sources, 12, async (raw) => {
    const p = parsePath(raw);
    return p?.device === 'LIBRARY' ? placeInLibrary(ctx, p.segments, opMemo(ctx)) : null;
  });
  if (!places.some(isRow)) return null;
  if (places.some((at) => at?.level === 'collection')) refuse('unsupported', 400, COLLECTIONS_STAY);
  if (!places.every(isRow)) refuse('unsupported', 400, NOT_ROWS);
  if (req.op === 'move') refuse('unsupported', 400, DISKS_STAY_IN_LIBRARY);

  const rows = places as (TitleRow | DiskRow)[];
  const byTitle = await disksOfTitles(ctx, [...new Set(rows.map((at) => at.gameId))]);
  // In source order, a title in place of its disks; a row that is not here (null) is that item's refusal.
  const wanted: { source: string; disk: OneDisk | null }[] = rows.flatMap((at, i) => {
    const here = byTitle.get(at.gameId) ?? [];
    if (at.level === 'disk') {
      const r = here.find((x) => x.id === at.diskId);
      const source = req.sources[i];
      return [{ source, disk: r ? { source, gameId: at.gameId, diskId: r.id, name: diskName(r) } : null }];
    }
    if (!here.length) return [{ source: req.sources[i], disk: null }];
    return here.map((r) => {
      const source = libPath(...at.prefix, at.gameId, r.id);
      return { source, disk: { source, gameId: at.gameId, diskId: r.id, name: diskName(r) } };
    });
  });
  if (wanted.filter((w) => w.disk).length > COPY_MAX_DISKS) refuse('too_large', 413, `at most ${COPY_MAX_DISKS} disks at a time`);

  // One at a time, so at most one whole image is held while the files are read out of it.
  const tops: IncomingTop[] = [];
  const results = new Map<string, OpItem>();
  for (const w of wanted) {
    const got = w.disk ? await collectDisk(ctx, w.disk) : notFound(w.source);
    if ('items' in got) tops.push(got); else results.set(w.source, got);
  }
  if (!tops.length) return { kind: 'done', items: wanted.map((w) => results.get(w.source)!), written: [] };

  const out = await copyOntoVolume(ctx, dest, tops, req.onClash);
  if (out.kind !== 'done') return out;
  for (const it of out.items) results.set(it.source, it);
  return { ...out, items: wanted.map((w) => results.get(w.source)!) };
}
