import { z } from 'zod';
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks, blobs, entitlements } from '@/db/schema/catalog';
import { collections, collectionGames } from '@/db/schema/collections';
import { requireOrg } from '@/lib/session';
import { diskStore } from '@/lib/storage';
import { stableId } from '@/lib/ingest';
import { formatVolume, MAX_VOLUME_NAME } from '@/lib/adffs/format';
import { makeSortTitle } from '@/lib/tosec';

export const maxDuration = 60;

const body = z.object({
  volumeName: z.string().trim().min(1).max(MAX_VOLUME_NAME).optional(),
  filesystem: z.enum(['OFS', 'FFS']).optional(),
  /** The collection currently being viewed, so a disk lands where you stand. */
  collectionId: z.string().optional(),
});

/** What a disk is called before anyone names it. */
const DEFAULT_NAME = 'Empty';

/**
 * Make a blank, formatted Amiga disk.
 *
 * The bytes are built HERE and stored directly (diskStore.put) rather than
 * through the presigned-upload path: that path exists so a browser's large
 * uploads never pass through a function, and these 880 KB are already in this
 * function's memory.
 *
 * THE DISK IS REAL THE MOMENT THIS RETURNS (operator's ruling, 2026-09-03):
 * blob, entitlement, game and disk rows all exist, and the name is edited
 * afterwards like any other. There is no draft state.
 */
export async function POST(request: Request) {
  const { orgId } = await requireOrg();

  let raw: unknown = {};
  try { raw = await request.json(); } catch { /* an empty body is a fine request */ }
  const parsed = body.safeParse(raw ?? {});
  if (!parsed.success) {
    return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
  }

  const volumeName = parsed.data.volumeName ?? DEFAULT_NAME;
  // FFS by default (operator's ruling): faster, the norm from Workbench 2.0,
  // and more room per disk. OFS stays selectable for 1.3-era hardware.
  const filesystem = parsed.data.filesystem ?? 'FFS';

  const bytes = formatVolume({ filesystem, volumeName });
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  // Content-addressed, so two blank disks made in the same millisecond with
  // the same name ARE the same bytes and the same blob. Everything below is
  // onConflictDoNothing for that reason, not merely for retries.
  await diskStore.put(sha256, bytes);

  const db = getDb();
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

  // "Created where you stand": if the library is filtered to a collection,
  // the new disk joins it. Resolved against this org's own collections first
  // -- collection_games has no org_id (D-4-5), so an unchecked id here would
  // file a game into another tenant's collection.
  let collectionId: string | null = null;
  if (parsed.data.collectionId) {
    const owned = await db.select({ id: collections.id }).from(collections)
      .where(and(eq(collections.id, parsed.data.collectionId), eq(collections.orgId, orgId)))
      .limit(1);
    if (owned.length > 0) {
      collectionId = owned[0].id;
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
  }

  return Response.json({ gameId, diskId, sha256, volumeName, filesystem, collectionId });
}
