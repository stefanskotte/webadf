// The one place every disk-editing route goes through: load, apply, hash,
// store, repoint. Three routes (add/make-dir, rename/replace, delete) each
// bring their own pure `WriteResult`-returning closure over
// src/lib/adffs/write.ts and call this; nothing else here differs between
// them, so nothing here can drift between them either.
//
// Modeled directly on src/app/api/disks/[id]/volume-name/route.ts, the first
// (and until now, only) code path that rewrites a disk's bytes. The
// invariants are the same ones documented there:
//
//  - New bytes mean a new sha-256: a new blob, and disks.sha256 repointed at
//    it. There is no in-place edit.
//  - disks.id NEVER changes. readDesired joins on devices.desiredDiskId, and
//    a re-keyed disk makes that join return nothing -- which in this
//    protocol IS an eject.
//  - The OLD blob is NEVER deleted (spec §7). Blobs are content-addressed and
//    global; other tenants may still be entitled to those exact bytes.
//
// D-W-4: a disk any device has mounted or desires is refused outright,
// before anything is read or written. The operator ejects the device first;
// there is no server-side "eject and proceed". The volume rename follows the
// same rule (operator decision 2026-09-18) through the same findHolder.

import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks, entitlements } from '@/db/schema/catalog';
import { findHolder, mountedReason, repointLateMounts } from '@/lib/disk-holder';
import { diskStore } from '@/lib/storage';
import { recordVersion, StaleHeadError, type Recorded } from '@/lib/disk-history/store';
import type { WriteResult } from '@/lib/adffs';

export type DiskEditOutcome =
  | { ok: true; sha256: string }
  | { ok: false; status: number; reason: string };

/**
 * Load `diskId` (scoped to `orgId`), apply `edit` to its bytes, and -- on
 * success -- store the result as a new blob and repoint the disk row at it.
 *
 * `edit` is a pure function over the CURRENT bytes: it gets whatever
 * `diskStore` holds right now and returns a `WriteResult`, exactly the shape
 * every function in src/lib/adffs/write.ts already returns. That means a
 * caller who needs to resolve something from the disk's own tree first (a
 * rename or delete needs the entry's parent block, found by walking the
 * freshly-loaded bytes) can do that walk inside the closure, against the
 * same bytes this function is about to hash and store -- never a second,
 * possibly-stale read.
 */
export async function applyDiskEdit(
  orgId: string,
  diskId: string,
  edit: (adf: Uint8Array) => WriteResult,
  userId: string | null = null,
): Promise<DiskEditOutcome> {
  const db = getDb();

  // THE ENTITLEMENT is the boundary, not disks.orgId -- identical to the pair
  // /api/disks/[id]/adf, the file browser and volume-name all use. A disk
  // outside this org's entitlements answers exactly like one that does not
  // exist: 404, never 403, so the response cannot confirm the id is real.
  const rows = await db
    .select({
      sha256: disks.sha256,
      tosecName: disks.tosecName,
      sourceFilename: entitlements.sourceFilename,
    })
    .from(disks)
    .innerJoin(entitlements, and(
      eq(entitlements.sha256, disks.sha256),
      eq(entitlements.orgId, orgId),
    ))
    .where(and(eq(disks.id, diskId), eq(disks.orgId, orgId)))
    .limit(1);

  const disk = rows[0];
  if (!disk) return { ok: false, status: 404, reason: 'not_found' };

  // D-W-4: refuse before anything is read or written. The holder lookup and
  // the rule behind it live in findHolder (src/lib/disk-holder.ts), shared
  // with the volume rename and the pages that offer both.
  const holder = await findHolder(db, orgId, disk.sha256);
  if (holder) {
    return { ok: false, status: 409, reason: mountedReason(holder.name) };
  }

  let before: Uint8Array;
  try {
    before = await diskStore.read(disk.sha256);
  } catch {
    return { ok: false, status: 503, reason: 'blob_unavailable' };
  }

  const result = edit(before);
  if (!result.ok) {
    return { ok: false, status: 400, reason: result.reason };
  }
  const after = result.adf;

  let recorded: Recorded | null;
  try {
    recorded = await recordVersion({
      orgId, diskId, headSha: disk.sha256, head: before, next: after,
      source: 'browser', userId,
      sourceFilename: disk.tosecName ?? disk.sourceFilename ?? `${diskId}.adf`,
    });
  } catch (err) {
    // Another write landed between this read and this record: refused like
    // the mounted case, with nothing recorded.
    if (err instanceof StaleHeadError) return { ok: false, status: 409, reason: 'conflict' };
    throw err;
  }
  // An edit that changes nothing (writing a file's own bytes back) is a no-op.
  const sha256 = recorded?.sha256 ?? disk.sha256;

  // A board that asked for this disk AFTER the refusal check above wants the
  // old bytes now; point it at the new head (repointLateMounts says why this
  // does not break the mounted-disk rule). Nothing to do when nothing moved.
  if (recorded) await repointLateMounts(db, orgId, diskId, disk.sha256, recorded.sha256);

  // THE OLD BLOB (disk.sha256) IS NEVER DELETED, and there is deliberately no
  // call to diskStore.remove or a `blobs`/`entitlements` delete anywhere in
  // this function. blob-gc.ts, not this path, decides when bytes become
  // reclaimable.
  //
  // Every device that wanted or held these bytes at check time was refused
  // above; the only repoint is repointLateMounts' completion of a mount that
  // began after it.

  return { ok: true, sha256 };
}
