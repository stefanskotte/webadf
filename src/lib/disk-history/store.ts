import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { getDb } from '@/db';
import { blobs, disks, entitlements } from '@/db/schema/catalog';
import { diskVersions } from '@/db/schema/disk-history';
import { diskStore } from '@/lib/storage';
import type { VersionEntry, VersionKind } from './chain';
import { planNextVersion } from './version';

/**
 * The ONLY writer of a disk's new image (write-back spec §3.4). Browser
 * edits, renames, device write sessions and restores all come through here,
 * so every change to a disk's bytes lands in its history the same way.
 */

export type VersionSource = 'amiga' | 'browser' | 'rewind';

export interface RecordInput {
  orgId: string;
  diskId: string;
  /** The digest the disk points at now, and its bytes. */
  headSha: string;
  head: Uint8Array;
  next: Uint8Array;
  source: VersionSource;
  deviceId?: string | null;
  userId?: string | null;
  rewindOf?: number | null;
  /** Carried onto the new image's entitlement row. */
  sourceFilename: string;
}

export interface Recorded { sha256: string; seq: number; kind: VersionKind; sectorCount: number }

const sha256Of = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/**
 * The disk moved on under this write: the head the caller read is no longer
 * the head its history ends at, or another write took this seq first.
 * Recording anyway would store a delta against the wrong base, and
 * materialise() would replay it onto bytes it was never computed from.
 * Callers answer 409 { error: 'conflict' }; nothing has been recorded.
 */
export class StaleHeadError extends Error {
  constructor(message = 'the disk changed since it was read') {
    super(message);
    this.name = 'StaleHeadError';
  }
}

const SEQ_CONSTRAINT = 'disk_versions_disk_seq';

/** A unique violation on (disk_id, seq). neon-http's batch throws the raw
 *  NeonDbError (code, constraint); a drizzle-wrapped one carries it as cause. */
function isSeqCollision(err: unknown): boolean {
  for (const e of [err, (err as { cause?: unknown } | null)?.cause]) {
    if (e && typeof e === 'object'
      && (e as { code?: unknown }).code === '23505'
      && (e as { constraint?: unknown }).constraint === SEQ_CONSTRAINT) return true;
  }
  return false;
}

export async function loadEntries(diskId: string): Promise<VersionEntry[]> {
  const rows = await getDb()
    .select({
      seq: diskVersions.seq, kind: diskVersions.kind,
      blobSha256: diskVersions.blobSha256, imageSha256: diskVersions.imageSha256,
    })
    .from(diskVersions)
    .where(eq(diskVersions.diskId, diskId))
    .orderBy(asc(diskVersions.seq));
  return rows.map((r) => ({ ...r, kind: r.kind as VersionKind }));
}

/**
 * Store `next` as the disk's new image and record it as the next version.
 * Null when `next` equals `head`: nothing is written at all.
 *
 * Blob bytes are PUT first, then every row in one db.batch. A PUT whose rows
 * never land leaves an unreferenced object (reclaimable); rows whose bytes
 * never landed would name a disk nobody can read.
 */
export async function recordVersion(input: RecordInput): Promise<Recorded | null> {
  const db = getDb();
  const entries = await loadEntries(input.diskId);
  // The caller's head must be the version history ends at, or `next` was
  // computed from bytes that are no longer the disk. Checked before any PUT.
  if (entries.length && entries[entries.length - 1].imageSha256 !== input.headSha) {
    throw new StaleHeadError();
  }

  // Version 0 is the image when history began: created lazily at the first
  // change, so a disk never written costs nothing (chain.ts).
  const history: VersionEntry[] = entries.length
    ? entries
    : [{ seq: 0, kind: 'snapshot', blobSha256: input.headSha, imageSha256: input.headSha }];

  const plan = planNextVersion(history, input.head, input.next);
  if (!plan) return null;

  const sha256 = sha256Of(input.next);
  const seq = history[history.length - 1].seq + 1;

  // A delta is not a disk image: stored, but never a `blobs` row, which is
  // the table the scanners walk as disks. The two PUTs are independent, so
  // they run together.
  const blobSha256 = plan.deltaBlob ? sha256Of(plan.deltaBlob) : sha256;
  await Promise.all([
    diskStore.put(sha256, input.next),
    ...(plan.deltaBlob ? [diskStore.put(blobSha256, plan.deltaBlob)] : []),
  ]);

  const stmts: BatchItem<'pg'>[] = [];
  stmts.push(db.insert(blobs).values({
    sha256, sizeBytes: input.next.length, storageKey: diskStore.storageKey(sha256),
  }).onConflictDoNothing());
  // The entitlement is what lets this org read the new bytes at all, and what
  // keeps the e2e teardown's GC from reclaiming a snapshot history needs.
  stmts.push(db.insert(entitlements).values({
    orgId: input.orgId, sha256, sourceFilename: input.sourceFilename,
  }).onConflictDoNothing());
  if (!entries.length) {
    stmts.push(db.insert(diskVersions).values({
      id: randomUUID(), diskId: input.diskId, orgId: input.orgId, seq: 0,
      kind: 'snapshot', blobSha256: input.headSha, imageSha256: input.headSha,
      source: 'original', sectorCount: 0,
    }));
  }
  stmts.push(db.insert(diskVersions).values({
    id: randomUUID(), diskId: input.diskId, orgId: input.orgId, seq,
    kind: plan.kind, blobSha256, imageSha256: sha256, source: input.source,
    deviceId: input.deviceId ?? null, userId: input.userId ?? null,
    rewindOf: input.rewindOf ?? null, sectorCount: plan.sectorCount,
  }));
  // disks.id is NEVER part of this SET -- only sha256 moves.
  stmts.push(db.update(disks).set({ sha256 })
    .where(and(eq(disks.id, input.diskId), eq(disks.orgId, input.orgId))));

  try {
    await db.batch(stmts as [BatchItem<'pg'>, ...BatchItem<'pg'>[]]);
  } catch (err) {
    // Two writes that read the same history both claimed this seq; the batch
    // is atomic, so the loser recorded nothing.
    if (isSeqCollision(err)) throw new StaleHeadError();
    throw err;
  }
  return { sha256, seq, kind: plan.kind, sectorCount: plan.sectorCount };
}
