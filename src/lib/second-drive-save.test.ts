// Spec 2026-10-14 §3.2 / §4.4: a setting change away from On drops the disk mounted into DF1 in the same write.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

let updates: unknown[][] = [];
const sets: Record<string, unknown>[] = [];
function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  for (const k of ['from', 'where']) c[k] = () => c;
  c.set = (s: Record<string, unknown>) => { sets.push(s); return c; };
  c.limit = () => Promise.resolve(result);
  c.returning = () => Promise.resolve(result);
  return c;
}
const fakeDb = { select: () => chain([]), update: () => chain(updates.shift() ?? []) };
vi.mock('@/db', () => ({ getDb: () => fakeDb }));

const { saveSecondDrive } = await import('./second-drive');
const render = (v: unknown) => new PgDialect().sqlToQuery(v as SQL).sql;

beforeEach(() => { updates = []; sets.length = 0; });

describe('saveSecondDrive and the disk in DF1', () => {
  for (const mode of ['off', 'net'] as const) {
    it(`leaving On (${mode}) drops the pick, moving its cursor only when there was one (Review Focus 3)`, async () => {
      updates = [[{ version: 4 }]];
      expect(await saveSecondDrive('org-1', 'dev-1', mode, false)).toEqual({ version: 4 });
      expect(sets[0].df1DiskId).toBeNull();
      expect(render(sets[0].df1Version))
        .toContain('case when "devices"."df1_disk_id" is null then "devices"."df1_version" else "devices"."df1_version" + 1 end');
    });
  }
  it('saving On keeps the pick', async () => {
    updates = [[{ version: 4 }]];
    await saveSecondDrive('org-1', 'dev-1', 'df1', false);
    expect('df1DiskId' in sets[0]).toBe(false);
    expect('df1Version' in sets[0]).toBe(false);
  });
});
