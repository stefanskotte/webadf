import { z } from 'zod';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks, entitlements } from '@/db/schema/catalog';
import { findHolder, mountedReason } from '@/lib/disk-holder';
import { requireOrg } from '@/lib/session';
import { diskStore } from '@/lib/storage';
import { setVolumeName, MAX_VOLUME_NAME } from '@/lib/adffs/format';
import { readVolume } from '@/lib/adffs';
import { makeSortTitle } from '@/lib/tosec';
import { recordVersion, StaleHeadError } from '@/lib/disk-history/store';

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
 *  - A disk a board holds is REFUSED, never renamed and then pushed to the
 *    board (operator decision 2026-09-18): "if a volume is mounted, it cannot
 *    be modified by the server. If modifications should happen, these must
 *    come from the (mounted) Amiga side of things." Same rule, same
 *    findHolder and same reason string as applyDiskEdit's D-W-4, so no device
 *    ever wants or holds the bytes this replaces and none is repointed. The
 *    write-protect flag is different: a setting, not the bytes, so it still
 *    applies live.
 */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId, userId } = await requireOrg();
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

  // Before the bytes are even read: a board that holds (or is polling toward)
  // this disk owns it until it is ejected there.
  const holder = await findHolder(db, orgId, disk.sha256);
  if (holder) {
    return Response.json({ error: 'mounted', reason: mountedReason(holder) }, { status: 409 });
  }

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

  // The history store stores the new image (blob + entitlement), records it
  // as the disk's next version and repoints disks.sha256, all in one batch.
  try {
    await recordVersion({
      orgId, diskId: id, headSha: disk.sha256, head: before, next: after,
      source: 'browser', userId, sourceFilename: `${volumeName}.adf`,
    });
  } catch (err) {
    // The disk changed since it was read: nothing recorded, and nothing
    // below (name, title) may run for a rename that did not land.
    if (err instanceof StaleHeadError) return Response.json({ error: 'conflict' }, { status: 409 });
    throw err;
  }
  await db.update(disks)
    .set({ tosecName: `${volumeName}.adf` })
    .where(and(eq(disks.id, id), eq(disks.orgId, orgId)));

  // The catalog title follows the volume name for a disk somebody made: the
  // two are the same thing to the person who typed it. sortTitle comes along
  // because it is NOT NULL, orders games_org_sort_idx and is half the key
  // mergeDuplicates collapses on.
  await db.update(games)
    .set({ title: volumeName, sortTitle: makeSortTitle(volumeName), metadataSource: 'human' })
    .where(and(eq(games.id, disk.gameId), eq(games.orgId, orgId)));

  return Response.json({ id, sha256, volumeName });
}
