// Unit tests for demozooMatchPhase's orchestration: cursor gating, budget
// respect, and the per-blob branching (applied / suggested / none /
// skipped_game / per-blob failure). Follows the mocking convention
// src/lib/disk-write.test.ts and src/lib/demozoo/import-write.test.ts
// established: getDb() is replaced with a narrow fake supporting exactly the
// chain shapes sweep.ts calls (select/from/leftJoin/where/limit,
// insert/values/onConflictDoNothing, update/set/where, delete/where) and
// nothing more. Table identity is checked by reference against the real
// schema modules, which is safe to import: a pgTable() call builds metadata
// only and opens no connection. decideDemozoo/matchKeys themselves are
// exercised in match.test.ts; these tests only prove the phase wires the
// database, diskStore, applyAutomaticLink and SweepResult counters together
// the way the brief specifies.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { blobs } from '@/db/schema/catalog';
import { demozooSuggestions } from '@/db/schema/demozoo';
import type { SweepResult } from '@/lib/tosec-sweep';
import { titleKey } from './title-key';

// Renders a captured `.where(...)` back to the SQL text and params getDb()
// would send (the disk-write.test.ts technique): the fake db below returns
// queued rows whatever the condition says, so only the rendered condition
// can prove which blobs a query would select.
const dialect = new PgDialect();
const render = (cond: unknown) => dialect.sqlToQuery(cond as SQL);

// One ordered log across the database fake and applyAutomaticLink, so the
// work-before-stamp order is observable.
const events: string[] = [];

const diskStoreRead = vi.fn();
vi.mock('@/lib/storage', () => ({ diskStore: { read: diskStoreRead } }));

const applyAutomaticLinkMock = vi.fn();
vi.mock('./apply', () => ({ applyAutomaticLink: applyAutomaticLinkMock }));

let selectResults: unknown[][] = [];
const selectCalls: Array<{ table: unknown; where: unknown }> = [];
const insertCalls: Array<{ table: unknown; values: unknown }> = [];
const updateCalls: Array<{ table: unknown; set: unknown }> = [];
const deleteCalls: Array<{ table: unknown }> = [];

function fakeDb() {
  const select = () => {
    const result = selectResults.shift() ?? [];
    const call: { table: unknown; where: unknown } = { table: undefined, where: undefined };
    selectCalls.push(call);
    const chain: {
      from: (table: unknown) => typeof chain;
      leftJoin: () => typeof chain;
      where: (where: unknown) => typeof chain;
      limit: () => Promise<unknown[]>;
      then: <T>(resolve: (v: unknown[]) => T, reject?: (e: unknown) => T) => Promise<T>;
    } = {
      from: (table) => { call.table = table; return chain; },
      leftJoin: () => chain,
      where: (where) => { call.where = where; return chain; },
      limit: () => Promise.resolve(result),
      then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    };
    return chain;
  };
  const insert = (table: unknown) => ({
    values: (values: unknown) => {
      insertCalls.push({ table, values });
      return { onConflictDoNothing: () => Promise.resolve(undefined) };
    },
  });
  const update = (table: unknown) => ({
    set: (values: unknown) => {
      events.push('update');
      updateCalls.push({ table, set: values });
      return { where: () => Promise.resolve(undefined) };
    },
  });
  const del = (table: unknown) => {
    events.push('delete');
    deleteCalls.push({ table });
    return { where: () => Promise.resolve(undefined) };
  };
  return { select, insert, update, delete: del };
}
vi.mock('@/db', () => ({ getDb: () => fakeDb() }));

const { demozooMatchPhase } = await import('./sweep');

beforeEach(() => {
  vi.clearAllMocks();
  selectResults = [];
  selectCalls.length = 0;
  events.length = 0;
  applyAutomaticLinkMock.mockImplementation(async () => { events.push('applyAutomaticLink'); return 1; });
  insertCalls.length = 0;
  updateCalls.length = 0;
  deleteCalls.length = 0;
});

function freshOut(): SweepResult {
  return {
    hashed: 0, matched: 0, none: 0, ambiguous: 0, merged: 0,
    enriched: 0, enrichNone: 0, enrichAmbiguous: 0, enrichedByIdentity: 0,
    imagesStored: 0, imageBytes: 0,
    demozooApplied: 0, demozooSuggested: 0, demozooNone: 0, demozooSkippedGame: 0,
    demozooImagesStored: 0,
    done: false,
  };
}

const budget = (ms: number) => {
  const started = Date.now();
  return { spent: () => Date.now() - started, budgetMs: ms };
};

const SHA = 'a'.repeat(64);
const NOT_ADF = new Uint8Array(10); // wrong length: readVolume returns ok:false, volumeName stays null

describe('demozooMatchPhase — cursor gating and budget', () => {
  it('reports done, touching nothing else, when no import has ever been applied', async () => {
    selectResults = [[]]; // cursor query finds no row

    const out = freshOut();
    const done = await demozooMatchPhase(() => 0, 240_000, out);

    expect(done).toBe(true);
    expect(diskStoreRead).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(0);
    expect(out).toEqual(freshOut());
  });

  it('reports done when every blob is already checked for this import', async () => {
    selectResults = [[{ appliedAt: new Date('2026-09-01T00:00:00Z') }], []];

    const out = freshOut();
    const done = await demozooMatchPhase(() => 0, 240_000, out);

    expect(done).toBe(true);
  });

  it('stops and reports not-done when the budget is already spent', async () => {
    selectResults = [[{ appliedAt: new Date('2026-09-01T00:00:00Z') }]];

    const out = freshOut();
    const done = await demozooMatchPhase(() => 1_000, 500, out);

    expect(done).toBe(false);
    // Only the cursor read happened; the budget-exhausted while() never entered.
    expect(diskStoreRead).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(0);
  });
});

describe('demozooMatchPhase — per-blob outcomes', () => {
  it('skips a TOSEC game-set blob without touching disk storage or entitlements', async () => {
    const row = { sha256: SHA, setName: 'Amiga - Games - [ADF]', title: 'Some Game', year: 1991, publisher: 'Pub' };
    selectResults = [
      [{ appliedAt: new Date('2026-09-01T00:00:00Z') }], // cursor
      [row],                                              // todo batch
      [],                                                  // demozooProductions lookup (still queried; ignored by decideDemozoo)
    ];

    const out = freshOut();
    const { budgetMs } = budget(240_000);
    const done = await demozooMatchPhase(() => 0, budgetMs, out);

    expect(done).toBe(true);
    expect(diskStoreRead).not.toHaveBeenCalled();
    expect(out.demozooSkippedGame).toBe(1);
    const blobUpdate = updateCalls.find((c) => c.table === blobs);
    expect(blobUpdate?.set).toMatchObject({ demozooState: 'skipped_game', demozooProductionId: null });
  });

  it('applies a single verified match: stamps the blob and calls applyAutomaticLink', async () => {
    const title = 'Shadow of the Beast';
    const row = { sha256: SHA, setName: 'Amiga - Demos', title, year: 1989, publisher: null };
    const candidate = {
      id: 555, title, titleKey: titleKey(title), releaseYear: 1989,
      groups: ['Some Group'], supertype: 'production', isGame: false,
    };
    selectResults = [
      [{ appliedAt: new Date('2026-09-01T00:00:00Z') }], // cursor
      [row],                                              // todo batch
      [{ f: 'Shadow.adf' }],                               // entitlements
      [candidate],                                         // demozooProductions
    ];
    diskStoreRead.mockResolvedValue(NOT_ADF);

    const out = freshOut();
    const done = await demozooMatchPhase(() => 0, 240_000, out);

    expect(done).toBe(true);
    expect(out.demozooApplied).toBe(1);
    expect(applyAutomaticLinkMock).toHaveBeenCalledWith(SHA, 555);
    expect(deleteCalls.some((c) => c.table === demozooSuggestions)).toBe(true);
    const blobUpdate = updateCalls.find((c) => c.table === blobs);
    expect(blobUpdate?.set).toMatchObject({ demozooState: 'applied', demozooProductionId: 555 });
  });

  it('suggests every ambiguous candidate, inserting one suggestion row each', async () => {
    const title = 'Ambiguous Title';
    const row = { sha256: SHA, setName: 'Amiga - Demos', title, year: 1990, publisher: null };
    const candidates = [
      { id: 10, title, titleKey: titleKey(title), releaseYear: 1985, groups: [], supertype: 'production', isGame: false },
      { id: 20, title, titleKey: titleKey(title), releaseYear: 1986, groups: [], supertype: 'production', isGame: false },
    ];
    selectResults = [
      [{ appliedAt: new Date('2026-09-01T00:00:00Z') }],
      [row],
      [{ f: 'Ambiguous.adf' }],
      candidates,
    ];
    diskStoreRead.mockResolvedValue(NOT_ADF);

    const out = freshOut();
    await demozooMatchPhase(() => 0, 240_000, out);

    expect(out.demozooSuggested).toBe(1);
    const suggestionInsert = insertCalls.find((c) => c.table === demozooSuggestions);
    expect(suggestionInsert).toBeDefined();
    expect(suggestionInsert!.values).toEqual([
      { sha256: SHA, productionId: 10, source: 'tosec_title' },
      { sha256: SHA, productionId: 20, source: 'tosec_title' },
    ]);
    const blobUpdate = updateCalls.find((c) => c.table === blobs);
    expect(blobUpdate?.set).toMatchObject({ demozooState: 'suggested', demozooProductionId: null });
  });

  it('records none when nothing matches', async () => {
    const row = { sha256: SHA, setName: 'Amiga - Demos', title: 'Nothing Matches This', year: 1990, publisher: null };
    selectResults = [
      [{ appliedAt: new Date('2026-09-01T00:00:00Z') }],
      [row],
      [{ f: 'Nothing.adf' }],
      [], // no candidates at all
    ];
    diskStoreRead.mockResolvedValue(NOT_ADF);

    const out = freshOut();
    await demozooMatchPhase(() => 0, 240_000, out);

    expect(out.demozooNone).toBe(1);
    const blobUpdate = updateCalls.find((c) => c.table === blobs);
    expect(blobUpdate?.set).toMatchObject({ demozooState: 'none', demozooProductionId: null });
  });

  it('on a per-blob failure, keeps that blob\'s prior state, skips it for the rest of the run, and reports not-done', async () => {
    const title = 'Verified Demo';
    const badRow = { sha256: 'b'.repeat(64), setName: 'Amiga - Demos', title, year: 1990, publisher: null };
    const goodRow = { sha256: 'c'.repeat(64), setName: 'Amiga - Games - [ADF]', title: 'A Game', year: 1990, publisher: null };
    const candidate = { id: 77, title, titleKey: titleKey(title), releaseYear: 1990, groups: [], supertype: 'production', isGame: false };
    selectResults = [
      [{ appliedAt: new Date('2026-09-01T00:00:00Z') }], // cursor
      [badRow, goodRow],                                  // todo batch 1
      [{ f: 'Verified.adf' }],                            // entitlements for badRow
      [candidate],                                        // demozooProductions for badRow -> applied
      [],                                                 // demozooProductions for goodRow (game set)
      [],                                                 // todo batch 2: nothing else
    ];
    // A transient database error while linking the games.
    applyAutomaticLinkMock.mockRejectedValueOnce(new Error('neon: fetch failed'));

    const out = freshOut();
    const done = await demozooMatchPhase(() => 0, 240_000, out);

    // Not done: the failed blob is still owed a decision, by the next run.
    expect(done).toBe(false);
    expect(applyAutomaticLinkMock).toHaveBeenCalledTimes(1);
    // The next blob in the same batch still ran to completion.
    expect(out.demozooSkippedGame).toBe(1);
    expect(out.demozooNone).toBe(0);
    expect(out.demozooApplied).toBe(0);

    // Prior state preserved: the only blob write is the good blob's, and the
    // only suggestion delete is the good blob's -- nothing demoted the bad
    // blob's verified link, cleared its suggestions or stamped its checked-at.
    const blobUpdates = updateCalls.filter((c) => c.table === blobs);
    expect(blobUpdates).toHaveLength(1);
    expect(blobUpdates[0].set).toMatchObject({ demozooState: 'skipped_game' });
    expect(deleteCalls.filter((c) => c.table === demozooSuggestions)).toHaveLength(1);

    // The second todo query excludes the failed blob, so it is not re-selected this run.
    const todoQueries = selectCalls.filter((c) => c.table === blobs);
    expect(todoQueries).toHaveLength(2);
    expect(render(todoQueries[0].where).sql).not.toContain('not in');
    const second = render(todoQueries[1].where);
    expect(second.sql).toContain('"blobs"."sha256" not in');
    expect(second.params).toContain(badRow.sha256);
  });

  it('re-selects a blob TOSEC re-decided after its Demozoo check, not only one older than the import', async () => {
    selectResults = [[{ appliedAt: new Date('2026-09-01T00:00:00Z') }], []];

    await demozooMatchPhase(() => 0, 240_000, freshOut());

    const todo = selectCalls.find((c) => c.table === blobs);
    expect(todo).toBeDefined();
    expect(render(todo!.where).sql).toContain('"blobs"."demozoo_checked_at" < "blobs"."match_checked_at"');
  });

  it('links the games BEFORE stamping the blob applied', async () => {
    const title = 'Order Matters';
    const row = { sha256: SHA, setName: 'Amiga - Demos', title, year: 1993, publisher: null };
    const candidate = { id: 9, title, titleKey: titleKey(title), releaseYear: 1993, groups: [], supertype: 'production', isGame: false };
    selectResults = [[{ appliedAt: new Date('2026-09-01T00:00:00Z') }], [row], [], [candidate]];

    await demozooMatchPhase(() => 0, 240_000, freshOut());

    expect(events.indexOf('applyAutomaticLink')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('applyAutomaticLink')).toBeLessThan(events.indexOf('update'));
  });

  it('does not read the disk when the TOSEC title decides', async () => {
    const title = 'Tosec Decides';
    const row = { sha256: SHA, setName: 'Amiga - Demos', title, year: 1993, publisher: null };
    const candidate = { id: 9, title, titleKey: titleKey(title), releaseYear: 1993, groups: [], supertype: 'production', isGame: false };
    selectResults = [[{ appliedAt: new Date('2026-09-01T00:00:00Z') }], [row], [{ f: 'Tosec Decides.adf' }], [candidate]];

    const out = freshOut();
    await demozooMatchPhase(() => 0, 240_000, out);

    expect(out.demozooApplied).toBe(1);
    expect(diskStoreRead).not.toHaveBeenCalled();
  });

  it('treats an unreadable disk as having no volume name: the filename suggestion still lands', async () => {
    const title = 'Filename Demo';
    const row = { sha256: SHA, setName: null, title: null, year: null, publisher: null };
    const candidate = { id: 31, title, titleKey: titleKey(title), releaseYear: null, groups: [], supertype: 'production', isGame: false };
    selectResults = [[{ appliedAt: new Date('2026-09-01T00:00:00Z') }], [row], [{ f: 'Filename Demo.adf' }], [candidate]];
    diskStoreRead.mockRejectedValueOnce(new Error('object store unavailable'));

    const out = freshOut();
    const done = await demozooMatchPhase(() => 0, 240_000, out);

    expect(diskStoreRead).toHaveBeenCalledTimes(1);
    expect(done).toBe(true);
    expect(out.demozooSuggested).toBe(1);
    expect(insertCalls.find((c) => c.table === demozooSuggestions)?.values)
      .toEqual([{ sha256: SHA, productionId: 31, source: 'filename' }]);
    const blobUpdate = updateCalls.find((c) => c.table === blobs);
    expect(blobUpdate?.set).toMatchObject({ demozooState: 'suggested', demozooProductionId: null });
  });
});
