import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { firmwareReleases } from '@/db/schema/firmware';
import type { ReleaseRef } from '@/lib/firmware-state';
import { decidePublish, PublishRefused, type ExistingRelease } from '@/lib/firmware-publish-rules';

export interface PublishInput {
  version: string;
  semver: string;
  sha256: string;
  sizeBytes: number;
  blobPath: string;
  signature: string;
  signingKeyId: string;
  notes: string | null;
  security: boolean;
  signatureFormat: number;
}

/** What decidePublish needs, and nothing else. */
export async function readExistingReleases(): Promise<ExistingRelease[]> {
  return getDb()
    .select({
      version: firmwareReleases.version,
      semver: firmwareReleases.semver,
      sequence: firmwareReleases.sequence,
    })
    .from(firmwareReleases);
}

/**
 * Records a published release.
 *
 * The rules live in firmware-publish-rules.ts and are unit-tested there; this
 * function is the database half only. `sequence` is computed from the rows
 * this call read, never supplied by the caller -- a client that could choose
 * its own sequence could insert itself anywhere in the history, including
 * ahead of a release every board has already taken.
 *
 * The unique constraints on `version` and `sequence` are the backstop: two
 * publishes racing would both read the same maximum and compute the same next
 * sequence, and the second insert is refused by the database rather than
 * quietly producing two releases that claim the same position.
 */
export async function publishRelease(
  input: PublishInput,
  userId: string,
  expectedSequence: number,
): Promise<{ id: string; sequence: number }> {
  const db = getDb();
  const existing = await readExistingReleases();
  const sequence = decidePublish(existing, input);
  if (sequence !== expectedSequence) {
    // The signature covers the sequence (spec D4). A sequence that moved between
    // signing and recording would publish a signature that never verifies.
    throw new PublishRefused(`sequence moved from ${expectedSequence} to ${sequence} while publishing; re-run`);
  }
  const id = randomUUID();
  await db.insert(firmwareReleases).values({ ...input, id, sequence, publishedByUserId: userId });
  return { id, sequence };
}

/**
 * Just enough for firmwareState(), newest first.
 *
 * `notes` is included so the Devices notice can say what a release changes.
 * Without it the notes were reachable only from /admin/firmware, which
 * redirects every non-admin -- making `--notes` write-only for exactly the
 * audience it exists for.
 */
export async function listReleases(): Promise<ReleaseRef[]> {
  return getDb()
    .select({
      version: firmwareReleases.version,
      sequence: firmwareReleases.sequence,
      semver: firmwareReleases.semver,
      security: firmwareReleases.security,
      notes: firmwareReleases.notes,
      signatureFormat: firmwareReleases.signatureFormat,
    })
    .from(firmwareReleases)
    .orderBy(desc(firmwareReleases.sequence));
}

export interface FirmwareReleaseListItem {
  id: string;
  version: string;
  sequence: number;
  sizeBytes: number;
  signingKeyId: string;
  notes: string | null;
  security: boolean;
  publishedAt: Date;
  publishedByEmail: string | null;
}

/**
 * For /admin/firmware. Newest first, and only the columns the page renders --
 * sha256, blobPath and the base64 signature are ~180 bytes a row that it
 * never shows.
 */
export async function listReleasesFull(limit = 100): Promise<FirmwareReleaseListItem[]> {
  const { user } = await import('@/db/schema/auth');
  const { eq } = await import('drizzle-orm');
  return getDb()
    .select({
      id: firmwareReleases.id,
      version: firmwareReleases.version,
      sequence: firmwareReleases.sequence,
      sizeBytes: firmwareReleases.sizeBytes,
      signingKeyId: firmwareReleases.signingKeyId,
      notes: firmwareReleases.notes,
      security: firmwareReleases.security,
      publishedAt: firmwareReleases.publishedAt,
      // Resolved to an address: the column holds an id, and "who shipped
      // this" is unanswerable from one without a join.
      publishedByEmail: user.email,
    })
    .from(firmwareReleases)
    .leftJoin(user, eq(user.id, firmwareReleases.publishedByUserId))
    .orderBy(desc(firmwareReleases.sequence))
    .limit(limit);
}

/**
 * The newest release's sequence, or 0 when nothing is published.
 *
 * One row via the sequence index, because the live-state poll runs every few
 * seconds per open browser and only needs to know whether the registry moved.
 */
export async function latestReleaseSequence(): Promise<number> {
  const rows = await getDb()
    .select({ sequence: firmwareReleases.sequence })
    .from(firmwareReleases)
    .orderBy(desc(firmwareReleases.sequence))
    .limit(1);
  return rows[0]?.sequence ?? 0;
}
