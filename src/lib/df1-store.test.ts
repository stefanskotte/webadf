import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

let selects: unknown[][] = [];
let updates: unknown[][] = [];
const wheres: unknown[] = [];
const sets: Record<string, unknown>[] = [];
let updateCalls = 0;
function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  for (const k of ['from', 'leftJoin', 'innerJoin']) c[k] = () => c;
  c.set = (s: Record<string, unknown>) => { sets.push(s); return c; };
  c.where = (w: unknown) => { wheres.push(w); return c; };
  c.limit = () => Promise.resolve(result);
  c.returning = () => Promise.resolve(result);
  return c;
}
const fakeDb = {
  select: () => chain(selects.shift() ?? []),
  update: () => { updateCalls++; return chain(updates.shift() ?? []); },
};
vi.mock('@/db', () => ({ getDb: () => fakeDb }));

const { mountToDf1, ejectDf1, ejectDf1Holders, readDf1ForPoll } = await import('./df1-store');
const dialect = new PgDialect();
const render = (w: unknown) => dialect.sqlToQuery(w as SQL).sql;
const params = (w: unknown) => dialect.sqlToQuery(w as SQL).params;

const DD = { id: 'disk-x', imageFormat: 'adf', sizeBytes: 901_120 };
const BOARD = {
  secondDrive: 'df1', secondDriveReported: 'df1', secondDriveVersion: 3, secondDriveAppliedVersion: 3,
  firmwareVersion: '1.12.0+gabc1234', desiredDiskId: null, mountedDiskId: null, df1DiskId: null,
};

beforeEach(() => { selects = []; updates = []; wheres.length = 0; sets.length = 0; updateCalls = 0; });

describe('mountToDf1 (spec §4.4): one conditional UPDATE with §3.1 in its WHERE', () => {
  it('stores the pick and moves the cursor in the same write', async () => {
    selects = [[DD]];
    updates = [[{ version: 4 }]];
    expect(await mountToDf1('org-1', 'dev-1', 'disk-x')).toEqual({ ok: true, version: 4 });
    expect(sets[0].df1DiskId).toBe('disk-x');
    expect(render(sets[0].df1Version)).toContain('"devices"."df1_version" + 1');
    const w = render(wheres[1]);
    expect(w).toContain('"devices"."org_id" = $');
    expect(w).toContain('"devices"."second_drive" = $');
    expect(w).toContain('"devices"."second_drive_reported" = $');
    expect(w).toContain('"devices"."second_drive_applied_version" = "devices"."second_drive_version"');
    expect(w).toContain('string_to_array');                    // firmwareAtLeastSql(DF1_PICK_FW)
    expect(w).toContain('coalesce("devices"."desired_disk_id", "devices"."mounted_disk_id") is distinct from $');
    expect(params(wheres[1])).toEqual(expect.arrayContaining(['dev-1', 'org-1', 'df1', 'disk-x']));
  });

  it('is not_found for a disk outside the org, without touching any device', async () => {
    selects = [[]];
    expect(await mountToDf1('org-1', 'dev-1', 'disk-other')).toEqual({ ok: false, reason: 'not_found' });
    expect(updateCalls).toBe(0);
    expect(params(wheres[0])).toEqual(expect.arrayContaining(['disk-other', 'org-1']));
  });

  it('refuses an HFE or HD disk without an UPDATE, after confirming the board is this org\'s', async () => {
    selects = [[{ ...DD, imageFormat: 'hfe' }], [BOARD]];
    expect(await mountToDf1('org-1', 'dev-1', 'disk-x')).toEqual({ ok: false, reason: 'not_dd' });
    selects = [[{ ...DD, sizeBytes: 1_802_240 }], [BOARD]];
    expect(await mountToDf1('org-1', 'dev-1', 'disk-x')).toEqual({ ok: false, reason: 'not_dd' });
    expect(updateCalls).toBe(0);
  });

  it('a refused UPDATE reads back why', async () => {
    selects = [[DD], [{ ...BOARD, firmwareVersion: '1.11.1+g0a157eb' }]];
    updates = [[]];
    expect(await mountToDf1('org-1', 'dev-1', 'disk-x')).toEqual({ ok: false, reason: 'firmware_too_old' });
    selects = [[DD], [{ ...BOARD, secondDrive: 'off' }]];
    updates = [[]];
    expect(await mountToDf1('org-1', 'dev-1', 'disk-x')).toEqual({ ok: false, reason: 'df1_off' });
    selects = [[DD], [{ ...BOARD, desiredDiskId: 'disk-x' }]];
    updates = [[]];
    expect(await mountToDf1('org-1', 'dev-1', 'disk-x')).toEqual({ ok: false, reason: 'in_df0' });
  });

  it('is not_found for a board that is not this org\'s', async () => {
    selects = [[DD], []];
    updates = [[]];
    expect(await mountToDf1('org-1', 'dev-x', 'disk-x')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('a refusal that no longer holds when read back says "waiting", never ok', async () => {
    selects = [[DD], [BOARD]];
    updates = [[]];
    expect(await mountToDf1('org-1', 'dev-1', 'disk-x')).toEqual({ ok: false, reason: 'waiting' });
  });
});

describe('ejectDf1 and ejectDf1Holders', () => {
  it('ejectDf1 clears the pick and moves the cursor', async () => {
    updates = [[{ version: 5 }]];
    expect(await ejectDf1('org-1', 'dev-1')).toBe(5);
    expect(sets[0].df1DiskId).toBeNull();
    expect(render(sets[0].df1Version)).toContain('"devices"."df1_version" + 1');
    expect(params(wheres[0])).toEqual(expect.arrayContaining(['dev-1', 'org-1']));
  });
  it('ejectDf1 is null for a board that is not this org\'s', async () => {
    updates = [[]];
    expect(await ejectDf1('org-1', 'dev-x')).toBeNull();
  });
  it('ejectDf1Holders clears every board of the org whose pick is one of the disks', async () => {
    updates = [[{ name: 'Bench' }]];
    expect(await ejectDf1Holders('org-1', ['disk-a', 'disk-b'])).toEqual(['Bench']);
    expect(sets[0].df1DiskId).toBeNull();
    expect(render(wheres[0])).toContain('"devices"."df1_disk_id" in ($');
    expect(params(wheres[0])).toEqual(expect.arrayContaining(['org-1', 'disk-a', 'disk-b']));
  });
  it('ejectDf1Holders with no disks writes nothing', async () => {
    expect(await ejectDf1Holders('org-1', [])).toEqual([]);
    expect(updateCalls).toBe(0);
  });
});

describe('readDf1ForPoll (spec §4.2)', () => {
  it('the cursor and the pick\'s digest, null without a pick', async () => {
    selects = [[{ v: 4, sha256: 'e'.repeat(64) }]];
    expect(await readDf1ForPoll('dev-1')).toEqual({ v: 4, sha256: 'e'.repeat(64) });
    selects = [[{ v: 2, sha256: null }]];
    expect(await readDf1ForPoll('dev-1')).toEqual({ v: 2, sha256: null });
    selects = [[]];
    expect(await readDf1ForPoll('dev-1')).toEqual({ v: 0, sha256: null });
  });
});
