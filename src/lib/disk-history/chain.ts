import { applyDelta, decodeDelta, shouldSnapshot } from './delta';
import { ADF_BYTES } from '@/lib/adfmfm';

/**
 * A disk's history as a chain of versions, and how to get back to any of them.
 *
 * Every version is either a SNAPSHOT (a complete image) or a DELTA against the
 * one before it. Rewinding to version k means taking the nearest snapshot at or
 * before k and applying the deltas after it -- the same arrangement video uses
 * keyframes for, and for the same reason: a history made only of deltas gets
 * slower to read without bound, and the disk people most want to rewind is the
 * one that has been written to most.
 *
 * Version 0 is always a snapshot: the image as uploaded. It is the existing
 * blob, so a disk with no writes costs this system nothing at all.
 *
 * Pure, and storage-agnostic. Reading a blob is injected, so the whole of this
 * is testable without a database or a blob store -- and the rules that decide
 * what a rewind reads are the part worth testing.
 */

export type VersionKind = 'snapshot' | 'delta';

export interface VersionEntry {
  /** 0 for the uploaded image, then one per write, contiguous and ascending. */
  seq: number;
  kind: VersionKind;
  /** The blob to read: a full image for a snapshot, an encoded delta for a
   *  delta. */
  blobSha256: string;
  /** Digest of the COMPLETE image at this version.
   *
   *  Recorded rather than derived, so that any point in history is addressable
   *  by exactly the same digest the mount path already takes -- rewinding to
   *  version 7 and mounting it is then the ordinary mount, not a special case.
   *  It also makes two versions that happen to hold the same disk share a blob
   *  for free. */
  imageSha256: string;
}

export class HistoryError extends Error {
  constructor(message: string) { super(message); this.name = 'HistoryError'; }
}

/**
 * How many deltas may follow a snapshot.
 *
 * Bounds the read cost of a rewind: at most this many blob reads plus one.
 * 64 deltas of a typical write is well under a megabyte, so a snapshot every
 * 64 writes roughly doubles what a much-written disk costs to store while
 * keeping any rewind to a fixed, small number of reads.
 */
export const MAX_CHAIN_DEPTH = 64;

/** What the next version should be, given the write about to be recorded. */
export function nextKind(changedSectors: number, deltasSinceSnapshot: number): VersionKind {
  // Either reason is sufficient: a delta that no longer saves space, or a
  // chain that has grown long enough to make rewinding slow.
  if (shouldSnapshot(changedSectors)) return 'snapshot';
  if (deltasSinceSnapshot >= MAX_CHAIN_DEPTH) return 'snapshot';
  return 'delta';
}

/**
 * The entries that must be read to reconstruct `seq`, in the order they apply:
 * a snapshot first, then each delta after it.
 */
export function replayPlan(entries: readonly VersionEntry[], seq: number): VersionEntry[] {
  if (entries.length === 0) throw new HistoryError('this disk has no history');

  let at = -1;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].seq === seq) { at = i; break; }
  }
  if (at < 0) throw new HistoryError(`no version ${seq}`);

  let from = at;
  while (from >= 0 && entries[from].kind !== 'snapshot') from--;
  if (from < 0) {
    // Not merely "not found": a chain whose root is a delta cannot be
    // reconstructed at all, and saying so is better than returning an image
    // built from the wrong starting point.
    throw new HistoryError(`version ${seq} has no snapshot to replay from`);
  }

  const plan = entries.slice(from, at + 1);
  // Contiguity is what makes "apply these in order" correct. A gap means a
  // version was deleted from the middle, which silently changes what every
  // later version reconstructs to.
  for (let i = 1; i < plan.length; i++) {
    if (plan[i].seq !== plan[i - 1].seq + 1) {
      throw new HistoryError(`history is not contiguous between ${plan[i - 1].seq} and ${plan[i].seq}`);
    }
  }
  return plan;
}

export type BlobReader = (sha256: string) => Promise<Uint8Array>;

/** Reconstruct the complete image at `seq`. */
export async function materialise(
  entries: readonly VersionEntry[], seq: number, read: BlobReader,
): Promise<Uint8Array> {
  const plan = replayPlan(entries, seq);
  const [first, ...rest] = plan;

  let image = await read(first.blobSha256);
  if (image.length !== ADF_BYTES) {
    throw new HistoryError(`snapshot ${first.seq} is ${image.length} bytes, not a disk image`);
  }
  for (const entry of rest) {
    image = applyDelta(image, decodeDelta(await read(entry.blobSha256)));
  }
  return image;
}

/** Deltas recorded since the most recent snapshot, for nextKind(). */
export function deltasSinceSnapshot(entries: readonly VersionEntry[]): number {
  let n = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].kind === 'snapshot') return n;
    n++;
  }
  return n;
}
