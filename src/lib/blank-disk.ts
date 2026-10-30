// src/lib/blank-disk.ts
// A blank, formatted Amiga disk made real at once (operator's ruling, 2026-09-03): blob, entitlement, game and disk rows,
// optionally filed FIRST in a collection. Shared by /api/disks/create (the Library's Create ADF) and Files' create-adf
// op (Files 2 §4). SERVER ONLY.
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks, blobs, entitlements } from '@/db/schema/catalog';
import { collections, collectionGames } from '@/db/schema/collections';
import { diskStore } from '@/lib/storage';
import { stableId } from '@/lib/ingest';
import { formatVolume } from '@/lib/adffs/format';
import { makeSortTitle } from '@/lib/tosec';

export type BlankDisk = { gameId: string; diskId: string; sha256: string; collectionId: string | null };

/**
 * Make a blank, formatted Amiga disk.
 *
 * The bytes are built HERE and stored directly (diskStore.put) rather than
 * through the presigned-upload path: that path exists so a browser's large
 * uploads never pass through a function, and these 880 KB (or 1.76 MB) are
 * already in this function's memory.
 *
 * THE DISK IS REAL THE MOMENT THIS RETURNS (operator's ruling, 2026-09-03):
 * blob, entitlement, game and disk rows all exist, and the name is edited
 * afterwards like any other. There is no draft state.
 *
 * `collectionId` files the new title first in that collection when it is this org's (collection_games has no org_id,
 * D-4-5, so it is resolved first). The Library ignores an unknown one (a stale ?collection=); Files passes `mustFile`
 * and gets null instead, before anything is written (Files 2 §7: nothing changed).
 */
export async function createBlankDisk(orgId: string, o: {
  volumeName: string; filesystem: 'OFS' | 'FFS'; density: 'dd' | 'hd'; collectionId?: string | null; mustFile?: boolean;
}): Promise<BlankDisk | null> {
  const db = getDb();
  const { volumeName } = o;

  // "Created where you stand": if the library is filtered to a collection,
  // the new disk joins it. Resolved against this org's own collections first
  // -- collection_games has no org_id (D-4-5), so an unchecked id here would
  // file a game into another tenant's collection.
  let collectionId: string | null = null;
  if (o.collectionId) {
    const [owned] = await db.select({ id: collections.id }).from(collections)
      .where(and(eq(collections.id, o.collectionId), eq(collections.orgId, orgId)))
      .limit(1);
    if (owned) collectionId = owned.id;
    else if (o.mustFile) return null;
  }

  const bytes = formatVolume({ filesystem: o.filesystem, volumeName, density: o.density });
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  // Content-addressed, so two blank disks made in the same millisecond with
  // the same name ARE the same bytes and the same blob. Everything below is
  // onConflictDoNothing for that reason, not merely for retries.
  await diskStore.put(sha256, bytes);

  await db.insert(blobs).values({
    sha256, sizeBytes: bytes.length, storageKey: diskStore.storageKey(sha256),
    // Hashes left null, exactly as an upload without client-side hashes: the
    // sweeper computes them, finds no DAT entry -- a disk somebody made is in
    // no preservation set -- and stamps match_state 'none'. That is the
    // correct verdict, not a miss.
  }).onConflictDoNothing();

  await db.insert(entitlements).values({
    orgId, sha256, sourceFilename: `${volumeName}.adf`,
  }).onConflictDoNothing();

  const sortTitle = makeSortTitle(volumeName);
  // Deterministic and org-scoped, exactly like /api/ingest/complete: the
  // dedupe lives on `blobs`, never on these per-tenant catalog rows.
  const gameId = stableId('game', orgId, sortTitle, sha256);
  const diskId = stableId('disk', gameId, sha256);

  await db.insert(games).values({
    id: gameId, orgId, title: volumeName, sortTitle,
    // OUTSIDE MACHINE_SOURCES, and this is the whole authority rule doing its
    // job. A disk somebody made will hash to something no DAT contains, so
    // the sweeper stamps match_state 'none' -- correct, not a miss. Marking
    // it 'human' additionally means applyMatch never retitles it and
    // mergeDuplicates never absorbs it, and a merge DELETES the losing row.
    metadataSource: 'human',
    // Made here, not uploaded. Drives the card's inline rename and keeps this
    // disk out of the TOSEC coverage rate, where it would otherwise read as a
    // gap in the archive rather than as somebody's own disk.
    authored: true,
  }).onConflictDoNothing();

  await db.insert(disks).values({
    id: diskId, gameId, orgId, diskNo: 1, sha256,
    tosecName: `${volumeName}.adf`, isBoot: true, sizeBytes: bytes.length,
  }).onConflictDoNothing();

  if (collectionId) {
    // FIRST in the collection, where addGameToCollection appends. The two
    // differ on purpose: dragging an existing title in is filing something
    // you already know about, but a disk you just made has to be visible or
    // you cannot name it -- and at the end of a long collection it is not.
    // The library itself needs no such help: it already orders by
    // createdAt desc (D9), so a new disk is first there for free.
    const [{ minSort }] = await db
      .select({ minSort: sql<number>`coalesce(min(${collectionGames.sortKey}), 0)::int` })
      .from(collectionGames)
      .where(eq(collectionGames.collectionId, collectionId));
    await db.insert(collectionGames)
      .values({ collectionId, gameId, sortKey: minSort - 1 })
      .onConflictDoNothing();
  }

  return { gameId, diskId, sha256, collectionId };
}
