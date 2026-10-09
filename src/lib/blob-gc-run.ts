import { inArray, isNotNull } from 'drizzle-orm';
import { getDb } from '@/db';
import { blobs, disks, entitlements, games } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { diskVersions, diskWriteSessions } from '@/db/schema/disk-history';
import { coverStore, diskStore } from '@/lib/storage';
import { planBlobGc, planCoverGc, withoutReferenced } from '@/lib/blob-gc';

/** A week: the job runs weekly, so anything it deletes was garbage for at least one full cycle. */
export const BLOB_GC_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export interface BlobGcResult {
  dryRun: boolean;
  storedObjects: number;
  rows: number;
  objects: number;
  /** Object deletions that failed (the row, if any, is then kept for the next run). */
  failed: number;
  refused: string | null;
  /** The cover/ pass (a title's own images): listed, deleted, and its own brake. */
  storedCovers: number;
  covers: number;
  coversRefused: string | null;
}

/**
 * The weekly blob GC (cron: /api/cron/blob-gc). Reads every reference in the
 * database and every object in the store, asks planBlobGc what may go, and
 * deletes it -- bytes first, then the row, the order the e2e teardown uses: a
 * missing object under a surviving row is visible to the sweeper; a deleted row
 * over a surviving object is a leak nothing can ever find again.
 *
 * The reference lists are read BEFORE the store is listed, so an object
 * uploaded mid-run is younger than the grace period and therefore kept.
 */
export async function runBlobGc({ dryRun }: { dryRun: boolean }): Promise<BlobGcResult> {
  const db = getDb();
  const now = new Date();
  const [rows, diskRefs, entRefs, histBlob, histImage, devRefs, sessionRefs, derived] = await Promise.all([
    db.select({ sha256: blobs.sha256, createdAt: blobs.createdAt }).from(blobs),
    db.selectDistinct({ s: disks.sha256 }).from(disks),
    db.selectDistinct({ s: entitlements.sha256 }).from(entitlements),
    db.selectDistinct({ s: diskVersions.blobSha256 }).from(diskVersions),
    db.selectDistinct({ s: diskVersions.imageSha256 }).from(diskVersions),
    db.select({ m: devices.mountedSha256, d: devices.desiredSha256, p: devices.preloadSha256 }).from(devices),
    db.selectDistinct({ s: diskWriteSessions.baseSha256 }).from(diskWriteSessions),
    db.selectDistinct({ s: blobs.derivedFromSha256 }).from(blobs),
  ]);
  const referenced = new Set<string>();
  for (const list of [diskRefs, entRefs, histBlob, histImage, sessionRefs, derived]) {
    for (const r of list) if (r.s) referenced.add(r.s);
  }
  for (const d of devRefs) for (const s of [d.m, d.d, d.p]) if (s) referenced.add(s);

  // Covers: a separate namespace (cover/), a separate reference (games), and a
  // separate plan, so a brake on one pass never stops the other. Referenced
  // digests are read before the listing, like the adf/ pass.
  const coverRefs = await db.selectDistinct({ s: games.coverOverrideSha256 })
    .from(games).where(isNotNull(games.coverOverrideSha256));

  const objects = await diskStore.listAll();
  const coverObjects = await coverStore.listAll();
  const plan = planBlobGc({ rows, objects, referenced, now, graceMs: BLOB_GC_GRACE_MS });
  const coverPlan = planCoverGc({
    objects: coverObjects, referenced: coverRefs.flatMap((r) => (r.s ? [r.s] : [])),
    now, graceMs: BLOB_GC_GRACE_MS,
  });
  const result: BlobGcResult = {
    dryRun, storedObjects: objects.length, rows: plan.rows.length, objects: plan.objects.length,
    failed: 0, refused: plan.refused,
    storedCovers: coverObjects.length, covers: coverPlan.objects.length, coversRefused: coverPlan.refused,
  };
  if (dryRun) return result;

  // Last look: a person may have re-chosen exactly these bytes since the
  // reference read. Re-select the planned digests and spare any now named.
  // If that look fails, delete no cover, and let the disk pass run as before.
  let coverDeletes = coverPlan.objects;
  if (coverDeletes.length > 0) {
    try {
      const named = await db.selectDistinct({ s: games.coverOverrideSha256 })
        .from(games).where(inArray(games.coverOverrideSha256, coverDeletes));
      coverDeletes = withoutReferenced(coverDeletes, named.flatMap((r) => (r.s ? [r.s] : [])));
    } catch {
      coverDeletes = [];
      result.coversRefused = 'the last reference re-check failed -- no cover deleted';
    }
  }
  let coversRemoved = 0;
  for (const sha256 of coverDeletes) {
    try { await coverStore.remove(sha256); coversRemoved++; } catch { result.failed++; }
  }
  result.covers = coversRemoved;
  if (plan.refused) return result;

  const stored = new Set(objects.map((o) => o.sha256));
  const rowsRemoved: string[] = [];
  for (const sha256 of plan.rows) {
    try {
      if (stored.has(sha256)) await diskStore.remove(sha256);
      rowsRemoved.push(sha256);
    } catch {
      result.failed++;
    }
  }
  for (let i = 0; i < rowsRemoved.length; i += 500) {
    await db.delete(blobs).where(inArray(blobs.sha256, rowsRemoved.slice(i, i + 500)));
  }
  let objectsRemoved = 0;
  for (const sha256 of plan.objects) {
    try { await diskStore.remove(sha256); objectsRemoved++; } catch { result.failed++; }
  }
  result.rows = rowsRemoved.length;
  result.objects = objectsRemoved;
  return result;
}
