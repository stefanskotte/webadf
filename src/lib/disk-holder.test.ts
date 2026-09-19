// The statement repointLateMounts sends, rendered back to real SQL with
// Drizzle's own dialect. Its race (a mount landing between findHolder and
// recordVersion's commit) cannot be timed reliably in e2e, so its SHAPE is
// what is pinned here: which rows it may touch and what it sets.

import { describe, it, expect } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { devices } from '@/db/schema/devices';
import { repointLateMounts, findHolder, mountedReason } from '@/lib/disk-holder';
import { ejectMessage, isMountedReason } from '@/lib/mount-wording';

const dialect = new PgDialect();
const render = (cond: unknown) => dialect.sqlToQuery(cond as SQL);

const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);

function fakeDb(selectResult: unknown[] = []) {
  const calls: { table?: unknown; set?: Record<string, unknown>; where?: unknown }[] = [];
  const db = {
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: (where: unknown) => { calls.push({ table, set, where }); return Promise.resolve(undefined); },
      }),
    }),
    select: () => {
      const chain = {
        from: () => chain,
        where: (where: unknown) => { calls.push({ where }); return chain; },
        limit: () => Promise.resolve(selectResult),
      };
      return chain;
    },
  };
  return { db: db as never, calls };
}

describe('repointLateMounts', () => {
  it('moves only devices desiring THIS disk at the OLD sha, in this org, and bumps them atomically', async () => {
    const { db, calls } = fakeDb();
    await repointLateMounts(db, 'org-1', 'disk-1', OLD, NEW);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.table).toBe(devices);
    expect(call.set!.desiredSha256).toBe(NEW);
    // An SQL increment, not a read-then-write value.
    expect(render(call.set!.desiredVersion).sql).toBe('"devices"."desired_version" + 1');

    const where = render(call.where);
    expect(where.sql).toContain('"devices"."org_id" = $');
    expect(where.sql).toContain('"devices"."desired_disk_id" = $');
    expect(where.sql).toContain('"devices"."desired_sha256" = $');
    expect(where.sql).not.toContain('mounted_sha256');   // holders at check time are never touched
    expect(where.sql).not.toContain(' or ');
    expect(where.params).toEqual(['org-1', 'disk-1', OLD]);
  });
});

describe('findHolder', () => {
  it('checks both mount columns in the org, and answers the first holder or null', async () => {
    const held = fakeDb([{ name: 'Amiga 500' }]);
    expect(await findHolder(held.db, 'org-1', OLD)).toEqual({ name: 'Amiga 500' });
    const where = render(held.calls[0].where);
    expect(where.sql).toContain('"devices"."mounted_sha256"');
    expect(where.sql).toContain('"devices"."desired_sha256"');
    expect(where.params).toEqual(['org-1', OLD, OLD]);

    expect(await findHolder(fakeDb([]).db, 'org-1', OLD)).toBeNull();
  });
});

describe('mount wording', () => {
  it('builds every sentence from the one reason string', () => {
    const reason = mountedReason('Amiga 500');
    expect(reason).toBe('mounted on "Amiga 500"');
    expect(isMountedReason(reason)).toBe(true);
    expect(isMountedReason('conflict')).toBe(false);
    expect(ejectMessage(reason, 'renaming'))
      .toBe('This disk is mounted on "Amiga 500" — eject it there before renaming.');
    expect(ejectMessage(reason, 'editing'))
      .toBe('This disk is mounted on "Amiga 500" — eject it there before editing.');
    expect(ejectMessage(reason)).toBe('This disk is mounted on "Amiga 500" — eject it there first.');
  });
});
