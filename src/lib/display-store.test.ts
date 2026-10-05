import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// saveDisplay is ONE conditional UPDATE ... RETURNING; only when it returns no
// row does a second, org-scoped read tell not_found from firmware_too_old.
let updated: { version: number }[] = [];
let found: { id: string }[] = [];
let sets: Record<string, unknown>[] = [];
let wheres: SQL[] = [];
let selects = 0;
const fakeDb = {
  update: () => ({
    set: (s: Record<string, unknown>) => {
      sets.push(s);
      return { where: (w: SQL) => { wheres.push(w); return { returning: async () => updated }; } };
    },
  }),
  select: () => {
    selects++;
    return { from: () => ({ where: (w: SQL) => { wheres.push(w); return { limit: async () => found }; } }) };
  },
};
vi.mock('@/db', () => ({ getDb: () => fakeDb }));

const { saveDisplay } = await import('./display-store');
const dialect = new PgDialect();
const render = (v: unknown) => dialect.sqlToQuery(v as SQL);

beforeEach(() => { updated = []; found = []; sets = []; wheres = []; selects = 0; });

describe('saveDisplay', () => {
  it('stores panel + blob, raises the version, and is gated on org AND capability in the one UPDATE', async () => {
    updated = [{ version: 3 }];
    const blob = new Uint8Array([1, 0, 0, 0]);
    expect(await saveDisplay('org-1', 'dev-1', '128x32', blob)).toEqual({ version: 3 });
    expect(selects).toBe(0);
    expect(sets[0].displayPanel).toBe('128x32');
    expect(sets[0].displayLayout).toBe(blob);
    expect('displayError' in sets[0] && sets[0].displayError === null).toBe(true);
    expect(render(sets[0].displayVersion).sql).toMatch(/"display_version" \+ 1/);
    const w = render(wheres[0]);
    expect(w.sql).toMatch(/"id" = \$1 and "devices"."org_id" = \$2.*"display_layouts" = \$3/);
    expect(w.params).toEqual(['dev-1', 'org-1', true]);
  });

  it('a reset stores a null layout', async () => {
    updated = [{ version: 4 }];
    await saveDisplay('org-1', 'dev-1', '128x64', null);
    expect(sets[0].displayLayout).toBeNull();
    expect(sets[0].displayPanel).toBe('128x64');
    expect('displayError' in sets[0] && sets[0].displayError === null).toBe(true);
  });

  it('no row updated, but the org has the device: firmware_too_old', async () => {
    found = [{ id: 'dev-1' }];
    expect(await saveDisplay('org-1', 'dev-1', '128x32', null)).toBe('firmware_too_old');
    expect(render(wheres[1]).params).toEqual(['dev-1', 'org-1']);
  });

  it('no row updated and none for this org: not_found', async () => {
    expect(await saveDisplay('org-1', 'dev-x', '128x32', null)).toBe('not_found');
  });
});
