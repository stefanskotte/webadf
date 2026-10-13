import { describe, it, expect } from 'vitest';
import { drizzle } from 'drizzle-orm/neon-http';
import { listReleasesQuery, latestReleaseQuery } from './firmware-releases';

// HANDOFF backlog "e2e firmware releases show to real boards during a run": the specs seed `0.0.0+e2e*`
// releases with the highest sequences, and every org read them as "newest" until the teardown ran. No
// database in unit tests: drizzle.mock() renders the SQL. What matters is that the org-facing reads carry
// the guard -- a `+e2e` version is visible only to a TEST org, by the teardown's own rule (has members,
// every one @example.test; src/lib/test-org.ts) -- and that every pattern is bound, never spliced.
const ORG = 'org-real-1';

for (const [name, build] of [
  ['listReleasesQuery', () => listReleasesQuery(drizzle.mock(), ORG)],
  ['latestReleaseQuery', () => latestReleaseQuery(drizzle.mock(), ORG)],
] as const) {
  describe(name, () => {
    const { sql, params } = build().toSQL();
    const q = sql.toLowerCase().replace(/\s+/g, ' ');

    it('hides +e2e versions unless the org is a test org', () => {
      expect(q).toMatch(/"firmware_releases"\."version" not like \$\d+/);
      expect(params).toContain('%+e2e%');
      expect(q).toMatch(/ or \(exists \(select 1 from "auth"\."member"/);
    });

    it('scopes the test-org check to the asking org, by bound parameters', () => {
      expect(params).toContain(ORG);
      expect(params).toContain('%@example.test');
      expect(q).not.toContain('example.test');
      expect(q).not.toContain(ORG);
    });

    it('still orders by sequence, newest first', () => {
      expect(q).toMatch(/order by "firmware_releases"\."sequence" desc/);
    });
  });
}
