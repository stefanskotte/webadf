import { and, eq, or, sql } from 'drizzle-orm';
import type { getDb } from '@/db';
import { devices } from '@/db/schema/devices';

/**
 * The device in `orgId` that holds the disk whose bytes are `sha256`, or null.
 *
 * THE RULE (operator, 2026-09-18): "if a volume is mounted, it cannot be
 * modified by the server. If modifications should happen, these must come
 * from the (mounted) Amiga side of things." Every server path that rewrites a
 * disk's BYTES asks this first and refuses when it answers a device: content
 * edits (applyDiskEdit), the volume rename, and the pages that offer both, so
 * the controls can say so up front. It covers the bytes only -- the
 * write-protect flag is a setting and still applies live, and title/metadata
 * edits never touch the disk.
 *
 * D-W-4: checked against EITHER side of a device's state, because a board
 * polling toward a new disk (desiredSha256) is just as much "somewhere this
 * edit would land on hardware" as one that has already converged
 * (mountedSha256). The name comes back so the refusal can say exactly where
 * to eject from, rather than only that something, somewhere, refused.
 */
export async function findHolder(
  db: ReturnType<typeof getDb>,
  orgId: string,
  sha256: string,
): Promise<{ name: string } | null> {
  const rows = await db
    .select({ name: devices.name })
    .from(devices)
    .where(and(
      eq(devices.orgId, orgId),
      or(eq(devices.mountedSha256, sha256), eq(devices.desiredSha256, sha256)),
    ))
    .limit(1);
  return rows[0] ?? null;
}

export { mountedReason } from '@/lib/mount-wording';

/**
 * Run right after a browser edit or rename RECORDED a new head for `diskId`:
 * any device in `orgId` that desires this disk but still wants `oldSha` is
 * pointed at `newSha` and bumped (desiredVersion + 1, atomically -- the same
 * shape closeSession uses for other boards), so it re-downloads.
 *
 *  - It only completes a mount that began AFTER the refusal check. Between
 *    findHolder and recordVersion's commit a human can mount the disk;
 *    setDesired then copies the OLD sha into desiredSha256, the head moves on
 *    without that board, and from then on findHolder(head) finds nobody --
 *    the lock would be off while that board holds the disk, and its next
 *    close could silently revert the edit.
 *  - The operator's rule still holds: no board that was holding the disk at
 *    check time is ever touched here, because every one of those was refused
 *    before anything was written. This moves only a board that asked for
 *    the disk mid-edit, and moves it to the disk's own head.
 *  - It restores the invariant that every device desiring disk D wants D's
 *    head.
 *
 * Scoped on desiredSha256 = oldSha, so a board already pointed elsewhere, or
 * already at the new head, is left alone.
 */
export async function repointLateMounts(
  db: ReturnType<typeof getDb>,
  orgId: string,
  diskId: string,
  oldSha: string,
  newSha: string,
): Promise<void> {
  await db.update(devices)
    .set({ desiredSha256: newSha, desiredVersion: sql`${devices.desiredVersion} + 1` })
    .where(and(
      eq(devices.orgId, orgId),
      eq(devices.desiredDiskId, diskId),
      eq(devices.desiredSha256, oldSha),
    ));
}
