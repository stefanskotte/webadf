// Unit tests for writeExtract's resumable/chunked writes and
// runDemozooCron's fetch step. Kept in a separate file from import.test.ts
// because that file's `@/db` mock deliberately THROWS (nextStep must never
// touch the database) -- these tests need a real, recording fake instead.
//
// Following the mocking convention src/lib/disk-write.test.ts established:
// getDb() is replaced with a narrow fake supporting exactly the chain
// shapes import.ts calls (select/from/where/limit, a count select awaited
// straight off from(), insert/values/onConflictDoUpdate|onConflictDoNothing,
// update/set/where/returning, delete/where, execute) and nothing more. Table identity is checked by reference against the real schema
// module, which is safe to import: a pgTable() call builds metadata only
// and opens no connection.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { demozooProductions, demozooScreenshots, demozooImport } from '@/db/schema/demozoo';
import type { DemozooExtract, DemozooProductionRow, DemozooScreenshotRow } from './extract';
import type { ImportCursor } from './import';

interface RecordedCall {
  op: 'select' | 'count' | 'insert' | 'claim' | 'delete' | 'execute' | 'fetchExport' | 'putBytes';
  table?: unknown;
  values?: unknown;
  where?: unknown;
  query?: unknown;
}

// The cursor read(s), in order; the last one repeats once the queue is down to it.
let cursorResults: unknown[][] = [];
// count(*) of demozoo_productions, as the extract guard reads it.
let productionCount = 0;
// Whether the atomic weekly claim's UPDATE ... RETURNING gets a row back.
let claimWins = true;
const calls: RecordedCall[] = [];

function fakeDb() {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: (where: unknown) => ({
          limit: async (_n: number) => {
            calls.push({ op: 'select', table, where });
            return cursorResults.length > 1 ? cursorResults.shift()! : (cursorResults[0] ?? []);
          },
        }),
        then: <T>(resolve: (v: unknown[]) => T, reject?: (e: unknown) => T) => {
          calls.push({ op: 'count', table });
          return Promise.resolve([{ n: productionCount }]).then(resolve, reject);
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: unknown) => ({
        onConflictDoUpdate: async (_opts: unknown) => {
          calls.push({ op: 'insert', table, values });
        },
        onConflictDoNothing: async () => {
          calls.push({ op: 'insert', table, values });
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (values: unknown) => ({
        where: (where: unknown) => ({
          returning: async () => {
            calls.push({ op: 'claim', table, values, where });
            return claimWins ? [{ id: 1 }] : [];
          },
        }),
      }),
    }),
    delete: (table: unknown) => ({
      where: async (where: unknown) => {
        calls.push({ op: 'delete', table, where });
      },
    }),
    execute: async (query: unknown) => {
      calls.push({ op: 'execute', query });
    },
  };
}

vi.mock('@/db', () => ({ getDb: () => fakeDb() }));
// Never touches real Vercel Blob storage. Each method throws unless a test
// arranges it, so a regression that reached a step the test did not set up
// (say, extract straight after a fetch) fails loudly.
const readStreamMock = vi.fn();
const putBytesMock = vi.fn();
vi.mock('@/lib/storage', () => ({ demozooExportStore: { readStream: readStreamMock, putBytes: putBytesMock } }));

const fetchExportMock = vi.fn();
vi.mock('./fetch-export', () => ({ fetchExport: fetchExportMock }));

// The extract step's parsing is covered by extract.test.ts; here it returns
// whatever extract a test arranges.
let extractResult: DemozooExtract = { productions: [], screenshots: [] };
vi.mock('./lines', () => ({ gzipLines: () => (async function* () {})() }));
vi.mock('./copy', () => ({ readCopyBlocks: () => (async function* () {})() }));
vi.mock('./extract', () => ({ WANTED_TABLES: [], extractAmiga: async () => extractResult }));

const { writeExtract, runDemozooCron, MIN_EXTRACT_PRODUCTIONS } = await import('./import');

beforeEach(() => {
  cursorResults = [];
  productionCount = 0;
  claimWins = true;
  extractResult = { productions: [], screenshots: [] };
  calls.length = 0;
  fetchExportMock.mockReset();
  readStreamMock.mockReset().mockImplementation(async () => { throw new Error('unexpected readStream'); });
  putBytesMock.mockReset().mockImplementation(async () => { calls.push({ op: 'putBytes' }); });
});

function baseCursor(over: Partial<ImportCursor> = {}): ImportCursor {
  return {
    id: 1, step: 'extracted', etag: null, lastModified: null, lastAttemptAt: null, fetchedAt: null,
    runStartedAt: null, productionsWritten: 0, screenshotsWritten: 0, appliedAt: null, ...over,
  };
}

// Chunk size is 250 (PRODUCTION_CHUNK in import.ts). writeExtract refuses an
// extract below MIN_EXTRACT_PRODUCTIONS (50,000), so the fixtures are that
// size plus 10: resume-at-offset and deadline-mid-run still have a real
// partial chunk at the end to interact with.
const FULL = 50_010;
function makeProductions(n: number): DemozooProductionRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: 10_000 + i, title: `Production ${i}`, titleKey: `production ${i}`, releaseYear: 1990,
    supertype: 'production', types: ['Demo'], groups: ['Group'], isGame: false,
  }));
}

function makeScreenshots(n: number): DemozooScreenshotRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: 20_000 + i, productionId: 10_000, standardUrl: `https://example.com/${i}.png`, ordinal: i + 1,
  }));
}

describe('writeExtract — resumable, chunked, stamped writes', () => {
  it('resumes productions from the cursor offset, stamps every row with runStartedAt, and advances the cursor', async () => {
    const stamp = new Date('2026-09-20T00:00:00Z');
    const productions = makeProductions(FULL);
    const cursor = baseCursor({ productionsWritten: 50_000, screenshotsWritten: 0, runStartedAt: stamp });

    const result = await writeExtract({ productions, screenshots: [] }, cursor, () => false);

    expect(result).toBe('done');

    // Only the 10 rows past the cursor's offset are inserted -- not all of them.
    const productionInserts = calls.filter((c) => c.op === 'insert' && c.table === demozooProductions);
    expect(productionInserts).toHaveLength(1);
    const inserted = productionInserts[0].values as Array<{ id: number; importedAt: Date }>;
    expect(inserted.map((r) => r.id)).toEqual(productions.slice(50_000).map((p) => p.id));
    expect(inserted.every((r) => r.importedAt === stamp)).toBe(true);

    // The cursor's offset advances by the chunk that was actually written.
    const cursorSaves = calls.filter((c) => c.op === 'insert' && c.table === demozooImport);
    expect(cursorSaves).toHaveLength(1);
    expect((cursorSaves[0].values as Record<string, unknown>).productionsWritten).toBe(FULL);
  });

  it('stops at the deadline mid-run, returning partial with no deletes or link-clearing', async () => {
    const productions = makeProductions(FULL);
    const cursor = baseCursor({ productionsWritten: 0, screenshotsWritten: 0 });
    // False for the first chunk's check, true from the second chunk onward.
    let deadlineChecks = 0;
    const deadline = () => { deadlineChecks += 1; return deadlineChecks > 1; };

    const result = await writeExtract({ productions, screenshots: [] }, cursor, deadline);

    expect(result).toBe('partial');
    // Only the first (250-row) chunk was written; the rest never ran.
    const productionInserts = calls.filter((c) => c.op === 'insert' && c.table === demozooProductions);
    expect(productionInserts).toHaveLength(1);
    expect((productionInserts[0].values as unknown[]).length).toBe(250);
    expect(calls.filter((c) => c.op === 'delete')).toHaveLength(0);
    expect(calls.filter((c) => c.op === 'execute')).toHaveLength(0);
  });

  it('on completion, deletes stale screenshots and productions and clears both the blob and game links', async () => {
    const cursor = baseCursor({
      productionsWritten: 0, screenshotsWritten: 0, runStartedAt: new Date('2026-09-20T00:00:00Z'),
    });
    const extract: DemozooExtract = { productions: makeProductions(MIN_EXTRACT_PRODUCTIONS), screenshots: makeScreenshots(2) };

    const result = await writeExtract(extract, cursor, () => false);

    expect(result).toBe('done');
    // Screenshots are cleared before productions (the FK direction).
    const deleteCalls = calls.filter((c) => c.op === 'delete');
    expect(deleteCalls.map((c) => c.table)).toEqual([demozooScreenshots, demozooProductions]);
    // Both link-clearing updates ran, blobs before games.
    const executeCalls = calls.filter((c) => c.op === 'execute');
    expect(executeCalls).toHaveLength(2);
    expect(JSON.stringify(executeCalls[0].query)).toContain('blobs');
    expect(JSON.stringify(executeCalls[1].query)).toContain('games');
  });

  it('refuses, before writing or deleting anything, an extract too small to be the catalogue', async () => {
    const cursor = baseCursor({ runStartedAt: new Date('2026-09-20T00:00:00Z') });

    await expect(writeExtract({ productions: [], screenshots: makeScreenshots(2) }, cursor, () => false))
      .rejects.toThrow(/refusing to write/);

    expect(calls.filter((c) => c.op === 'insert' || c.op === 'delete' || c.op === 'execute')).toHaveLength(0);
  });

  it('refuses an extract that would shrink the held catalogue by more than a fifth', async () => {
    productionCount = 78_447;
    const cursor = baseCursor({ runStartedAt: new Date('2026-09-20T00:00:00Z') });

    await expect(writeExtract({ productions: makeProductions(60_000), screenshots: [] }, cursor, () => false))
      .rejects.toThrow(/80% of the 78447 held/);

    expect(calls.filter((c) => c.op === 'insert' || c.op === 'delete' || c.op === 'execute')).toHaveLength(0);
  });
});

describe('runDemozooCron — the fetch step', () => {
  it('claims the week atomically before calling fetchExport, and propagates a fetch failure', async () => {
    fetchExportMock.mockImplementation(async () => {
      calls.push({ op: 'fetchExport' });
      throw new Error('network down');
    });

    await expect(runDemozooCron()).rejects.toThrow('network down');

    // The single row exists before the claim (a no-op after the first run).
    const rowInsert = calls.findIndex((c) => c.op === 'insert' && c.table === demozooImport);
    const claimIndex = calls.findIndex((c) => c.op === 'claim');
    const fetchIndex = calls.findIndex((c) => c.op === 'fetchExport');
    expect(rowInsert).toBeGreaterThanOrEqual(0);
    expect(claimIndex).toBeGreaterThan(rowInsert);
    expect(fetchIndex).toBeGreaterThan(claimIndex);
    expect(calls[claimIndex].table).toBe(demozooImport);
    // ONE conditional statement: it moves last_attempt_at only where a week has passed.
    const claim = new PgDialect().sqlToQuery(calls[claimIndex].where as SQL).sql;
    expect(claim).toContain('"demozoo_import"."last_attempt_at" is null');
    expect(claim).toContain(`"demozoo_import"."last_attempt_at" <= now() - interval '7 days'`);
    expect(Object.keys(calls[claimIndex].values as object)).toEqual(['lastAttemptAt']);
    expect(fetchExportMock).toHaveBeenCalledTimes(1);
  });

  it('makes no request when another invocation already claimed the week', async () => {
    claimWins = false;

    const report = await runDemozooCron();

    expect(fetchExportMock).not.toHaveBeenCalled();
    expect(report.steps).toEqual([{ step: 'fetch', ms: expect.any(Number), detail: expect.stringContaining('not claimed') }]);
  });

  it('makes exactly one fetchExport call and stops when the export is unchanged', async () => {
    fetchExportMock.mockResolvedValue({ status: 'unchanged' });

    const report = await runDemozooCron();

    expect(fetchExportMock).toHaveBeenCalledTimes(1);
    expect(report.steps).toEqual([{ step: 'fetch', ms: expect.any(Number), detail: 'unchanged' }]);
  });

  it('stops after storing a new export: extract gets an invocation of its own', async () => {
    fetchExportMock.mockResolvedValue({ status: 'stored', etag: '"e"', lastModified: null });
    // Were the loop to continue, the next cursor read says 'fetched' -> extract.
    cursorResults = [[], [baseCursor({ step: 'fetched', lastAttemptAt: new Date() })]];

    const report = await runDemozooCron();

    expect(report.steps).toEqual([{ step: 'fetch', ms: expect.any(Number), detail: 'stored' }]);
    expect(readStreamMock).not.toHaveBeenCalled();
    const saved = calls.filter((c) => c.op === 'insert' && c.table === demozooImport).map((c) => c.values as Record<string, unknown>);
    expect(saved.at(-1)).toMatchObject({ step: 'fetched', etag: '"e"' });
  });
});

describe('runDemozooCron — the extract step guard', () => {
  const fetchedCursor = () => baseCursor({ step: 'fetched', lastAttemptAt: new Date() });

  it('refuses an extract with too few productions: step stays fetched, nothing stored, reported', async () => {
    cursorResults = [[fetchedCursor()]];
    readStreamMock.mockResolvedValue(new ReadableStream());
    extractResult = { productions: [], screenshots: [] };

    const report = await runDemozooCron();

    expect(report.steps).toEqual([{ step: 'extract', ms: expect.any(Number), detail: expect.stringMatching(/^refused: .*fewer than 50000/) }]);
    expect(putBytesMock).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.op === 'insert')).toHaveLength(0); // no cursor save: still 'fetched'
  });

  it('refuses an extract below 80% of the productions already held', async () => {
    cursorResults = [[fetchedCursor()]];
    productionCount = 78_447;
    readStreamMock.mockResolvedValue(new ReadableStream());
    extractResult = { productions: makeProductions(60_000), screenshots: [] };

    const report = await runDemozooCron();

    expect(report.steps).toEqual([{ step: 'extract', ms: expect.any(Number), detail: expect.stringMatching(/^refused: .*80% of the 78447 held/) }]);
    expect(putBytesMock).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.op === 'insert')).toHaveLength(0);
  });

  it('advances a sane extract to extracted', async () => {
    // After the extract, the next cursor read is an applied import within the week -> idle.
    cursorResults = [[fetchedCursor()], [baseCursor({ step: 'applied', lastAttemptAt: new Date() })]];
    productionCount = 78_447;
    readStreamMock.mockResolvedValue(new ReadableStream());
    extractResult = { productions: makeProductions(78_300), screenshots: [] };

    const report = await runDemozooCron();

    expect(report.steps).toEqual([{ step: 'extract', ms: expect.any(Number), detail: '78300 productions, 0 screenshots' }]);
    expect(putBytesMock).toHaveBeenCalledTimes(1);
    const saved = calls.filter((c) => c.op === 'insert' && c.table === demozooImport).map((c) => c.values as Record<string, unknown>);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ step: 'extracted' });
  });
});
