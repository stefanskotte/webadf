import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { firmwareAtLeastSql } from './display-store';

// No Postgres-compatible engine is in devDependencies, so this pins the rendered SQL's shape, not its result.
const render = (min: string) => new PgDialect().sqlToQuery(firmwareAtLeastSql(min));

describe('firmwareAtLeastSql (the server-side guard for Network)', () => {
  it('compares the numeric semver half of devices.firmware_version', () => {
    const q = render('1.11.0');
    expect(q.params).toEqual([]);
    expect(q.sql).toContain(`"firmware_version" ~ '^[0-9]+[.][0-9]+[.][0-9]+[+]'`);
    expect(q.sql).toContain(`string_to_array(split_part("devices"."firmware_version", '+', 1), '.')::int[]`);
    expect(q.sql).toContain('>= array[1,11,0]::int[]');
  });
  it('keeps the cast behind the shape check, so a version without "+" or a NULL is not new enough', () => {
    const q = render('1.11.0').sql;
    expect(q.indexOf('case when')).toBeLessThan(q.indexOf('::int[]'));
    expect(q).toMatch(/then [\s\S]* end\)\s*>=/);
  });
  it('renders the wanted version numerically (1.9.0 is not 1.11.0)', () => {
    expect(render('1.9.0').sql).toContain('>= array[1,9,0]::int[]');
  });
  it('refuses a malformed minimum', () => {
    expect(() => firmwareAtLeastSql('1.11')).toThrow();
    expect(() => firmwareAtLeastSql('1.x.0')).toThrow();
  });
});
