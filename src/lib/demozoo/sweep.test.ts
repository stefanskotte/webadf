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
import { blobs } from '@/db/schema/catalog';
import { demozooSuggestions } from '@/db/schema/demozoo';
import type { SweepResult } from '@/lib/tosec-sweep';
import { titleKey } from './title-key';

const diskStoreRead = vi.fn();
vi.mock('@/lib/storage', () => ({ diskStore: { read: diskStoreRead } }));

const applyAutomaticLinkMock = vi.fn();
vi.mock('./apply', () => ({ applyAutomaticLink: applyAutomaticLinkMock }));

let selectResults: unknown[][] = [];
const insertCalls: Array<{ table: unknown; values: unknown }> = [];
const updateCalls: Array<{ table: unknown; set: unknown }> = [];
const deleteCalls: Array<{ table: unknown }> = [];

function fakeDb() {
  const select = () => {
    const result = selectResults.shift() ?? [];
    const chain: {
      from: () => typeof chain;
      leftJoin: () => typeof chain;
      where: () => typeof chain;
      limit: () => Promise<unknown[]>;
      then: <T>(resolve: (v: unknown[]) => T, reject?: (e: unknown) => T) => Promise<T>;
    } = {
      from: () => chain,
      leftJoin: () => chain,
      where: () => chain,
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
      updateCalls.push({ table, set: values });
      return { where: () => Promise.resolve(undefined) };
    },
  });
  const del = (table: unknown) => {
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

  it('on a per-blob failure, stamps that blob none and clears suggestions without aborting the batch', async () => {
    const badRow = { sha256: 'b'.repeat(64), setName: 'Amiga - Demos', title: 'Broken Disk', year: 1990, publisher: null };
    const goodRow = { sha256: 'c'.repeat(64), setName: 'Amiga - Games - [ADF]', title: 'A Game', year: 1990, publisher: null };
    selectResults = [
      [{ appliedAt: new Date('2026-09-01T00:00:00Z') }], // cursor
      [badRow, goodRow],                                  // todo batch
      [{ f: 'Broken.adf' }],                               // entitlements for badRow
      [],                                                   // demozooProductions for goodRow (game set)
    ];
    diskStoreRead.mockRejectedValueOnce(new Error('object store unavailable'));

    const out = freshOut();
    const done = await demozooMatchPhase(() => 0, 240_000, out);

    expect(done).toBe(true);
    // The failing blob: caught, suggestions cleared, stamped none.
    expect(out.demozooNone).toBe(1);
    // The next blob in the same batch still ran to completion.
    expect(out.demozooSkippedGame).toBe(1);

    const blobUpdates = updateCalls.filter((c) => c.table === blobs);
    expect(blobUpdates).toHaveLength(2);
    const badUpdate = blobUpdates.find((c) => (c.set as { demozooState: string }).demozooState === 'none');
    expect(badUpdate).toBeDefined();
    const goodUpdate = blobUpdates.find((c) => (c.set as { demozooState: string }).demozooState === 'skipped_game');
    expect(goodUpdate).toBeDefined();

    expect(deleteCalls.filter((c) => c.table === demozooSuggestions)).toHaveLength(2);
  });
});
