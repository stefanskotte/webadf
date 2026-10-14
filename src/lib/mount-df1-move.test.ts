// Spec 2026-10-14 §3.2: mounting into DF0 the disk picked for DF1 is a move -- the pick is cleared, and its cursor
// moved, in the same UPDATE as DF0's new disk.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

let selects: unknown[][] = [];
let updates: unknown[][] = [];
const sets: Record<string, unknown>[] = [];
function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  for (const k of ['from', 'leftJoin', 'innerJoin', 'where']) c[k] = () => c;
  c.set = (s: Record<string, unknown>) => { sets.push(s); return c; };
  c.limit = () => Promise.resolve(result);
  c.returning = () => Promise.resolve(result);
  return c;
}
const fakeDb = { select: () => chain(selects.shift() ?? []), update: () => chain(updates.shift() ?? []) };
vi.mock('@/db', () => ({ getDb: () => fakeDb }));

const { setDesired } = await import('./mount');
const dialect = new PgDialect();
const q = (v: unknown) => dialect.sqlToQuery(v as SQL);

const DD = { id: 'disk-x', sha256: 'a'.repeat(64), gameId: 'g1', diskNo: 1, sizeBytes: 901_120, imageFormat: 'adf', maxTrackBits: null };

beforeEach(() => { selects = []; updates = []; sets.length = 0; });

describe('setDesired and the disk in DF1', () => {
  it('clears the pick and moves its cursor when DF0 takes the picked disk, in the same UPDATE', async () => {
    selects = [[DD]];
    updates = [[{ version: 9 }]];
    expect(await setDesired('org-1', 'dev-1', 'disk-x')).toEqual({ ok: true, version: 9 });
    const pick = q(sets[0].df1DiskId);
    expect(pick.sql).toContain('case when "devices"."df1_disk_id" = $');
    expect(pick.sql).toContain('then null else "devices"."df1_disk_id" end');
    expect(pick.params).toContain('disk-x');
    const cur = q(sets[0].df1Version);
    expect(cur.sql).toContain('then "devices"."df1_version" + 1 else "devices"."df1_version" end');
    expect(cur.params).toContain('disk-x');
  });
});
