// src/lib/files/shelf.ts
// LIBRARY: above the disks (Files 2 spec §3.2): collections as folders and the titles filed in them. Makedir, Rename and
// Delete of a collection; Copy and Move of titles between the collections and the root; disk images from STASH: into
// the library, filed where they land (R4). Membership only: disks and their history are never touched, and every
// change goes through src/lib/collections.ts, org-scoped. ops.ts sends a request here before any driver. SERVER ONLY.
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { collectionGames } from '@/db/schema/collections';
import {
  addGameToCollection, createCollection, deleteCollection, moveGamesToCollection, removeGameFromCollection, renameCollection,
} from '@/lib/collections';
import { parsePath, type FsPath } from './path';
import { libPath, opMemo, placeInLibrary, titleExists, type LibraryPlace } from './library-paths';
import { addDiskImages } from './add-to-library';
import { driverFor } from './drivers';
import {
  groupBy, refuse, Refused, REMOVE_FAILED, skippedItem, type Added, type CopyMove, type FsCtx, type OpCtx, type OpItem, type Outcome,
} from './driver';
import {
  ADDED_UNFILED, collectionNameProblem, COLLECTION_EXISTS, FILE_ON_SHELF, IN_LIBRARY_ALREADY, MAKEDIR_IN_DISK, NO_COLLECTION_IN_COLLECTION,
  NO_NESTED, ONLY_TITLES_FILED, TITLES_ON_LIBRARY_PAGE,
} from './shelf-rules';

export type ShelfDest = Extract<LibraryPlace, { level: 'root' | 'collection' | 'title' }>;

const fail = (source: string, detail: string): OpItem => ({ source, ok: false, refusal: { code: 'unsupported', detail } });
const gone = (source: string): OpItem => ({ source, ok: false, refusal: { code: 'not_found' } });

/** A LIBRARY: destination above the disks (the root, a collection, a title's disk list); null for anything else. */
export async function shelfDest(ctx: FsCtx, p: FsPath): Promise<ShelfDest | null> {
  if (p.device !== 'LIBRARY') return null;
  const at = await placeInLibrary(ctx, p.segments, opMemo(ctx));
  return at && at.level !== 'disk' ? at : null;
}

/** A LIBRARY: row above a disk's folders (a collection, a title, a disk itself): what Rename and Delete answer here. */
export async function shelfItem(ctx: FsCtx, p: FsPath): Promise<LibraryPlace | null> {
  if (p.device !== 'LIBRARY') return null;
  const at = await placeInLibrary(ctx, p.segments, opMemo(ctx));
  return at && at.level !== 'root' && !(at.level === 'disk' && at.names.length > 0) ? at : null;
}

/** The Library's length rules (trimmed, 1-80). The name clash (R3, any case) is src/lib/collections.ts's own check. */
function cleanName(name: string): string {
  const problem = collectionNameProblem(name);
  if (problem) refuse('bad_name', 400, problem);
  return name.trim();
}

export async function makeCollection(ctx: OpCtx, dest: ShelfDest, name: string): Promise<Outcome> {
  if (dest.level === 'collection') refuse('unsupported', 400, NO_NESTED);
  if (dest.level === 'title') refuse('unsupported', 400, MAKEDIR_IN_DISK);
  const made = await createCollection(ctx.orgId, cleanName(name));
  if (made === 'name_exists') refuse('name_exists', 409, COLLECTION_EXISTS);
  return { kind: 'done', items: [{ source: libPath(made.id), ok: true }] };
}

export async function renameOnShelf(ctx: OpCtx, source: string, at: LibraryPlace, name: string): Promise<Outcome> {
  if (at.level !== 'collection') refuse('unsupported', 400, TITLES_ON_LIBRARY_PAGE);
  const r = await renameCollection(ctx.orgId, at.collection.id, cleanName(name));
  if (r === 'name_exists') refuse('name_exists', 409, COLLECTION_EXISTS);
  if (!r) refuse('not_found', 404);
  return { kind: 'done', items: [{ source, ok: true }] };
}

/** Each collection deleted (its titles stay in the library); a title or a disk row is refused, per item. */
export async function deleteOnShelf(ctx: OpCtx, sources: string[]): Promise<Outcome> {
  const items: OpItem[] = [];
  for (const source of sources) {
    const p = parsePath(source);
    const at = p ? await shelfItem(ctx, p) : null;
    if (!at) { items.push(gone(source)); continue; }
    if (at.level !== 'collection') { items.push(fail(source, TITLES_ON_LIBRARY_PAGE)); continue; }
    items.push((await deleteCollection(ctx.orgId, at.collection.id)) ? { source, ok: true } : gone(source));
  }
  return { kind: 'done', items };
}

type Title = { source: string; gameId: string; from: string | null };

/**
 * Copy or Move onto the root or a collection (D4, R4, R5). Titles change membership; disk images from STASH: are added
 * to the library and filed. A title is never duplicated: one already in the target is skipped and left where it was.
 */
export async function fileOnShelf(ctx: OpCtx, req: CopyMove, dest: ShelfDest): Promise<Outcome> {
  if (dest.level === 'title') {
    if (!(await titleExists(ctx, dest.gameId))) refuse('not_found', 404);   // a deleted collection reads as a title id
    refuse('unsupported', 400, FILE_ON_SHELF);
  }
  const to = dest.level === 'collection' ? dest.collection.id : null;
  const results = new Map<string, OpItem>();
  const titles: Title[] = [];
  const images: string[] = [];
  for (const source of req.sources) {
    const p = parsePath(source);
    if (p?.device === 'STASH') { images.push(source); continue; }
    const at = p?.device === 'LIBRARY' ? await placeInLibrary(ctx, p.segments, opMemo(ctx)) : null;
    if (p?.device === 'LIBRARY' && !at) { results.set(source, gone(source)); continue; }
    if (at?.level === 'title') { titles.push({ source, gameId: at.gameId, from: at.collection?.id ?? null }); continue; }
    results.set(source, fail(source, at?.level === 'collection' ? NO_COLLECTION_IN_COLLECTION : ONLY_TITLES_FILED));
  }
  await fileTitles(ctx, req.op, titles, to, results);
  const added = images.length ? await fileImages(ctx, req.op, images, to, results) : [];
  return { kind: 'done', items: req.sources.map((s) => results.get(s)!), ...(added.length ? { added } : {}) };
}

async function fileTitles(ctx: OpCtx, op: 'copy' | 'move', titles: Title[], to: string | null, results: Map<string, OpItem>) {
  if (!titles.length) return;
  if (to === null) {
    // To the root: a copy has nothing to do; a move takes each out of the collection it was listed under.
    for (const t of titles) {
      if (op === 'copy' || t.from === null) { results.set(t.source, fail(t.source, IN_LIBRARY_ALREADY)); continue; }
      results.set(t.source, (await removeGameFromCollection(ctx.orgId, t.from, t.gameId)) ? { source: t.source, ok: true } : gone(t.source));
    }
    return;
  }
  // Already there (R5; Review Focus 1: also every title listed in `to` itself): skipped, and left in its own collection.
  const already = new Set((await getDb().select({ g: collectionGames.gameId }).from(collectionGames)
    .where(and(eq(collectionGames.collectionId, to), inArray(collectionGames.gameId, titles.map((t) => t.gameId))))).map((r) => r.g));
  const todo: Title[] = [];
  for (const t of titles) {
    if (already.has(t.gameId)) results.set(t.source, skippedItem(t.source));
    else todo.push(t);
  }
  for (const [from, group] of groupBy(todo, (t) => (op === 'move' ? t.from : null))) {
    const r = await moveGamesToCollection(ctx.orgId, group.map((t) => t.gameId), to, from ?? undefined);
    if (!r) { for (const t of group) results.set(t.source, gone(t.source)); continue; }   // the collection went meanwhile
    const missing = new Set(r.missing);
    for (const t of group) results.set(t.source, missing.has(t.gameId) ? gone(t.source) : { source: t.source, ok: true });
  }
}

/**
 * Each image added to the library and, onto a collection, filed there. Only an image that was added AND filed counts
 * in `added` and leaves STASH: on a move:
 * - the collection deleted meanwhile: not found (the disk stays in the library, in no collection; the detail says so);
 * - an image the library already had whose title is already in the collection: skipped, as a title would be (R5).
 */
async function fileImages(ctx: OpCtx, op: 'copy' | 'move', sources: string[], to: string | null, results: Map<string, OpItem>): Promise<Added[]> {
  const out = await addDiskImages(ctx, sources);
  for (const it of out.items) results.set(it.source, it);
  const already = to && out.known.size ? new Set((await getDb().select({ g: collectionGames.gameId }).from(collectionGames)
    .where(and(eq(collectionGames.collectionId, to), inArray(collectionGames.gameId, out.added.map((a) => a.gameId))))).map((r) => r.g))
    : new Set<string>();
  const added: Added[] = [];
  for (const a of out.added) {
    if (to && out.known.has(a.source) && already.has(a.gameId)) { results.set(a.source, skippedItem(a.source)); continue; }
    if (to && !(await addGameToCollection(ctx.orgId, to, a.gameId))) {
      results.set(a.source, { source: a.source, ok: false, refusal: { code: 'not_found', detail: ADDED_UNFILED } });
      continue;
    }
    added.push(a);
  }
  if (op === 'move') {
    const done = added.map((a) => a.source).filter((s) => results.get(s)?.ok);
    if (done.length) {
      try {
        const r = await driverFor('STASH')!.remove!(ctx, done);
        if (r.kind === 'done') {
          for (const x of r.items) if (!x.ok) results.set(x.source, { source: x.source, ok: false, refusal: { code: x.refusal.code, detail: REMOVE_FAILED } });
        }
      } catch (e) {
        if (!(e instanceof Refused)) throw e;
        for (const s of done) results.set(s, { source: s, ok: false, refusal: { code: e.refusal.code, detail: REMOVE_FAILED } });
      }
    }
  }
  return added;
}
