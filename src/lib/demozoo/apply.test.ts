// Unit tests for applyAutomaticLink's candidate selection. Same convention as
// sweep.test.ts: getDb() is a narrow recording fake that returns queued rows
// for each select in call order, and captured `.where(...)` conditions are
// rendered with Drizzle's own PgDialect to prove what a query would select.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { games } from '@/db/schema/catalog';

const dialect = new PgDialect();
const render = (cond: unknown) => dialect.sqlToQuery(cond as SQL);

let selectResults: unknown[][] = [];
const selectCalls: Array<{ where: unknown }> = [];
const updateCalls: Array<{ table: unknown; set: unknown }> = [];

function fakeDb() {
  const select = () => {
    const result = selectResults.shift() ?? [];
    const call: { where: unknown } = { where: undefined };
    selectCalls.push(call);
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      from: () => chain, innerJoin: () => chain, leftJoin: () => chain,
      where: (where: unknown) => { call.where = where; return chain; },
      limit: () => Promise.resolve(result),
      then: <T>(resolve: (v: unknown[]) => T, reject?: (e: unknown) => T) => Promise.resolve(result).then(resolve, reject),
    });
    return chain;
  };
  const update = (table: unknown) => ({
    set: (set: unknown) => {
      updateCalls.push({ table, set });
      return { where: () => ({ returning: async () => [{ id: 'g1' }] }) };
    },
  });
  return { select, update };
}
vi.mock('@/db', () => ({ getDb: () => fakeDb() }));

const { applyAutomaticLink } = await import('./apply');

const SHA = 'a'.repeat(64);
const production = { id: 42, title: 'Some Demo', releaseYear: 1992, groups: ['Group'] };

beforeEach(() => {
  selectResults = [];
  selectCalls.length = 0;
  updateCalls.length = 0;
});

describe('applyAutomaticLink', () => {
  it('excludes a game holding another disk TOSEC identified as a game, scoped to that game\'s own org', async () => {
    selectResults = [[]]; // no candidates

    expect(await applyAutomaticLink(SHA, 42)).toBe(0);

    const q = render(selectCalls[0].where);
    expect(q.sql).toContain('not exists');
    expect(q.sql).toContain(`b2.demozoo_state = 'skipped_game'`);
    expect(q.sql).toContain('d2.game_id = "games"."id" and d2.org_id = "games"."org_id"');
    // The triggering blob's own (possibly stale) state never excludes its game.
    expect(q.sql).toMatch(/d2\.sha256 <> \$\d+/);
    expect(q.params).toContain(SHA);
  });

  it('links a game whose only disk is the triggering blob, before that blob is stamped applied', async () => {
    selectResults = [
      [{ id: 'g1' }],  // candidates
      [],              // other disks applied: none -- and the triggering blob is not stamped yet
      [],              // dismissals
      [production],    // applyDemozooToGames' production lookup
    ];

    expect(await applyAutomaticLink(SHA, 42)).toBe(1);

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].table).toBe(games);
    expect(updateCalls[0].set).toMatchObject({ title: 'Some Demo', metadataSource: 'demozoo' });
    // The applied-disks query leaves the triggering blob out; it is counted as applied to 42 instead.
    expect(render(selectCalls[1].where).sql).toMatch(/"disks"."sha256" <> \$\d+/);
  });

  it('still refuses a game whose other disk is applied to a different production', async () => {
    selectResults = [
      [{ id: 'g1' }],
      [{ gameId: 'g1', id: 99 }],
      [],
      [production],
    ];

    expect(await applyAutomaticLink(SHA, 42)).toBe(0);
    expect(updateCalls).toHaveLength(0);
  });
});
