import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { syntheticVolume } from '@/lib/adffs/synthetic';

// Pages the select answers with, in order; every select WHERE and update kept.
let pages: unknown[][] = [];
const selectWheres: SQL[] = [];
const updates: { set: Record<string, unknown>; where: SQL }[] = [];
const fakeDb = {
  select: () => {
    const c: Record<string, unknown> = {};
    c.from = () => c;
    c.where = (w: SQL) => { selectWheres.push(w); return c; };
    c.orderBy = () => c;
    c.limit = () => Promise.resolve(pages.shift() ?? []);
    return c;
  },
  update: () => ({
    set: (set: Record<string, unknown>) => ({
      where: (where: SQL) => ({
        returning: () => { updates.push({ set, where }); return Promise.resolve([{ id: 'x' }]); },
      }),
    }),
  }),
};
vi.mock('@/db', () => ({ getDb: () => fakeDb }));

const stored = new Map<string, Uint8Array>();
vi.mock('@/lib/storage', () => ({
  diskStore: {
    read: async (s: string) => { const b = stored.get(s); if (!b) throw new Error('gone'); return b; },
  },
}));

const { backfillDiskLabels } = await import('./disk-label-backfill');
const render = (w: SQL) => new PgDialect().sqlToQuery(w).sql;

beforeEach(() => {
  pages = []; selectWheres.length = 0; updates.length = 0; stored.clear();
  stored.set('s-a', syntheticVolume({ volumeName: 'Install3.2' }));
  stored.set('s-b', syntheticVolume({ noSignature: true }));
  pages = [[
    { id: 'a', orgId: 'o1', sha256: 's-a' },
    { id: 'b', orgId: 'o1', sha256: 's-b' },
    { id: 'c', orgId: 'o2', sha256: 's-gone' },
  ]];
});

describe('backfillDiskLabels', () => {
  it('a dry run counts and writes nothing', async () => {
    expect(await backfillDiskLabels({ apply: false }))
      .toEqual({ candidates: 3, named: 1, noName: 1, unreadable: 1, written: 0 });
    expect(updates).toEqual([]);
  });

  it('with apply, writes only the named disk, guarded on its org and on the label still being empty', async () => {
    const c = await backfillDiskLabels({ apply: true });
    expect(c.written).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].set).toEqual({ label: 'Install3.2' });
    expect(render(updates[0].where)).toMatch(/"disks"\."org_id" = \$\d+ and \("disks"\."label" is null or btrim\("disks"\."label"\) = \$\d+\)/);
  });

  it('selects only unlabelled ADFs of multi-disk titles', async () => {
    await backfillDiskLabels({ apply: false });
    const w = render(selectWheres[0]);
    expect(w).toContain('"disks"."image_format" = $');
    expect(w).toMatch(/"disks"\."label" is null or btrim\("disks"\."label"\)/);
    expect(w).toMatch(/select count\(\*\) from disks d2 where d2\.game_id = "disks"\."game_id" and d2\.org_id = "disks"\."org_id"\) > 1/);
  });
});
