// The org scope of every cover query, checked on the SQL drizzle would really
// send: a fake DB captures the WHERE, and PgDialect renders it.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

let whereSeen: SQL | undefined;
let setSeen: unknown;
let result: unknown[] = [];

vi.mock('@/db', () => ({
  getDb: () => ({
    select: () => {
      const chain = {
        from: () => chain,
        where: (w: SQL) => { whereSeen = w; return chain; },
        limit: () => Promise.resolve(result),
      };
      return chain;
    },
    update: () => ({
      set: (s: unknown) => {
        setSeen = s;
        return { where: (w: SQL) => { whereSeen = w; return { returning: () => Promise.resolve(result) }; } };
      },
    }),
  }),
}));

const { getCoverOverride, setCoverOverride } = await import('./cover-override');
const render = (w: SQL | undefined) => new PgDialect().sqlToQuery(w!);

beforeEach(() => { whereSeen = undefined; setSeen = undefined; result = []; });

describe('cover override queries are scoped to the caller org', () => {
  it('reads by org AND id', async () => {
    result = [{ sha256: 'a'.repeat(64) }];
    expect(await getCoverOverride('org-1', 'g1')).toEqual({ sha256: 'a'.repeat(64) });
    const q = render(whereSeen);
    expect(q.sql).toContain('"games"."org_id" = $1');
    expect(q.sql).toContain('"games"."id" = $2');
    expect(q.params).toEqual(['org-1', 'g1']);
  });

  it('another org\'s title (no row under this org) is undefined, not someone else\'s cover', async () => {
    result = [];
    expect(await getCoverOverride('org-2', 'g1')).toBeUndefined();
    expect(render(whereSeen).params).toEqual(['org-2', 'g1']);
  });

  it('writes only the override column, scoped by org AND id', async () => {
    result = [{ id: 'g1' }];
    expect(await setCoverOverride('org-1', 'g1', 'b'.repeat(64))).toBe(true);
    expect(setSeen).toEqual({ coverOverrideSha256: 'b'.repeat(64) });
    expect(render(whereSeen).params).toEqual(['org-1', 'g1']);
  });

  it('revert writes null; no row means not found', async () => {
    result = [];
    expect(await setCoverOverride('org-1', 'nope', null)).toBe(false);
    expect(setSeen).toEqual({ coverOverrideSha256: null });
  });

  it('refuses to build a query with an empty org id', async () => {
    await expect(getCoverOverride('', 'g1')).rejects.toThrow(/empty org id/);
  });
});
