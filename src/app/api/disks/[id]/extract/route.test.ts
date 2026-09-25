// Route tests for POST /api/disks/[id]/extract, for the one fork that is
// this route's own logic rather than the decoder's: what happens when the
// ADF this HFE extracts to already has a disks row.
//
// The extracted disk's id is stableId('disk', gameId, sha256-of-the-ADF), and
// disks.id never changes when a disk is edited -- only disks.sha256 moves
// (disk-history/store.ts). So a repeat extract after the ADF was edited lands
// on a row that no longer holds these bytes. onConflictDoNothing used to make
// that a silent 200 naming a disk that is not what was just extracted.
//
// The decoder is faked (its own tests are src/lib/hfe/*.test.ts), and so is
// the DB, in the same hand-written shape files/batch/route.test.ts uses.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { disks } from '@/db/schema/catalog';
import { stableId } from '@/lib/ingest';

const ORG_ID = 'org-1';
const HFE_ID = 'hfe-disk-1';
const GAME_ID = 'game-1';
const HFE_SHA = 'h'.repeat(64);
const ADF = new Uint8Array([1, 2, 3, 4]);
const ADF_SHA = createHash('sha256').update(ADF).digest('hex');
const ADF_ID = stableId('disk', GAME_ID, ADF_SHA);

vi.mock('@/lib/session', () => ({
  requireOrg: () => Promise.resolve({ orgId: ORG_ID, userId: 'user-1', email: 'a@b.test' }),
}));
const diskStorePut = vi.fn(async () => undefined);
vi.mock('@/lib/storage', () => ({
  diskStore: {
    read: async () => new Uint8Array([9]),
    put: diskStorePut,
    storageKey: (sha: string) => `adf/${sha}`,
  },
}));
vi.mock('@/lib/hfe/parse', () => ({ parseHfe: () => ({ ok: true, disk: {} }) }));
vi.mock('@/lib/hfe/extract', () => ({ extractAdf: () => ({ ok: true, adf: ADF }) }));
vi.mock('@/lib/tosec-sweep', () => ({ sweep: vi.fn() }));
vi.mock('next/server', () => ({ after: vi.fn() }));

let selectResults: unknown[][] = [];
const insertCalls: { table: unknown; values: unknown }[] = [];

function fakeDb() {
  const select = () => {
    const result = selectResults.shift() ?? [];
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      limit: () => Promise.resolve(result),
    };
    return chain;
  };
  const insert = (table: unknown) => ({
    values: (values: unknown) => {
      insertCalls.push({ table, values });
      return { onConflictDoNothing: () => Promise.resolve(undefined) };
    },
  });
  const update = () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) });
  return { select, insert, update };
}
vi.mock('@/db', () => ({ getDb: () => fakeDb() }));

const hfeRow = {
  sha256: HFE_SHA, gameId: GAME_ID, diskNo: 1, isBoot: true, imageFormat: 'hfe',
  extractable: true, extractReason: null, tosecName: 'Game (1990).hfe', sourceFilename: null,
};

const post = async () => {
  const { POST } = await import('./route');
  return POST(new Request(`http://test/api/disks/${HFE_ID}/extract`, { method: 'POST' }),
    { params: Promise.resolve({ id: HFE_ID }) });
};

beforeEach(() => {
  vi.clearAllMocks();
  selectResults = [];
  insertCalls.length = 0;
});

describe('POST /api/disks/[id]/extract', () => {
  it('extracts fresh when no row holds the ADF yet', async () => {
    selectResults = [[hfeRow], []];
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ diskId: ADF_ID, sha256: ADF_SHA });
    expect(insertCalls.some((c) => c.table === disks)).toBe(true);
  });

  it('is an idempotent 200 when the row still holds exactly these bytes', async () => {
    selectResults = [[hfeRow], [{ sha256: ADF_SHA }]];
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ diskId: ADF_ID, sha256: ADF_SHA });
  });

  it('answers 409 already_extracted, naming the disk, when that ADF was edited since', async () => {
    selectResults = [[hfeRow], [{ sha256: 'e'.repeat(64) }]];
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'already_extracted', diskId: ADF_ID });
    // Refused before anything is written: no bytes, no blob, no entitlement.
    expect(diskStorePut).not.toHaveBeenCalled();
    expect(insertCalls).toHaveLength(0);
  });
});
