// Unit tests for writeExtract's resumable/chunked writes and
// runDemozooCron's fetch step. Kept in a separate file from import.test.ts
// because that file's `@/db` mock deliberately THROWS (nextStep must never
// touch the database) -- these tests need a real, recording fake instead.
//
// Following the mocking convention src/lib/disk-write.test.ts established:
// getDb() is replaced with a narrow fake supporting exactly the chain
// shapes import.ts calls (select/from/where/limit,
// insert/values/onConflictDoUpdate, delete/where, execute) and nothing
// more. Table identity is checked by reference against the real schema
// module, which is safe to import: a pgTable() call builds metadata only
// and opens no connection.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { demozooProductions, demozooScreenshots, demozooImport } from '@/db/schema/demozoo';
import type { DemozooExtract, DemozooProductionRow, DemozooScreenshotRow } from './extract';
import type { ImportCursor } from './import';

interface RecordedCall {
  op: 'select' | 'insert' | 'delete' | 'execute' | 'fetchExport';
  table?: unknown;
  values?: unknown;
  where?: unknown;
  query?: unknown;
}

let selectResult: unknown[] = [];
const calls: RecordedCall[] = [];

function fakeDb() {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: (where: unknown) => ({
          limit: async (_n: number) => {
            calls.push({ op: 'select', table, where });
            return selectResult;
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: unknown) => ({
        onConflictDoUpdate: async (_opts: unknown) => {
          calls.push({ op: 'insert', table, values });
        },
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
// Not exercised by any test below (cursor is always null -> step 'fetch'
// only), but mocked anyway so a regression that reached the extract/write
// steps would fail loudly instead of touching real Vercel Blob storage.
vi.mock('@/lib/storage', () => ({ demozooExportStore: {} }));

const fetchExportMock = vi.fn();
vi.mock('./fetch-export', () => ({ fetchExport: fetchExportMock }));

const { writeExtract, runDemozooCron } = await import('./import');

beforeEach(() => {
  selectResult = [];
  calls.length = 0;
  fetchExportMock.mockReset();
});

function baseCursor(over: Partial<ImportCursor> = {}): ImportCursor {
  return {
    id: 1, step: 'extracted', etag: null, lastModified: null, lastAttemptAt: null, fetchedAt: null,
    runStartedAt: null, productionsWritten: 0, screenshotsWritten: 0, appliedAt: null, ...over,
  };
}

// Chunk size is 250 (PRODUCTION_CHUNK in import.ts); 260 rows cross that
// boundary so resume-at-offset and deadline-mid-run both have a real second
// chunk to interact with.
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
    const productions = makeProductions(260);
    const cursor = baseCursor({ productionsWritten: 250, screenshotsWritten: 0, runStartedAt: stamp });

    const result = await writeExtract({ productions, screenshots: [] }, cursor, () => false);

    expect(result).toBe('done');

    // Only the 10 rows past the cursor's offset are inserted -- not all 260.
    const productionInserts = calls.filter((c) => c.op === 'insert' && c.table === demozooProductions);
    expect(productionInserts).toHaveLength(1);
    const inserted = productionInserts[0].values as Array<{ id: number; importedAt: Date }>;
    expect(inserted.map((r) => r.id)).toEqual(productions.slice(250).map((p) => p.id));
    expect(inserted.every((r) => r.importedAt === stamp)).toBe(true);

    // The cursor's offset advances by the chunk that was actually written.
    const cursorSaves = calls.filter((c) => c.op === 'insert' && c.table === demozooImport);
    expect(cursorSaves).toHaveLength(1);
    expect((cursorSaves[0].values as Record<string, unknown>).productionsWritten).toBe(260);
  });

  it('stops at the deadline mid-run, returning partial with no deletes or link-clearing', async () => {
    const productions = makeProductions(260);
    const cursor = baseCursor({ productionsWritten: 0, screenshotsWritten: 0 });
    // False for the first chunk's check, true from the second chunk onward.
    let deadlineChecks = 0;
    const deadline = () => { deadlineChecks += 1; return deadlineChecks > 1; };

    const result = await writeExtract({ productions, screenshots: [] }, cursor, deadline);

    expect(result).toBe('partial');
    // Only the first (250-row) chunk was written; the second (10-row) chunk
    // never ran.
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
    const extract: DemozooExtract = { productions: makeProductions(3), screenshots: makeScreenshots(2) };

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
});

describe('runDemozooCron — the fetch step', () => {
  it('stamps lastAttemptAt before calling fetchExport, and propagates a fetch failure', async () => {
    fetchExportMock.mockImplementation(async () => {
      calls.push({ op: 'fetchExport' });
      throw new Error('network down');
    });

    await expect(runDemozooCron()).rejects.toThrow('network down');

    const saveIndex = calls.findIndex((c) => c.op === 'insert' && c.table === demozooImport);
    const fetchIndex = calls.findIndex((c) => c.op === 'fetchExport');
    expect(saveIndex).toBeGreaterThanOrEqual(0);
    expect(fetchIndex).toBeGreaterThan(saveIndex);
    expect((calls[saveIndex].values as Record<string, unknown>).lastAttemptAt).toBeInstanceOf(Date);
    expect(fetchExportMock).toHaveBeenCalledTimes(1);
  });

  it('makes exactly one fetchExport call and stops when the export is unchanged', async () => {
    fetchExportMock.mockResolvedValue({ status: 'unchanged' });

    const report = await runDemozooCron();

    expect(fetchExportMock).toHaveBeenCalledTimes(1);
    expect(report.steps).toEqual([{ step: 'fetch', ms: expect.any(Number), detail: 'unchanged' }]);
  });
});
