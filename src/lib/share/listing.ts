// What the share API lists (spec §3.2), every query bounded by the scope test in scope.ts, evaluated per request.
// Hidden remote copies (games/disks with remote_library_id) are never listed or counted.
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/db';
import { organization } from '@/db/schema/auth';
import { blobs, disks, games } from '@/db/schema/catalog';
import { collectionGames, collections } from '@/db/schema/collections';
import { coverUrlsForGames, kindsForGames } from '@/lib/queries';
import { gameInScope, scopedCollectionIds } from './scope';
import type { ShareAuth } from './store';
import type { ShareDisk, ShareLibrary, ShareTitle } from './types';

export const DEFAULT_LIBRARY_NAME = 'WebFloppy library';
export const TITLES_DEFAULT_LIMIT = 48;
export const TITLES_MAX_LIMIT = 200;

export async function libraryName(orgId: string): Promise<string> {
  const [row] = await getDb().select({ name: organization.name }).from(organization)
    .where(eq(organization.id, orgId)).limit(1);
  return row?.name?.trim() || DEFAULT_LIBRARY_NAME;
}

/** A disk row the share may count: the owner's own, never a hidden remote copy. */
const localDiskOf = (orgId: string) => and(eq(disks.gameId, games.id), eq(disks.orgId, orgId), isNull(disks.remoteLibraryId));

export async function libraryOverview(auth: ShareAuth): Promise<ShareLibrary> {
  const db = getDb();
  const ids = await scopedCollectionIds(auth);
  const [name, totals, perCollection, names] = await Promise.all([
    libraryName(auth.orgId),
    db.select({
      titles: sql<number>`count(distinct ${games.id})::int`,
      disks: sql<number>`count(${disks.id})::int`,
    }).from(games).leftJoin(disks, localDiskOf(auth.orgId)).where(gameInScope(auth)),
    ids.length === 0 ? Promise.resolve([]) : db.select({
      id: collectionGames.collectionId, titles: sql<number>`count(*)::int`,
    }).from(collectionGames)
      .innerJoin(games, eq(games.id, collectionGames.gameId))
      .where(and(inArray(collectionGames.collectionId, ids), eq(games.orgId, auth.orgId), isNull(games.remoteLibraryId)))
      .groupBy(collectionGames.collectionId),
    ids.length === 0 ? Promise.resolve([]) : db.select({ id: collections.id, name: collections.name }).from(collections)
      .where(and(inArray(collections.id, ids), eq(collections.orgId, auth.orgId))),
  ]);
  const countOf = new Map(perCollection.map((r) => [r.id, r.titles]));
  const nameOf = new Map(names.map((r) => [r.id, r.name]));
  return {
    name,
    // scopedCollectionIds' order (the owner's own sort), not the query's.
    collections: ids.map((id) => ({ id, name: nameOf.get(id) ?? '', titles: countOf.get(id) ?? 0 })),
    titles: totals[0]?.titles ?? 0,
    disks: totals[0]?.disks ?? 0,
  };
}

export type TitleCursor = { sortTitle: string; id: string };

/** Opaque to the recipient: base64url JSON of the last row's sort key. */
export function encodeCursor(c: TitleCursor): string {
  return Buffer.from(JSON.stringify([c.sortTitle, c.id]), 'utf8').toString('base64url');
}

export function decodeCursor(s: string): TitleCursor | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string') {
      return { sortTitle: v[0], id: v[1] };
    }
  } catch { /* fall through */ }
  return null;
}

/** ILIKE pattern matching `q` literally anywhere in the title. */
function containsPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

type TitleRow = { id: string; title: string; year: number | null; publisher: string | null; diskCount: number };

/** Kind, cover flag and the shared collections each title is in -- batched over the page, never per title. */
async function toShareTitles(auth: ShareAuth, rows: TitleRow[]): Promise<ShareTitle[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const scoped = await scopedCollectionIds(auth);
  const [kinds, covers, memberships] = await Promise.all([
    kindsForGames(auth.orgId, ids),
    coverUrlsForGames(auth.orgId, ids),
    scoped.length === 0 ? Promise.resolve([]) : getDb()
      .select({ gameId: collectionGames.gameId, collectionId: collectionGames.collectionId })
      .from(collectionGames)
      .where(and(inArray(collectionGames.gameId, ids), inArray(collectionGames.collectionId, scoped))),
  ]);
  const order = new Map(scoped.map((id, i) => [id, i]));
  const inColl = new Map<string, string[]>();
  for (const m of memberships) inColl.set(m.gameId, [...(inColl.get(m.gameId) ?? []), m.collectionId]);
  return rows.map((r) => ({
    id: r.id, title: r.title, year: r.year, publisher: r.publisher,
    kind: kinds.get(r.id) ?? null,
    diskCount: r.diskCount,
    hasCover: covers.has(r.id),
    collectionIds: (inColl.get(r.id) ?? []).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)),
  }));
}

function titleRows(auth: ShareAuth, where: SQL | undefined) {
  return getDb().select({
    id: games.id, title: games.title, year: games.year, publisher: games.publisher, sortTitle: games.sortTitle,
    diskCount: sql<number>`count(${disks.id})::int`,
  }).from(games)
    .leftJoin(disks, localDiskOf(auth.orgId))
    .where(and(gameInScope(auth), where))
    .groupBy(games.id);
}

/**
 * One page of titles in scope, by sort title then id (keyset paging, so a page boundary never repeats or skips a
 * title when others are added). Null when `collectionId` is not a collection this share exposes.
 */
export async function listScopedTitles(
  auth: ShareAuth,
  opts: { collectionId?: string; q?: string; cursor?: string | null; limit: number },
): Promise<{ titles: ShareTitle[]; nextCursor: string | null } | null> {
  const filters: SQL[] = [];
  if (opts.collectionId) {
    if (!(await scopedCollectionIds(auth)).includes(opts.collectionId)) return null;
    filters.push(sql`exists (select 1 from ${collectionGames} where ${collectionGames.collectionId} = ${opts.collectionId}
      and ${collectionGames.gameId} = ${games.id})`);
  }
  const q = opts.q?.trim();
  if (q) filters.push(sql`${games.title} ilike ${containsPattern(q)}`);
  if (opts.cursor) {
    const c = decodeCursor(opts.cursor);
    if (!c) throw new Error('listScopedTitles: malformed cursor');
    filters.push(sql`(${games.sortTitle}, ${games.id}) > (${c.sortTitle}, ${c.id})`);
  }
  const limit = Math.min(Math.max(1, Math.floor(opts.limit)), TITLES_MAX_LIMIT);
  const rows = await titleRows(auth, filters.length ? and(...filters) : undefined)
    .orderBy(asc(games.sortTitle), asc(games.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    titles: await toShareTitles(auth, page),
    nextCursor: rows.length > limit && last ? encodeCursor({ sortTitle: last.sortTitle, id: last.id }) : null,
  };
}

/** One title in scope and its local disks, or null (absent, another org's, hidden, or not shared: all alike). */
export async function scopedTitle(auth: ShareAuth, gameId: string): Promise<{ title: ShareTitle; disks: ShareDisk[] } | null> {
  const rows = await titleRows(auth, eq(games.id, gameId));
  if (rows.length === 0) return null;
  const [title] = await toShareTitles(auth, rows);
  const diskRows = await getDb().select({
    id: disks.id, diskNo: disks.diskNo, label: disks.label, tosecName: disks.tosecName,
    sizeBytes: disks.sizeBytes, sha256: disks.sha256, imageFormat: disks.imageFormat, extractable: disks.extractable,
    // disks has no updated_at: a changed disk is a new sha256, so its blob's first-stored time is when it changed.
    updatedAt: blobs.createdAt,
  }).from(disks)
    .innerJoin(blobs, eq(blobs.sha256, disks.sha256))
    .where(and(eq(disks.gameId, gameId), eq(disks.orgId, auth.orgId), isNull(disks.remoteLibraryId)))
    .orderBy(asc(disks.diskNo), asc(disks.id));
  return {
    title,
    disks: diskRows.map((d) => ({
      id: d.id,
      name: d.label?.trim() || d.tosecName?.trim() || `Disk ${d.diskNo}`,
      diskNo: d.diskNo, sizeBytes: d.sizeBytes, sha256: d.sha256, imageFormat: d.imageFormat,
      extractable: d.imageFormat === 'hfe' ? d.extractable === true : true,
      updatedAt: d.updatedAt.toISOString(),
    })),
  };
}

export type ScopedDisk = {
  id: string; sha256: string; sizeBytes: number; imageFormat: string; extractable: boolean | null; extractReason: string | null;
};

/** A disk in scope with what the files route needs to decide whether it can be read. */
export async function scopedDisk(auth: ShareAuth, diskId: string): Promise<ScopedDisk | null> {
  const rows = await getDb().select({
    id: disks.id, sha256: disks.sha256, sizeBytes: disks.sizeBytes,
    imageFormat: disks.imageFormat, extractable: disks.extractable, extractReason: disks.extractReason,
  }).from(disks).innerJoin(games, eq(games.id, disks.gameId))
    .where(and(eq(disks.id, diskId), eq(disks.orgId, auth.orgId), isNull(disks.remoteLibraryId), gameInScope(auth)))
    .limit(1);
  return rows[0] ?? null;
}

export type CoverSource = { store: 'image'; digest: string } | { store: 'cover'; digest: string };

const IMAGE_URL = /^\/api\/images\/([0-9a-f]{40})$/;
const OVERRIDE_URL = /^\/api\/games\/[^/]+\/cover\/([0-9a-f]{64})$/;

/**
 * Where an in-scope title's cover lives, by the library's one precedence rule (coverUrlsForGames ->
 * effectiveCoverUrl): the owner's own image in the cover store, else an enriched one in the image store.
 */
export async function scopedCoverSource(auth: ShareAuth, gameId: string): Promise<CoverSource | null> {
  const inScope = await getDb().select({ id: games.id }).from(games)
    .where(and(eq(games.id, gameId), gameInScope(auth))).limit(1);
  if (inScope.length === 0) return null;
  const url = (await coverUrlsForGames(auth.orgId, [gameId])).get(gameId);
  if (!url) return null;
  const image = IMAGE_URL.exec(url);
  if (image) return { store: 'image', digest: image[1] };
  const own = OVERRIDE_URL.exec(url);
  if (own) return { store: 'cover', digest: own[1] };
  return null;
}
