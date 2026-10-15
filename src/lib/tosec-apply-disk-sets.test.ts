import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { games, disks } from '@/db/schema/catalog';
import { tosecEntries } from '@/db/schema/tosec';
import { collectionGames } from '@/db/schema/collections';
import { demozooDismissals } from '@/db/schema/demozoo';

// Disk sets spec: games.diskOrderSource: 'human' means a person arranged this
// game's disks, and TOSEC apply must leave that arrangement alone -- see
// tosec-apply.ts's header comments on applyMatch and mergeDuplicates for the
// full reasoning. This file proves it at the row level: a human-arranged
// game still gets its disk's tosecName (identity), but not its diskNo
// (arrangement) or its title, and mergeDuplicates never treats it as a
// survivor or as absorbed.

const dialect = new PgDialect();
const paramsOf = (cond: unknown) => dialect.sqlToQuery(cond as SQL).params;

interface Captured { table: unknown; op: 'update' | 'delete'; patch?: Record<string, unknown>; params: unknown[] }

let captured: Captured[] = [];
let entryFixture: Record<string, unknown>[] = [];
let affectedFixture: Record<string, unknown>[] = [];
let dupesFixture: Record<string, unknown>[] = [];

// Every select() in tosec-apply.ts is routed by which table .from() names,
// not by call order -- that keeps this fake correct whether the query is one
// of the three top-level awaited selects (tosecEntries, the disks/games
// join, mergeDuplicates' dupes) or one of the two un-awaited subqueries
// mergeDuplicates embeds in an inArray() while building a merge's batch.
function makeQueryBuilder(getResult: () => unknown) {
  const builder = {
    from: () => builder,
    innerJoin: () => builder,
    where: () => builder,
    orderBy: () => builder,
    limit: () => builder,
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(getResult()).then(resolve, reject),
  };
  return builder;
}

const fakeDb = {
  select: () => ({
    from: (table: unknown) => {
      if (table === tosecEntries) return makeQueryBuilder(() => entryFixture);
      if (table === disks) return makeQueryBuilder(() => affectedFixture);
      if (table === games) return makeQueryBuilder(() => dupesFixture);
      if (table === collectionGames) return makeQueryBuilder(() => []);
      if (table === demozooDismissals) return makeQueryBuilder(() => []);
      throw new Error('fakeDb.select(): unexpected table');
    },
  }),
  update: (table: unknown) => ({
    set: (patch: Record<string, unknown>) => ({
      where: (cond: unknown) => {
        captured.push({ table, op: 'update', patch, params: paramsOf(cond) });
        return { __fakeBatchItem: true };
      },
    }),
  }),
  delete: (table: unknown) => ({
    where: (cond: unknown) => {
      captured.push({ table, op: 'delete', params: paramsOf(cond) });
      return { __fakeBatchItem: true };
    },
  }),
  transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeDb),
};

vi.mock('@/db', () => ({ getDb: () => fakeDb }));

const { applyMatch } = await import('./tosec-apply');

beforeEach(() => {
  captured = [];
  entryFixture = [];
  affectedFixture = [];
  dupesFixture = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

const entry = {
  id: 'entry-1',
  romName: 'Some Game (Disk 1 of 3)',
  diskNo: 1,
  sortTitle: 'Some Game',
  year: 1991,
  title: 'Some Game',
  publisher: 'Some Publisher',
};

describe('applyMatch: disk-level guard for a human-arranged set', () => {
  it('writes tosecName but not diskNo, and does not retitle the game', async () => {
    entryFixture = [entry];
    affectedFixture = [{ diskId: 'disk-1', gameId: 'game-1', orgId: 'org-1', diskOrderSource: 'human' }];

    const result = await applyMatch('sha-1', 'entry-1');

    const diskUpdates = captured.filter((c) => c.table === disks && c.op === 'update' && 'tosecName' in (c.patch ?? {}));
    expect(diskUpdates).toHaveLength(1);
    expect(diskUpdates[0].patch?.tosecName).toBe(entry.romName);
    expect('diskNo' in (diskUpdates[0].patch ?? {})).toBe(false);

    const gameRetitles = captured.filter((c) => c.table === games && c.op === 'update' && 'title' in (c.patch ?? {}));
    expect(gameRetitles).toHaveLength(0);

    expect(result.disksUpdated).toBe(1);
    expect(result.gamesUpdated).toBe(0);
  });

  it('still renumbers a disk in an ordinary game, as before', async () => {
    entryFixture = [entry];
    affectedFixture = [{ diskId: 'disk-2', gameId: 'game-2', orgId: 'org-1', diskOrderSource: null }];

    const result = await applyMatch('sha-1', 'entry-1');

    const diskUpdates = captured.filter((c) => c.table === disks && c.op === 'update' && 'tosecName' in (c.patch ?? {}));
    expect(diskUpdates).toHaveLength(1);
    expect(diskUpdates[0].patch?.diskNo).toBe(entry.diskNo);

    const gameRetitles = captured.filter((c) => c.table === games && c.op === 'update' && 'title' in (c.patch ?? {}));
    expect(gameRetitles).toHaveLength(1);
    expect(gameRetitles[0].patch?.title).toBe(entry.title);
    // First param of eq(games.id, row.gameId) inside the and(...) is the game id.
    expect(gameRetitles[0].params[0]).toBe('game-2');

    expect(result.disksUpdated).toBe(1);
    expect(result.gamesUpdated).toBe(1);
  });
});

describe('mergeDuplicates: a human-arranged game is neither survivor nor absorbed', () => {
  it('merges the two machine duplicates and leaves the human-arranged one completely untouched', async () => {
    entryFixture = [entry];
    // The disk that triggered the sweep belongs to a game outside the dupe
    // set -- what matters here is (orgId, sortTitle, year) matching the
    // entry, which the dupes fixture below provides regardless.
    affectedFixture = [{ diskId: 'disk-3', gameId: 'game-focus', orgId: 'org-1', diskOrderSource: null }];
    dupesFixture = [
      { id: 'game-human', createdAt: new Date('2026-01-01'), metadataSource: 'tosec', diskOrderSource: 'human' },
      { id: 'game-m1', createdAt: new Date('2026-01-02'), metadataSource: 'tosec', diskOrderSource: null },
      { id: 'game-m2', createdAt: new Date('2026-01-03'), metadataSource: 'tosec', diskOrderSource: null },
    ];

    const result = await applyMatch('sha-1', 'entry-1');

    // game-m1 is the older of the two machine rows and survives; game-m2 is
    // absorbed. game-human appears in NEITHER role, anywhere.
    const deletedGames = captured.filter((c) => c.table === games && c.op === 'delete');
    expect(deletedGames).toHaveLength(1);
    expect(deletedGames[0].params).toContain('game-m2');
    expect(deletedGames[0].params).not.toContain('game-human');

    const diskRepoints = captured.filter((c) => c.table === disks && c.op === 'update' && 'gameId' in (c.patch ?? {}));
    expect(diskRepoints).toHaveLength(1);
    expect(diskRepoints[0].patch?.gameId).toBe('game-m1');
    expect(diskRepoints[0].params).toEqual(['game-m2']);

    // Nothing anywhere in the captured batch references game-human -- it was
    // dropped from `dupes` before the protected/machine split, not merely
    // excluded from survivor/absorbed after.
    const touchesHuman = captured.some((c) => c.params.includes('game-human')
      || c.patch?.gameId === 'game-human');
    expect(touchesHuman).toBe(false);

    expect(result.gamesMerged).toBe(1);
  });

  it('merges nothing when the only non-human duplicate left is a single row', async () => {
    entryFixture = [entry];
    affectedFixture = [{ diskId: 'disk-4', gameId: 'game-focus', orgId: 'org-1', diskOrderSource: null }];
    dupesFixture = [
      { id: 'game-human-2', createdAt: new Date('2026-01-01'), metadataSource: 'tosec', diskOrderSource: 'human' },
      { id: 'game-m3', createdAt: new Date('2026-01-02'), metadataSource: 'tosec', diskOrderSource: null },
    ];

    const result = await applyMatch('sha-1', 'entry-1');

    const deletedGames = captured.filter((c) => c.table === games && c.op === 'delete');
    expect(deletedGames).toHaveLength(0);
    expect(result.gamesMerged).toBe(0);
  });
});
