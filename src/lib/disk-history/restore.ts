// Restore: put an earlier version back as a disk's CURRENT image, recorded
// as a NEW version (write-back spec D2: "a rewind ADDS a version; history
// only grows" -- no version is ever overwritten or deleted), and refused
// while a board holds the disk (spec §4).
//
// Follows applyDiskEdit's shape exactly (src/lib/disk-write.ts), because the
// rules are the same ones -- only the source of the new bytes differs: a
// pure edit closure over the CURRENT bytes there, a materialised EARLIER
// version here.

import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks, entitlements } from '@/db/schema/catalog';
import { findHolder, mountedReason, repointLateMounts } from '@/lib/disk-holder';
import { diskStore } from '@/lib/storage';
import { materialise, HistoryError } from '@/lib/disk-history/chain';
import { DeltaError } from '@/lib/disk-history/delta';
import { loadEntries, recordVersion, StaleHeadError, type Recorded } from '@/lib/disk-history/store';

export type RestoreOutcome =
  /** `recorded` false means the target's bytes already WERE the head: nothing recorded, nothing wrong. */
  | { ok: true; sha256: string; seq: number; recorded: boolean }
  | { ok: false; status: number; reason: string };

/**
 * Restore `diskId` (scoped to `orgId`) to the image it held at version `seq`.
 *
 * This is not an in-place rewind: `seq`'s image is recorded as a brand-new
 * version ON TOP of the CURRENT head, with `source: 'rewind'` and
 * `rewindOf: seq`, so every version between the target and the head is still
 * there afterwards -- D2. Restoring the head itself, or a version whose
 * image already equals the head, changes nothing: `recordVersion` already
 * answers null for a no-op (identical bytes), and that is honoured here as
 * "ok, nothing moved" rather than turned into a version that never really
 * happened.
 */
export async function restoreVersion(
  orgId: string, diskId: string, seq: number, userId: string | null = null,
): Promise<RestoreOutcome> {
  const db = getDb();

  // THE ENTITLEMENT is the boundary, not disks.orgId -- identical to
  // applyDiskEdit, the volume rename and every other route that touches a
  // disk's bytes. A disk outside this org's entitlements answers exactly
  // like one that does not exist: 404, never 403.
  const rows = await db
    .select({
      sha256: disks.sha256,
      tosecName: disks.tosecName,
      sourceFilename: entitlements.sourceFilename,
      imageFormat: disks.imageFormat,
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

  // Spec D2: an HFE is a preserved original. Refused before the holder
  // check and before any read -- nothing about it can be edited, mounted or not.
  if (disk.imageFormat === 'hfe') return { ok: false, status: 409, reason: 'hfe_read_only' };

  // D-W-4: refuse before anything is read or written -- the same findHolder
  // applyDiskEdit and the volume rename use, and the same reason string.
  const holder = await findHolder(db, orgId, disk.sha256);
  if (holder) {
    return { ok: false, status: 409, reason: mountedReason(holder.name) };
  }

  // Resolve the target version's complete image. An unknown seq is a 404,
  // not a 500: it means the caller asked for a version this disk never had
  // (or no longer has metadata for), same family as "unknown disk".
  const entries = await loadEntries(diskId);
  if (!entries.some((e) => e.seq === seq)) {
    return { ok: false, status: 404, reason: 'not_found' };
  }

  let target: Uint8Array;
  try {
    target = await materialise(entries, seq, (sha256) => diskStore.read(sha256));
  } catch (err) {
    if (err instanceof HistoryError || err instanceof DeltaError) {
      // A broken chain (a gap, a missing snapshot) or a corrupt delta
      // payload (one that fails to decode or apply) is a server-side fault,
      // logged for investigation -- never silently answered as if nothing
      // changed.
      console.error(`restoreVersion: broken chain for disk ${diskId} at seq ${seq}: ${err.message}`);
      return { ok: false, status: 500, reason: 'broken_history' };
    }
    // Anything else here is `diskStore.read` failing outright (a missing or
    // unreachable blob, not a corrupt one) while replaying the chain -- the
    // same failure mode as the head-blob read just below, answered the same
    // way rather than propagating as an unhandled 500.
    return { ok: false, status: 503, reason: 'blob_unavailable' };
  }

  let before: Uint8Array;
  try {
    before = await diskStore.read(disk.sha256);
  } catch {
    return { ok: false, status: 503, reason: 'blob_unavailable' };
  }

  const currentSeq = entries[entries.length - 1].seq;

  // THE HOLDER CHECK ABOVE RAN BEFORE `materialise`, which is up to 65
  // sequential blob reads -- two orders of magnitude longer than the single
  // read applyDiskEdit does between its own check and its record. That window
  // is wide enough for a board to be mounted, converge, and open a write
  // session inside it, and `closeSession` deliberately lets an ALREADY OPEN
  // session outlive a version bump (device-write.ts: only a new session is
  // refused as 'behind'). `repointLateMounts` below therefore would not stop
  // it: the Amiga's save would land on top of this rewind, while the person
  // who clicked Restore was told it succeeded. One more query closes the
  // window to applyDiskEdit's size. Deliberately NOT solved by moving
  // `materialise` after the check -- that would read a disk's bytes before
  // refusing, against D-W-4.
  const late = await findHolder(db, orgId, disk.sha256);
  if (late) return { ok: false, status: 409, reason: mountedReason(late.name) };

  let recorded: Recorded | null;
  try {
    recorded = await recordVersion({
      orgId, diskId, headSha: disk.sha256, head: before, next: target,
      source: 'rewind', rewindOf: seq, userId,
      sourceFilename: disk.tosecName ?? disk.sourceFilename ?? `${diskId}.adf`,
    });
  } catch (err) {
    // The disk changed since it was read: nothing recorded.
    if (err instanceof StaleHeadError) return { ok: false, status: 409, reason: 'conflict' };
    throw err;
  }

  // Restoring the head, or a version whose bytes already equal it: nothing
  // to record, and NOT turned into a fake new version (see the doc comment
  // above) -- answer with the CURRENT sha and seq, unchanged.
  if (!recorded) return { ok: true, sha256: disk.sha256, seq: currentSeq, recorded: false };

  // A board that asked for this disk between the holder check above and this
  // commit wants the OLD bytes now; point it at the new head.
  await repointLateMounts(db, orgId, diskId, disk.sha256, recorded.sha256);

  return { ok: true, sha256: recorded.sha256, seq: recorded.seq, recorded: true };
}
