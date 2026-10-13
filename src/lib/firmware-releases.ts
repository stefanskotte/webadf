import { randomUUID } from 'node:crypto';
import { desc, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { getDb } from '@/db';
import { firmwareReleases } from '@/db/schema/firmware';
import { isTestOrgSql } from '@/lib/test-org';
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
    throw new PublishRefused('sequence_moved', `sequence moved from ${expectedSequence} to ${sequence} while publishing; re-run`);
  }
  const id = randomUUID();
  await db.insert(firmwareReleases).values({ ...input, id, sequence, publishedByUserId: userId });
  return { id, sequence };
}

/**
 * The e2e suite's releases (`0.0.0+e2e*`, E2E_RELEASE_PREFIX in e2e/device-helpers.ts) are published with
 * the HIGHEST sequences, so for the minutes before the teardown deletes them every real org read one as
 * "newest" and every real board as behind it (HANDOFF backlog, seen 2026-10-09). The registry stays global
 * (spec D5); what an org is SHOWN or OFFERED leaves them out unless the org is a test org (test-org.ts).
 * Both spellings, the same pair cleanupTestReleases deletes.
 */
export const TEST_RELEASE_PATTERNS = ['%+e2e%', '0.0.0-e2e%'] as const;

/** Whether a release row is visible to `orgId` -- a bound org id or a column (correlated). */
export function releaseVisibleToSql(orgId: SQLWrapper | string): SQL {
  return sql`((${firmwareReleases.version} not like ${TEST_RELEASE_PATTERNS[0]}
    and ${firmwareReleases.version} not like ${TEST_RELEASE_PATTERNS[1]}) or ${isTestOrgSql(orgId)})`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function listReleasesQuery(db: NeonHttpDatabase<any>, orgId: string) {
  return db
    .select({
      version: firmwareReleases.version,
      sequence: firmwareReleases.sequence,
      semver: firmwareReleases.semver,
      security: firmwareReleases.security,
      notes: firmwareReleases.notes,
      signatureFormat: firmwareReleases.signatureFormat,
    })
    .from(firmwareReleases)
    .where(releaseVisibleToSql(orgId))
    .orderBy(desc(firmwareReleases.sequence));
}

/**
 * Just enough for firmwareState(), newest first -- the releases `orgId` may see.
 *
 * `orgId` is REQUIRED: a default would let a call site that forgot it compile and show the e2e releases
 * again (the same lesson as liveFingerprint's latestReleaseSequence).
 *
 * `notes` is included so the Devices notice can say what a release changes.
 * Without it the notes were reachable only from /admin/firmware, which
 * redirects every non-admin -- making `--notes` write-only for exactly the
 * audience it exists for.
 */
export async function listReleases(orgId: string): Promise<ReleaseRef[]> {
  return listReleasesQuery(getDb(), orgId);
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
  signatureFormat: number;
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
      signatureFormat: firmwareReleases.signatureFormat,
    })
    .from(firmwareReleases)
    .leftJoin(user, eq(user.id, firmwareReleases.publishedByUserId))
    .orderBy(desc(firmwareReleases.sequence))
    .limit(limit);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function latestReleaseQuery(db: NeonHttpDatabase<any>, orgId: string) {
  return db
    .select({ sequence: firmwareReleases.sequence })
    .from(firmwareReleases)
    .where(releaseVisibleToSql(orgId))
    .orderBy(desc(firmwareReleases.sequence))
    .limit(1);
}

/**
 * The newest sequence `orgId` may see (listReleases' rule), or 0 when nothing is published.
 *
 * One row via the sequence index, because the live-state poll runs every few
 * seconds per open browser and only needs to know whether the registry moved.
 * Org-scoped like listReleases, so an e2e publish does not refresh a real org's open tabs either.
 */
export async function latestReleaseSequence(orgId: string): Promise<number> {
  const rows = await latestReleaseQuery(getDb(), orgId);
  return rows[0]?.sequence ?? 0;
}
