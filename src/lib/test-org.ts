/**
 * Which orgs the live e2e suite owns. The rule is the e2e teardown's own
 * (e2e/device-helpers.ts, purgeSignedUpOrgs), expressed in SQL: an org is a
 * TEST org when it has at least one member and EVERY member is @example.test.
 * An org with no members at all, or one that does not exist, is not a test org
 * -- the "skip rather than trust" direction the teardown takes.
 */
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { member, user } from '@/db/schema/auth';

export const E2E_TEST_EMAIL = '%@example.test';

/** True for a test org. `orgId` is a column (correlated) or a bound id. */
export function isTestOrgSql(orgId: SQLWrapper | string): SQL {
  return sql`(exists (select 1 from ${member} where ${member.organizationId} = ${orgId})
    and not exists (select 1 from ${member} join ${user} on ${user.id} = ${member.userId}
      where ${member.organizationId} = ${orgId} and ${user.email} not like ${E2E_TEST_EMAIL}))`;
}
