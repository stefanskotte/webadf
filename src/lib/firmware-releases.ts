import { randomUUID } from 'node:crypto';
import { desc } from 'drizzle-orm';
import { getDb } from '@/db';
import { firmwareReleases } from '@/db/schema/firmware';
import type { ReleaseRef } from '@/lib/firmware-state';
import { decidePublish, PublishRefused, type ExistingRelease } from '@/lib/firmware-publish-rules';

export { PublishRefused } from '@/lib/firmware-publish-rules';
export type { PublishRefusalReason } from '@/lib/firmware-publish-rules';

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
): Promise<{ id: string; sequence: number }> {
  const db = getDb();
  const existing: ExistingRelease[] = await db
    .select({
      version: firmwareReleases.version,
      semver: firmwareReleases.semver,
      sequence: firmwareReleases.sequence,
    })
    .from(firmwareReleases);

  const sequence = decidePublish(existing, input);
  const id = randomUUID();
  await db.insert(firmwareReleases).values({ ...input, id, sequence, publishedByUserId: userId });
  return { id, sequence };
}

/** Just enough for firmwareState(), newest first. */
export async function listReleases(): Promise<ReleaseRef[]> {
  return getDb()
    .select({
      version: firmwareReleases.version,
      sequence: firmwareReleases.sequence,
      semver: firmwareReleases.semver,
      security: firmwareReleases.security,
    })
    .from(firmwareReleases)
    .orderBy(desc(firmwareReleases.sequence));
}

export type FirmwareReleaseRow = typeof firmwareReleases.$inferSelect;

/** Everything, for /admin/firmware. Newest first. */
export async function listReleasesFull(): Promise<FirmwareReleaseRow[]> {
  return getDb().select().from(firmwareReleases).orderBy(desc(firmwareReleases.sequence));
}
