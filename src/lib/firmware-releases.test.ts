import { afterEach, describe, it, expect } from 'vitest';
import { drizzle } from 'drizzle-orm/neon-http';
import { benchOrgIds, listReleasesQuery, latestReleaseQuery } from './firmware-releases';

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

    // A bench build (notes "TEST build...", isTestBuild) was offered to every org's card: another org's
    // board took one (HANDOFF 3bk). It is visible only to the orgs in FIRMWARE_BENCH_ORGS.
    it('hides TEST builds unless the org is a bench org, by bound parameters', () => {
      expect(params).toContain('TEST build%');
      expect(q).toMatch(/"firmware_releases"\."notes" is null or "firmware_releases"\."notes" not like \$\d+/);
      expect(q).not.toContain('test build');
    });

    it('still orders by sequence, newest first', () => {
      expect(q).toMatch(/order by "firmware_releases"\."sequence" desc/);
    });
  });
}

describe('TEST builds and FIRMWARE_BENCH_ORGS', () => {
  const build = () => {
    const { sql, params } = listReleasesQuery(drizzle.mock(), ORG).toSQL();
    return { q: sql.toLowerCase().replace(/\s+/g, ' '), params };
  };
  afterEach(() => { delete process.env.FIRMWARE_BENCH_ORGS; });

  it('unset: no org sees a TEST build (fail closed)', () => {
    delete process.env.FIRMWARE_BENCH_ORGS;
    expect(build().q).toMatch(/not like \$\d+ or false\)/);
  });

  it('set: the asking org is compared with each bench org, all bound', () => {
    process.env.FIRMWARE_BENCH_ORGS = ' bench-a , bench-b,';
    const { q, params } = build();
    expect(q).toMatch(/not like \$\d+ or \$\d+ in \(\$\d+, \$\d+\)\)/);
    expect(params).toEqual(expect.arrayContaining(['bench-a', 'bench-b', ORG]));
    expect(q).not.toContain('bench-a');
  });
});

describe('benchOrgIds', () => {
  it('splits, trims and drops empties', () => {
    expect(benchOrgIds(' a, b ,,c ')).toEqual(['a', 'b', 'c']);
    expect(benchOrgIds(undefined)).toEqual([]);
    expect(benchOrgIds('')).toEqual([]);
  });
});
