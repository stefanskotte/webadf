/**
 * The devices `nfc:write` may pick from. Live e2e runs pair devices in their
 * own throwaway orgs on the same database, so "exactly one device anywhere"
 * is false the moment a run leaves one behind -- and an unfiltered list would
 * offer the operator a board that does not exist.
 *
 * The rule is the e2e teardown's own (e2e/device-helpers.ts,
 * purgeSignedUpOrgs), expressed in SQL: an org is a TEST org when it has at
 * least one member and EVERY member is @example.test. Such orgs' devices are
 * excluded. An org with no members at all is not a test org by that rule and
 * stays visible -- the same "skip rather than trust" direction the teardown
 * takes.
 */
import { sql } from 'drizzle-orm';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { devices } from '@/db/schema/devices';
import { member, user } from '@/db/schema/auth';

export const E2E_TEST_EMAIL = '%@example.test';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function selectableDevicesQuery(db: NeonHttpDatabase<any>) {
  return db.select({
    id: devices.id, orgId: devices.orgId, name: devices.name, nfcReader: devices.nfcReader,
  }).from(devices).where(sql`not (exists (select 1 from ${member} where ${member.organizationId} = ${devices.orgId})
    and not exists (select 1 from ${member} join ${user} on ${user.id} = ${member.userId}
      where ${member.organizationId} = ${devices.orgId} and ${user.email} not like ${E2E_TEST_EMAIL}))`);
}
