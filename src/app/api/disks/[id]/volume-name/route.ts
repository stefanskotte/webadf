import { z } from 'zod';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks, blobs, entitlements } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { requireOrg } from '@/lib/session';
import { diskStore } from '@/lib/storage';
import { setVolumeName, MAX_VOLUME_NAME } from '@/lib/adffs/format';
import { readVolume } from '@/lib/adffs';
import { makeSortTitle } from '@/lib/tosec';

export const maxDuration = 60;

const body = z.object({ volumeName: z.string().trim().min(1).max(MAX_VOLUME_NAME) });

/**
 * Rename a disk's VOLUME -- the name an Amiga shows when it mounts it.
 *
 * THIS IS THE FIRST EDIT THAT REWRITES A DISK, and every consequence below
 * comes from `blobs` being content-addressed and immutable:
 *
 *  - New bytes mean a new sha-256, so a rename creates a NEW blob and
 *    repoints disks.sha256 at it. There is no in-place edit anywhere here.
 *  - disks.id never changes. That is the standing rule: readDesired joins on
 *    devices.desiredDiskId, and a re-keyed disk makes that join return
 *    nothing -- which in this protocol IS an eject.
 *  - The OLD blob is never deleted. Other tenants may still be entitled to
 *    those exact bytes; blob-gc.ts decides when it becomes reclaimable.
 *  - A device holding this disk polls on the SHA, so repointing really is a
 *    disk change to the hardware and the version bump below is deliberate,
 *    not incidental. Compare the write-protect backlog entry: same protocol
 *    question, opposite answer, because there the flag changed and the bytes
 *    did not.
 */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;

  let raw: unknown;
  try { raw = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = body.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
  }
  const volumeName = parsed.data.volumeName;

  const db = getDb();
  // THE ENTITLEMENT is the boundary, not disks.orgId -- that column is
  // independent and can drift. Identical to the pair /api/disks/[id]/adf and
  // the file browser use.
  const rows = await db
    .select({ sha256: disks.sha256, gameId: disks.gameId, diskNo: disks.diskNo })
    .from(disks)
    .innerJoin(entitlements, and(
      eq(entitlements.sha256, disks.sha256),
      eq(entitlements.orgId, orgId),
    ))
    .where(and(eq(disks.id, id), eq(disks.orgId, orgId)))
    .limit(1);

  const disk = rows[0];
  if (!disk) return Response.json({ error: 'not_found' }, { status: 404 });

  const before = await diskStore.read(disk.sha256);
  // A disk with no filesystem has no volume name to change. Renaming it would
  // mean writing a root block onto bytes that never had one, which is a
  // format, not a rename -- and would destroy whatever the disk really is.
  const volume = readVolume(before);
  if (!volume.ok) {
    return Response.json({ error: 'no_filesystem', detail: volume.reason }, { status: 409 });
  }

  const after = setVolumeName(before, volumeName);
  const sha256 = createHash('sha256').update(after).digest('hex');

  // Renaming to the name it already has: nothing to write, and writing anyway
  // would churn a blob for no change.
  if (sha256 === disk.sha256) {
    return Response.json({ id, sha256, volumeName, unchanged: true });
  }

  await diskStore.put(sha256, after);
  await db.insert(blobs).values({
    sha256, sizeBytes: after.length, storageKey: diskStore.storageKey(sha256),
  }).onConflictDoNothing();
  // The entitlement is what lets this org read the new bytes at all.
  await db.insert(entitlements).values({
    orgId, sha256, sourceFilename: `${volumeName}.adf`,
  }).onConflictDoNothing();

  await db.update(disks)
    .set({ sha256, tosecName: `${volumeName}.adf` })
    .where(and(eq(disks.id, id), eq(disks.orgId, orgId)));

  // The catalog title follows the volume name for a disk somebody made: the
  // two are the same thing to the person who typed it. sortTitle comes along
  // because it is NOT NULL, orders games_org_sort_idx and is half the key
  // mergeDuplicates collapses on.
  await db.update(games)
    .set({ title: volumeName, sortTitle: makeSortTitle(volumeName), metadataSource: 'human' })
    .where(and(eq(games.id, disk.gameId), eq(games.orgId, orgId)));

  // Any board that wants or holds these old bytes is now looking at a disk
  // that no longer exists under that digest. Point it at the new one and bump
  // the version, which is what the long poll is gated on -- without this the
  // board sits in its 25 s poll and never learns.
  // DESIRED only, not mounted. A device whose MOUNTED sha is the old one but
  // whose desired sha is something else has already been told to change to a
  // different disk; overwriting its desire here would silently redirect it to
  // this one instead. readDesired reports devices.desiredSha256, and
  // desiredDiskId is untouched because disks.id never changes -- so the join
  // that resolves the label and the write-protect flag still lands.
  const holders = await db.select({ id: devices.id, version: devices.desiredVersion })
    .from(devices)
    .where(and(
      eq(devices.orgId, orgId),
      eq(devices.desiredSha256, disk.sha256),
    ));
  for (const d of holders) {
    await db.update(devices)
      .set({ desiredSha256: sha256, desiredVersion: (d.version ?? 0) + 1 })
      .where(and(eq(devices.id, d.id), eq(devices.orgId, orgId)));
  }

  return Response.json({ id, sha256, volumeName, devicesRepointed: holders.length });
}
