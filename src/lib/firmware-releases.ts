import { randomUUID } from 'node:crypto';
import { desc, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { getDb, type Db } from '@/db';
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

/**
 * A bench build's notes start "TEST build" (isTestBuild, firmware-github-release.ts). Every org's card offered
 * them, and another org's board took one (HANDOFF 3bk), so a TEST build is visible only to the bench orgs named in
 * FIRMWARE_BENCH_ORGS (comma-separated org ids). Unset, no org sees one: fail closed. Neither the publisher (the
 * publish script's SUPERADMIN_EMAILS user, in no bench org) nor a super-admin names the bench org, so it is stated.
 * Promoting a build (its notes edited to release notes) makes it visible to every org.
 */
export const TEST_BUILD_NOTES_PATTERN = 'TEST build%';

/** FIRMWARE_BENCH_ORGS, read per call so a test can set it. */
export function benchOrgIds(raw = process.env.FIRMWARE_BENCH_ORGS): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Whether a release row is visible to `orgId` -- a bound org id or a column (correlated). */
export function releaseVisibleToSql(orgId: SQLWrapper | string): SQL {
  const bench = benchOrgIds();
  const isBench = bench.length === 0
    ? sql`false`
    : sql`${orgId} in (${sql.join(bench.map((id) => sql`${id}`), sql`, `)})`;
  return sql`((${firmwareReleases.version} not like ${TEST_RELEASE_PATTERNS[0]}
    and ${firmwareReleases.version} not like ${TEST_RELEASE_PATTERNS[1]}) or ${isTestOrgSql(orgId)})
    and (${firmwareReleases.notes} is null or ${firmwareReleases.notes} not like ${TEST_BUILD_NOTES_PATTERN}
      or ${isBench})`;
}

/**
 * A release row that is a real release: not a TEST build (notes) and not an e2e version -- what an org outside
 * FIRMWARE_BENCH_ORGS that is not a test org may see (releaseVisibleToSql's rule for such an org).
 */
export function isRealReleaseSql(): SQL {
  return sql`(${firmwareReleases.version} not like ${TEST_RELEASE_PATTERNS[0]}
    and ${firmwareReleases.version} not like ${TEST_RELEASE_PATTERNS[1]}
    and (${firmwareReleases.notes} is null or ${firmwareReleases.notes} not like ${TEST_BUILD_NOTES_PATTERN}))`;
}

/**
 * "Current release" (A7 spec §1): the highest-sequence real release, as a one-row select of `version, sequence`
 * (no row when nothing real is published). Shared by the admin Overview and the admin Firmware tags, so the two can
 * never disagree on which release is current. Use it as a CTE or a subquery:
 * `sql\`... = (select sequence from (${currentReleaseSql()}) cur)\``.
 */
export function currentReleaseSql(): SQL {
  return sql`select ${firmwareReleases.version} as version, ${firmwareReleases.sequence} as sequence
    from ${firmwareReleases} where ${isRealReleaseSql()}
    order by ${firmwareReleases.sequence} desc limit 1`;
}

/** The current release (currentReleaseSql), or null when nothing real is published. */
export async function readCurrentRelease(): Promise<{ version: string; sequence: number } | null> {
  const { rows } = await getDb().execute<{ version: string; sequence: number }>(currentReleaseSql());
  const row = rows[0];
  return row ? { version: row.version, sequence: Number(row.sequence) } : null;
}

export function listReleasesQuery(db: Db, orgId: string) {
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
  semver: string;
  sequence: number;
  sizeBytes: number;
  signingKeyId: string;
  notes: string | null;
  security: boolean;
  publishedAt: Date;
  publishedByEmail: string | null;
  signatureFormat: number;
  /** The current release (currentReleaseSql) -- the same rule as the admin Overview's, so the two agree. */
  isCurrent: boolean;
}

/**
 * For /admin/firmware: one page, newest first (countReleases gives "Page N of M" its M). Only the columns the page
 * renders -- sha256, blobPath and the base64 signature are ~180 bytes a row that it never shows. Board counts per
 * version are a cross-tenant devices read, so they live in admin-queries.ts (adminBoardsByVersion), not here.
 */
export async function listReleasesFull(
  opts: { limit: number; offset: number },
): Promise<FirmwareReleaseListItem[]> {
  const { user } = await import('@/db/schema/auth');
  const { eq } = await import('drizzle-orm');
  const rows = await getDb()
    .select({
      id: firmwareReleases.id,
      version: firmwareReleases.version,
      semver: firmwareReleases.semver,
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
      isCurrent: sql<boolean>`coalesce(${firmwareReleases.sequence} = (select sequence from (${currentReleaseSql()}) cur), false)`,
    })
    .from(firmwareReleases)
    .leftJoin(user, eq(user.id, firmwareReleases.publishedByUserId))
    .orderBy(desc(firmwareReleases.sequence))
    .limit(opts.limit)
    .offset(opts.offset);
  return rows.map((r) => ({ ...r, isCurrent: r.isCurrent === true }));
}

/** Every release row, for /admin/firmware's page count. */
export async function countReleases(): Promise<number> {
  const [row] = await getDb().select({ n: sql<number>`count(*)::int` }).from(firmwareReleases);
  return Number(row.n);
}

export function latestReleaseQuery(db: Db, orgId: string) {
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

/**
 * Self-hosting P3 D3: a release imported from GitHub keeps the sequence its signature covers -- never
 * decidePublish's next number (TEST builds take sequences that never reach GitHub). The unique version
 * and sequence constraints make a second import of the same release a no-op.
 */
export async function importRelease(
  row: Omit<typeof firmwareReleases.$inferInsert, 'id' | 'publishedByUserId' | 'publishedAt'>,
  userId: string,
): Promise<boolean> {
  const inserted = await getDb().insert(firmwareReleases)
    .values({ ...row, id: randomUUID(), publishedByUserId: userId })
    .onConflictDoNothing()
    .returning({ id: firmwareReleases.id });
  return inserted.length === 1;
}
