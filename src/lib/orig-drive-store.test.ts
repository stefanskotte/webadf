// Original drive (rev C, 2026-11-19, src/lib/orig-drive.ts): the store's writes, the drive_base transitions a status
// makes, and Drive numbers refused while the original drive is DF0.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

let updates: unknown[][] = [];
let selects: unknown[][] = [];
const sets: Record<string, unknown>[] = [];
const wheres: unknown[] = [];
function chain(result: () => unknown) {
  const c: Record<string, unknown> = {};
  c.from = () => c;
  c.where = (w: unknown) => { wheres.push(w); return c; };
  c.set = (s: Record<string, unknown>) => { sets.push(s); return c; };
  c.limit = () => Promise.resolve(result());
  c.returning = () => Promise.resolve(result());
  // recordStatus awaits the UPDATE's where() directly.
  c.then = (res: (v: unknown) => unknown) => res(undefined);
  return c;
}
const fakeDb = {
  select: () => chain(() => selects.shift() ?? []),
  update: () => chain(() => updates.shift() ?? []),
};
vi.mock('@/db', () => ({ getDb: () => fakeDb }));

const saveSecondDrive = vi.fn(async () => ({ version: 1 }));
vi.mock('@/lib/second-drive-store', () => ({ saveSecondDrive: (...a: unknown[]) => saveSecondDrive(...(a as [])) }));

const { saveOrigDrive } = await import('./orig-drive-store');
const { saveDriveBase } = await import('./drive-numbers-store');
const { recordStatus } = await import('./mount');
const render = (v: unknown) => new PgDialect().sqlToQuery(v as SQL).sql;

beforeEach(() => { updates = []; selects = []; sets.length = 0; wheres.length = 0; vi.clearAllMocks(); });

describe('saveOrigDrive', () => {
  it('stores the mode and moves the cursor, only on a capable board of this org', async () => {
    updates = [[{ version: 3 }]];
    expect(await saveOrigDrive('org-1', 'dev-1', 'off')).toEqual({ version: 3 });
    expect(sets[0].origDrive).toBe('off');
    expect(render(sets[0].origDriveVersion)).toBe('"devices"."orig_drive_version" + 1');
    expect(render(wheres[0])).toContain('"devices"."orig_drive_capable" = $');
    expect(render(wheres[0])).toContain('"devices"."org_id" = $');
  });
  it('refuses a board without the expander', async () => {
    updates = [[]];
    selects = [[{ capable: false }]];
    expect(await saveOrigDrive('org-1', 'dev-1', 'auto')).toBe('not_capable');
  });
  it('says not_found for a board that is not this org\'s', async () => {
    updates = [[]];
    selects = [[]];
    expect(await saveOrigDrive('org-1', 'dev-x', 'auto')).toBe('not_found');
  });
});

describe('saveDriveBase while the original drive is DF0', () => {
  it('guards the write on orig_drive_active, in the WHERE', async () => {
    updates = [[{ secondDrive: 'off', capable: true }]];
    expect(await saveDriveBase('org-1', 'dev-1', 2)).toBe('ok');
    expect(sets[0]).toEqual({ driveBase: 2 });
    expect(render(wheres[0])).toContain('"devices"."orig_drive_active" <> $');
  });
  it('refuses while the original drive is in use', async () => {
    updates = [[]];
    selects = [[{ active: true }]];
    expect(await saveDriveBase('org-1', 'dev-1', 0)).toBe('orig_drive_active');
    expect(saveSecondDrive).not.toHaveBeenCalled();
  });
  it('still says not_found for a board that is not there', async () => {
    updates = [[]];
    selects = [[]];
    expect(await saveDriveBase('org-1', 'dev-x', 0)).toBe('not_found');
  });
});

describe('recordStatus and the original drive', () => {
  const base = { mountedSha256: null, firmwareVersion: '1.26.0' };

  it('stores what the board says, and makes it capable', async () => {
    await recordStatus('dev-1', { ...base, origDrive: { mode: 'auto', version: 4, present: true, active: true } });
    const p = sets[0];
    expect(p.origDriveCapable).toBe(true);
    expect(p.origDriveReported).toBe('auto');
    expect(p.origDriveAppliedVersion).toBe(4);
    expect(p.origDrivePresent).toBe(true);
    expect(p.origDriveActive).toBe(true);
  });

  it('active: drive_base becomes 1 on the false->true flip only (a board already active keeps the stored numbers)', async () => {
    await recordStatus('dev-1', { ...base, origDrive: { mode: 'auto', version: 1, present: true, active: true } });
    expect(render(sets[0].driveBase))
      .toBe('case when "devices"."orig_drive_active" then "devices"."drive_base" else 1 end');
  });

  it('not active: drive_base goes back to 0 on the true->false flip only', async () => {
    await recordStatus('dev-1', { ...base, origDrive: { mode: 'off', version: 2, present: true, active: false } });
    expect(render(sets[0].driveBase))
      .toBe('case when "devices"."orig_drive_active" then 0 else "devices"."drive_base" end');
  });

  it('a build without it (firmware named, no origDrive) is not capable, and an active drive stops: back to 0', async () => {
    await recordStatus('dev-1', { ...base });
    const p = sets[0];
    expect(p.origDriveCapable).toBe(false);
    expect(p.origDriveReported).toBeNull();
    expect(p.origDriveActive).toBe(false);
    expect(p.origDrivePresent).toBe(false);
    expect(render(p.driveBase)).toBe('case when "devices"."orig_drive_active" then 0 else "devices"."drive_base" end');
  });

  it('a partial report (no firmware, no origDrive) leaves everything alone', async () => {
    await recordStatus('dev-1', { mountedSha256: null });
    for (const k of ['origDriveCapable', 'origDriveActive', 'origDrivePresent', 'origDriveReported', 'driveBase']) {
      expect(k in sets[0]).toBe(false);
    }
  });
});
