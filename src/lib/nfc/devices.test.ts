import { describe, it, expect } from 'vitest';
import { drizzle } from 'drizzle-orm/neon-http';
import { selectableDevicesQuery, E2E_TEST_EMAIL } from './devices';

// No database in unit tests: drizzle.mock() renders the SQL the script would
// send. What matters is that the e2e-org exclusion is IN the query, with the
// teardown's exact rule (e2e/device-helpers.ts purgeSignedUpOrgs): an org is
// a test org when it has at least one member and EVERY member is
// @example.test. Live e2e runs create paired devices in such orgs, and
// nfc:write must never see them as candidates.
describe('selectableDevicesQuery', () => {
  const { sql, params } = selectableDevicesQuery(drizzle.mock()).toSQL();
  const q = sql.toLowerCase().replace(/\s+/g, ' ');

  it('binds the test email pattern, never splices it', () => {
    expect(E2E_TEST_EMAIL).toBe('%@example.test');
    expect(params).toContain('%@example.test');
    expect(q).not.toContain('example.test');
  });

  it('excludes orgs that have members and no member outside @example.test', () => {
    expect(q).toMatch(/where not \(exists \(select 1 from "auth"\."member"/);
    expect(q).toMatch(/and not exists \(select 1 from "auth"\."member" .*join "auth"\."user" .* not like \$\d+/);
  });
});
