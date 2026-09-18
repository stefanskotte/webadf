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
// D-W-4 is the one place this path DIFFERS from volume-name: a disk any
// device has mounted or desires is refused outright, before anything is
// read or written, rather than being written and then propagated to
// holders. That is deliberate -- it keeps this increment free of any
// protocol question, on hardware that has never run a write. The operator
// ejects the device first; there is no server-side "eject and proceed".

import { and, eq, or } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks, entitlements } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { diskStore } from '@/lib/storage';
import { recordVersion } from '@/lib/disk-history/store';
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

  // D-W-4: refuse before anything is read or written -- checked against
  // EITHER side of a device's state, because a board polling toward a new
  // disk (desiredSha256) is just as much "somewhere this edit would land on
  // hardware" as one that has already converged (mountedSha256). Named in
  // the reason so the operator knows exactly where to eject from, rather
  // than being told only that something, somewhere, refused.
  const holders = await db
    .select({ name: devices.name })
    .from(devices)
    .where(and(
      eq(devices.orgId, orgId),
      or(eq(devices.mountedSha256, disk.sha256), eq(devices.desiredSha256, disk.sha256)),
    ))
    .limit(1);

  const holder = holders[0];
  if (holder) {
    return { ok: false, status: 409, reason: `mounted on "${holder.name}"` };
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

  const recorded = await recordVersion({
    orgId, diskId, headSha: disk.sha256, head: before, next: after,
    source: 'browser', userId,
    sourceFilename: disk.tosecName ?? disk.sourceFilename ?? `${diskId}.adf`,
  });
  // An edit that changes nothing (writing a file's own bytes back) is a no-op.
  const sha256 = recorded?.sha256 ?? disk.sha256;

  // THE OLD BLOB (disk.sha256) IS NEVER DELETED, and there is deliberately no
  // call to diskStore.remove or a `blobs`/`entitlements` delete anywhere in
  // this function. blob-gc.ts, not this path, decides when bytes become
  // reclaimable.
  //
  // No device is repointed either -- unlike volume-name's holder loop.
  // There cannot be one: any device that wanted or held these bytes was
  // already refused above, before this line could ever be reached.

  return { ok: true, sha256 };
}
