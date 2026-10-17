import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { entitlements } from '@/db/schema/catalog';

// readDesired's per-disk label (field report 2026-10-17: a 13-disk Workbench
// 3.2 set showed "Disk 1/13 Disk 1"). Same fake-db shape as mount-hd.test.ts,
// plus every JOIN kept so the file-name join is proven org-scoped.
let selects: unknown[][] = [];
const joins: { table: unknown; on: SQL }[] = [];
function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  for (const k of ['from', 'innerJoin', 'where']) c[k] = () => c;
  c.leftJoin = (table: unknown, on: SQL) => { joins.push({ table, on }); return c; };
  c.limit = () => Promise.resolve(result);
  return c;
}
const fakeDb = { select: () => chain(selects.shift() ?? []) };
vi.mock('@/db', () => ({ getDb: () => fakeDb }));

const { readDesired } = await import('./mount');
const render = (w: SQL) => new PgDialect().sqlToQuery(w).sql;

const row = {
  version: 5, sha256: 'a'.repeat(64), diskId: 'disk-1', gameId: 'g1', diskNo: 1,
  title: 'Workbench 3.2', label: null as string | null, sourceFilename: null as string | null,
  diskCount: 13, writeProtected: true,
};
const labelOf = async (over: Partial<typeof row>) => {
  selects = [[{ ...row, ...over }]];
  return (await readDesired('dev-1'))?.desired?.label;
};

beforeEach(() => { selects = []; joins.length = 0; });

describe('readDesired: the label the board prints after "Disk n/c"', () => {
  it("sends the disk's label (the stored volume name) when it has one", async () => {
    expect(await labelOf({ label: 'Install3.2', sourceFilename: 'wb32_install.adf' })).toBe('Install3.2');
  });

  it('falls back to the uploaded file name without its extension', async () => {
    expect(await labelOf({ sourceFilename: 'Locale.adf' })).toBe('Locale');
  });

  it('never sends "Disk n" for a disk of a set: the firmware already prints the counter', async () => {
    expect(await labelOf({})).toBe('');
  });

  it('still sends "Disk n" for a one-disk title with no name at all', async () => {
    expect(await labelOf({ diskCount: 1 })).toBe('Disk 1');
  });

  it("joins the file name on the disk's bytes AND the device's org (no other tenant's file name)", async () => {
    await labelOf({});
    const ent = joins.find((j) => j.table === entitlements);
    expect(ent).toBeDefined();
    const on = render(ent!.on);
    expect(on).toContain('"entitlements"."sha256" = "disks"."sha256"');
    expect(on).toContain('"entitlements"."org_id" = "devices"."org_id"');
  });
});
