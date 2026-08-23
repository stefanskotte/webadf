import { describe, it, expect } from 'vitest';
import { eq, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { games } from './schema/catalog';
import { orgFilter } from './scope';

// Deviation from the brief: JSON.stringify(sql) throws "Converting circular
// structure to JSON" in drizzle-orm 0.45 (a column's `table` points back at
// the table), so we render the SQL to { sql, params } first.
const render = (sql: SQL) => JSON.stringify(new PgDialect().sqlToQuery(sql));

describe('orgFilter', () => {
  it('always constrains by org id', () => {
    const sql = orgFilter(games, 'org_abc');
    expect(sql).toBeDefined();
    expect(render(sql)).toContain('org_abc');
  });

  it('ANDs an extra predicate rather than replacing the org constraint', () => {
    const sql = orgFilter(games, 'org_abc', eq(games.title, 'Project-X'));
    const s = render(sql);
    expect(s).toContain('org_abc');
    expect(s).toContain('Project-X');
  });

  it('rejects an empty org id instead of matching everything', () => {
    expect(() => orgFilter(games, '')).toThrow(/org/i);
  });
});
