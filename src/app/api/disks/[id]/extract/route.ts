import { createHash } from 'node:crypto';
import { after } from 'next/server';
import { and, eq, isNotNull } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks, entitlements, blobs } from '@/db/schema/catalog';
import { requireOrg } from '@/lib/session';
import { diskStore } from '@/lib/storage';
import { stableId } from '@/lib/ingest';
import { sweep } from '@/lib/tosec-sweep';
import { parseHfe } from '@/lib/hfe/parse';
import { extractAdf } from '@/lib/hfe/extract';

// Reads ~2 MB, decodes 1,760 sectors (~100 ms), writes 880 KB.
export const maxDuration = 60;

/**
 * Extract as ADF (HFE spec D5): a NEW, ordinary adf disk in the same game,
 * made from the HFE's AmigaDOS sectors. The HFE row and its bytes are never
 * touched. Idempotent: the ADF's id derives from its content, so extracting
 * twice lands on the same row -- unless that row has been edited since,
 * which is a 409 `already_extracted` rather than a silent no-op (below).
 *
 * THE ENTITLEMENT is the boundary, as on every byte route; 404, never 403.
 */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  const db = getDb();

  const rows = await db
    .select({
      sha256: disks.sha256, gameId: disks.gameId, diskNo: disks.diskNo, isBoot: disks.isBoot,
      imageFormat: disks.imageFormat, extractable: disks.extractable, extractReason: disks.extractReason,
      tosecName: disks.tosecName, sourceFilename: entitlements.sourceFilename,
    })
    .from(disks)
    .innerJoin(entitlements, and(eq(entitlements.sha256, disks.sha256), eq(entitlements.orgId, orgId)))
    .where(and(eq(disks.id, id), eq(disks.orgId, orgId)))
    .limit(1);
  const disk = rows[0];
  if (!disk) return Response.json({ error: 'not_found' }, { status: 404 });
  if (disk.imageFormat !== 'hfe') return Response.json({ error: 'not_hfe' }, { status: 409 });
  if (!disk.extractable) {
    return Response.json({ error: 'not_extractable', reason: disk.extractReason }, { status: 409 });
  }

  let hfe: Uint8Array;
  try {
    hfe = await diskStore.read(disk.sha256);
  } catch {
    return Response.json({ error: 'blob_unavailable' }, { status: 503 });
  }

  const parsed = parseHfe(hfe);
  const x = parsed.ok ? extractAdf(parsed.disk) : { ok: false as const, reason: parsed.reason };
  // Unreachable for a row ingest marked extractable -- unless the decoder
  // changed since. Permanent, so 422 rather than 500.
  if (!x.ok) return Response.json({ error: 'extract_failed', reason: x.reason }, { status: 422 });

  const sha256 = createHash('sha256').update(x.adf).digest('hex');
  const hfeName = disk.tosecName ?? disk.sourceFilename ?? `${disk.sha256.slice(0, 12)}.hfe`;
  const adfName = hfeName.replace(/\.hfe$/i, '') + '.adf';
  const diskId = stableId('disk', disk.gameId, sha256);

  // ALREADY EXTRACTED, AND EDITED SINCE. disks.id never changes when a disk
  // is edited -- only disks.sha256 moves (disk-history/store.ts) -- so the
  // row at this content-derived id can hold different bytes by now. The
  // insert below would then do nothing, and answering 200 with this id
  // claimed a fresh extract while handing back somebody's edited disk.
  // Refused before anything is written, naming the disk so the page can link
  // to it; its History still holds these exact bytes as version 0, and a
  // restore gets them back. The same bytes on that row is a plain repeat,
  // and stays the idempotent 200 it always was.
  const [existing] = await db.select({ sha256: disks.sha256 }).from(disks)
    .where(and(eq(disks.id, diskId), eq(disks.orgId, orgId)))
    .limit(1);
  if (existing && existing.sha256 !== sha256) {
    return Response.json({ error: 'already_extracted', diskId }, { status: 409 });
  }

  await diskStore.put(sha256, x.adf);
  await db.insert(blobs).values({
    sha256, sizeBytes: x.adf.length, storageKey: diskStore.storageKey(sha256),
  }).onConflictDoNothing();
  await db.insert(entitlements).values({ orgId, sha256, sourceFilename: adfName }).onConflictDoNothing();

  await db.insert(disks).values({
    id: diskId, gameId: disk.gameId, orgId, diskNo: disk.diskNo, sha256,
    label: `Extracted from ${hfeName}`, tosecName: adfName, isBoot: disk.isBoot,
    sizeBytes: x.adf.length, imageFormat: 'adf',
  }).onConflictDoNothing();

  // The extracted ADF of a clean title is usually the canonical one, so its
  // blob has often been decided already, by any org. The sweeper only picks up
  // a null cursor and applyMatch rewrites only the rows that exist when it
  // runs, so without this the row just inserted is never identified. The same
  // guarded reset /api/ingest/complete does.
  await db.update(blobs).set({
    matchCheckedAt: null, matchState: null, tosecEntryId: null,
  }).where(and(eq(blobs.sha256, sha256), isNotNull(blobs.matchCheckedAt)));

  // Identify the new ADF now rather than at 03:00 -- same reasoning, and the
  // same never-surface-a-failure rule, as /api/ingest/complete.
  after(async () => {
    try { await sweep(45_000); } catch (err) { console.error('extract: post-extract sweep failed', err); }
  });

  return Response.json({ diskId, sha256 });
}
