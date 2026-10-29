// src/lib/files/library-paths.ts
// Where a LIBRARY: path is (Files 2 spec §3.1): the root, a collection, a title, or a disk and the folders on it. The
// first segment is a collection when it names one of THIS org's collections, otherwise a title; collection and game
// ids are both UUID-shaped, so only the database can tell them apart (ruling R2). A path through a collection the
// title is not filed in is not found, so a stale link never shows a title in the wrong place. SERVER ONLY.
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { games } from '@/db/schema/catalog';
import { collections, collectionGames } from '@/db/schema/collections';
import { isLocal } from '@/lib/remote-hidden';
import { formatPath } from './path';
import type { FsCtx } from './driver';

export type Shelved = { id: string; name: string };
/** `prefix`: the segments before the title (the collection id, or none): what every path below this place keeps. */
export type LibraryPlace =
  | { level: 'root'; collection: null; prefix: string[] }
  | { level: 'collection'; collection: Shelved; prefix: string[] }
  | { level: 'title'; collection: Shelved | null; prefix: string[]; gameId: string }
  | { level: 'disk'; collection: Shelved | null; prefix: string[]; gameId: string; diskId: string; names: string[] };

export const libPath = (...segs: string[]) => formatPath({ device: 'LIBRARY', segments: segs });

/** One of this org's collections by id; null for an unknown or foreign id (the same answer). */
export async function collectionOf(ctx: FsCtx, id: string): Promise<Shelved | null> {
  const [c] = await getDb().select({ id: collections.id, name: collections.name }).from(collections)
    .where(and(eq(collections.id, id), eq(collections.orgId, ctx.orgId))).limit(1);
  return c ?? null;
}

/** The title is filed in the collection: both this org's (collection_games has no org_id, D-4-5), the title local. */
export async function isFiledIn(ctx: FsCtx, collectionId: string, gameId: string): Promise<boolean> {
  const [hit] = await getDb().select({ g: collectionGames.gameId }).from(collectionGames)
    .innerJoin(collections, and(eq(collections.id, collectionGames.collectionId), eq(collections.orgId, ctx.orgId)))
    .innerJoin(games, and(eq(games.id, collectionGames.gameId), eq(games.orgId, ctx.orgId), isLocal(games)))
    .where(and(eq(collectionGames.collectionId, collectionId), eq(collectionGames.gameId, gameId))).limit(1);
  return !!hit;
}

/** One of this org's local titles. A destination that reads as a title id may be a deleted or foreign collection. */
export async function titleExists(ctx: FsCtx, gameId: string): Promise<boolean> {
  const [g] = await getDb().select({ id: games.id }).from(games)
    .where(and(eq(games.id, gameId), eq(games.orgId, ctx.orgId), isLocal(games))).limit(1);
  return !!g;
}

export async function placeInLibrary(ctx: FsCtx, segments: readonly string[]): Promise<LibraryPlace | null> {
  if (!segments.length) return { level: 'root', collection: null, prefix: [] };
  const collection = await collectionOf(ctx, segments[0]);
  if (collection && segments.length === 1) return { level: 'collection', collection, prefix: [collection.id] };
  const prefix = collection ? [collection.id] : [];
  const [gameId, diskId, ...names] = segments.slice(prefix.length);
  if (collection && !(await isFiledIn(ctx, collection.id, gameId))) return null;
  if (!diskId) return { level: 'title', collection, prefix, gameId };
  return { level: 'disk', collection, prefix, gameId, diskId, names };
}
