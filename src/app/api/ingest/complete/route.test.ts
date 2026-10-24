// Route tests for POST /api/ingest/complete, for the HFE refusal only: what
// becomes of the bytes a refused HFE left in the store.
//
// The client PUTs straight to the store before /complete runs, so a refused
// HFE's bytes are already parked at adf/<sha> with no blobs row -- invisible
// to every scanner and to the teardown's GC, which walks `blobs`. They are
// released at the refusal, but only under the teardown's own rule
// (selectReleasableUploads): no blobs row, disk, entitlement or history may
// name the sha, re-checked at that moment rather than trusted from the start
// of the request.
//
// The v3 fixture is real, and so are inspectHfe and the digest check: the
// refusal is the one the route actually makes, not a stub's. The DB and the
// store are fakes; each select resolves by the table it reads from.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { drizzle as pgProxyDrizzle } from 'drizzle-orm/pg-proxy';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { blobs, disks, entitlements, games } from '@/db/schema/catalog';
import { diskVersions } from '@/db/schema/disk-history';
import { fixture } from '@/lib/hfe/__fixtures__/load';
import { stableId } from '@/lib/ingest';
import { syntheticVolume } from '@/lib/adffs/synthetic';

vi.mock('@/lib/session', () => ({
  requireOrg: () => Promise.resolve({ orgId: 'org-1', userId: 'user-1', email: 'a@b.test' }),
}));
vi.mock('@/lib/tosec-sweep', () => ({ sweep: vi.fn() }));
vi.mock('next/server', () => ({ after: vi.fn() }));

const V3 = fixture('v3');
const V3_SHA = createHash('sha256').update(V3).digest('hex');

const stat = vi.fn(async () => ({ sizeBytes: V3.length }));
const read = vi.fn(async () => V3);
const remove = vi.fn(async () => undefined);
vi.mock('@/lib/storage', () => ({
  diskStore: { stat, read, remove, put: vi.fn(), storageKey: (s: string) => `adf/${s}` },
}));

/** Rows each table answers with, one entry per select against it, in order. */
let byTable: Map<unknown, unknown[][]>;
const selectedFrom: unknown[] = [];
/** Each select's WHERE, by table, kept as real drizzle SQL so it can be rendered. */
const wheres: { table: unknown; where: SQL }[] = [];
/** Every insert: its table and the rows it was given. */
const inserts: { table: unknown; rows: Record<string, unknown>[] }[] = [];
const updates: { table: unknown }[] = [];

// db.delete is a REAL drizzle builder run through pg-proxy (never actually
// executed -- the callback just records the rendered SQL), the same trick
// disk-set-store.test.ts uses: it is the only way to see the NOT EXISTS
// guard on the games delete in the statement's own shape, not by running it.
const deleteCalls: { sql: string; params: unknown[] }[] = [];
const deleteProxy = pgProxyDrizzle(async (sql, params) => {
  deleteCalls.push({ sql, params });
  return { rows: [] };
});

function fakeDb() {
  const select = () => {
    let table: unknown;
    let joined = false;
    const chain = {
      from: (t: unknown) => { table = t; selectedFrom.push(t); return chain; },
      // The closing read of each disk's title (disks JOIN games): not part of what these tests queue or count.
      innerJoin: () => { joined = true; return chain; },
      where: (w: SQL) => {
        if (joined) return Promise.resolve([]);
        wheres.push({ table, where: w });
        const rows = byTable.get(table)?.shift() ?? [];
        return Promise.resolve(rows);
      },
    };
    return chain;
  };
  const insert = (table: unknown) => ({
    values: (rows: Record<string, unknown>[]) => {
      inserts.push({ table, rows });
      return { onConflictDoNothing: () => Promise.resolve(undefined), onConflictDoUpdate: () => Promise.resolve(undefined) };
    },
  });
  const update = (table: unknown) => {
    updates.push({ table });
    return { set: () => ({ where: () => Promise.resolve(undefined) }) };
  };
  return { select, selectDistinct: select, insert, update, delete: deleteProxy.delete.bind(deleteProxy) };
}
vi.mock('@/db', () => ({ getDb: () => fakeDb() }));

const complete = async () => {
  const { POST } = await import('./route');
  return POST(new Request('http://test/api/ingest/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files: [{ sha256: V3_SHA, sizeBytes: V3.length, filename: 'V3 Disk.hfe' }] }),
  }));
};

beforeEach(() => {
  vi.clearAllMocks();
  byTable = new Map();
  selectedFrom.length = 0;
  deleteCalls.length = 0;
  wheres.length = 0;
  inserts.length = 0;
  updates.length = 0;
});

describe('POST /api/ingest/complete: a refused HFE', () => {
  it('is refused with its reason, and its bytes are released when nothing names them', async () => {
    const res = await complete();
    expect(res.status).toBe(409);
    expect((await res.json()).rejectedReasons[V3_SHA]).toMatch(/^HFE v3 isn't supported yet/);
    expect(remove).toHaveBeenCalledWith(V3_SHA);
    // Every reference the teardown's rule consults was actually asked.
    for (const t of [blobs, disks, entitlements, diskVersions]) expect(selectedFrom).toContain(t);
  });

  it('keeps the bytes of a dedupe hit: a blobs row already names them', async () => {
    byTable.set(blobs, [[{ sha256: V3_SHA }]]);
    const res = await complete();
    expect(res.status).toBe(409);
    expect(remove).not.toHaveBeenCalled();
  });

  it('keeps the bytes when a reference appeared after the request started', async () => {
    // Unregistered at the start (so verify() read them), but by the time of
    // the refusal another request has entitled an org to these exact bytes.
    byTable.set(entitlements, [[{ sha256: V3_SHA }]]);
    await complete();
    expect(remove).not.toHaveBeenCalled();
  });

  it('keeps the bytes when a disk history names them', async () => {
    byTable.set(diskVersions, [[{ blob: 'x'.repeat(64), image: V3_SHA }]]);
    await complete();
    expect(remove).not.toHaveBeenCalled();
  });

  it('keeps the bytes when a blobs row appeared after the request started', async () => {
    // First blobs select: the start-of-request lookup (nothing). Second: the
    // re-check at the refusal, which now finds a row.
    byTable.set(blobs, [[], [{ sha256: V3_SHA }]]);
    await complete();
    expect(remove).not.toHaveBeenCalled();
  });
});

// Disk sets spec P4 / Task 6 controller ruling 3: a disk already moved into a
// set keeps its id (stableId of its ORIGINAL game), so re-uploading it
// re-creates that original game row, with no disks. The route must delete
// it. Reuses the V3 bytes/hash above under a plain .adf name, which is not
// an HFE and so lands normally (not refused).
describe('POST /api/ingest/complete: a game this call inserted with no disks', () => {
  const completeAdf = async () => {
    const { POST } = await import('./route');
    return POST(new Request('http://test/api/ingest/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: [{ sha256: V3_SHA, sizeBytes: V3.length, filename: 'SomeGame.adf' }] }),
    }));
  };

  it('is deleted at the end, guarded so only a game left with none is touched', async () => {
    const res = await completeAdf();
    expect(res.status).toBe(200);
    expect((await res.json()).created).toBe(1);

    expect(deleteCalls).toHaveLength(1);
    const [{ sql, params }] = deleteCalls;
    expect(sql).toMatch(/delete from "games"/);
    // The guard itself: it must be there, or a title that still holds a disk
    // (org_id drift aside) could be deleted by this statement.
    expect(sql).toMatch(/not exists \(select 1 from disks d where d\.game_id = "games"\."id"\)/);

    const gameId = stableId('game', 'org-1', 'somegame', '');
    expect(params).toContain(gameId);
    expect(params).toContain('org-1');
  });

  it('is not called at all when nothing was inserted', async () => {
    // Rejected (HFE v3): landed.length === 0, so the route returns before
    // ever building gameRows -- no delete should be issued.
    await complete();
    expect(deleteCalls).toHaveLength(0);
  });
});

// Final review I1: a person-arranged set keeps its target's ORIGINAL
// deterministic game id, so a later upload parsing to the same title/year
// would otherwise land inside it at its parsed disk number.
describe('POST /api/ingest/complete: an upload whose title is a human-arranged set', () => {
  const dialect = new PgDialect();
  const upload = async (filename: string) => {
    const { POST } = await import('./route');
    return POST(new Request('http://test/api/ingest/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: [{ sha256: V3_SHA, sizeBytes: V3.length, filename }] }),
    }));
  };
  const rowsInto = (t: unknown) => inserts.filter((i) => i.table === t).flatMap((i) => i.rows);
  const setId = stableId('game', 'org-1', 'somegame', '');

  it('goes to a fresh one-disk title beside the set; nothing is inserted into the set', async () => {
    byTable.set(games, [[{ id: setId }]]);   // the parsed id exists, arranged by a person
    byTable.set(disks, [[]]);                 // this disk is not already in it
    const res = await upload('SomeGame (Disk 2 of 3).adf');
    expect(res.status).toBe(200);

    // The human-set lookup is org-scoped and asks for disk_order_source = 'human'.
    const q = dialect.sqlToQuery(wheres.find((w) => w.table === games)!.where);
    expect(q.sql).toMatch(/"games"\."org_id" = \$\d+/);
    expect(q.sql).toMatch(/"games"\."disk_order_source" = \$\d+/);
    expect(q.params).toEqual(expect.arrayContaining([setId, 'org-1', 'human']));

    const fresh = stableId('game', 'org-1', 'somegame', '', 'beside-set', V3_SHA);
    expect(rowsInto(games)).toEqual([expect.objectContaining({
      id: fresh, orgId: 'org-1', title: 'SomeGame', sortTitle: 'somegame', year: null, metadataSource: 'filename',
    })]);
    expect(rowsInto(disks)).toEqual([expect.objectContaining({
      id: stableId('disk', fresh, V3_SHA), gameId: fresh, diskNo: 1, sha256: V3_SHA,
    })]);
    expect(rowsInto(disks).some((r) => r.gameId === setId)).toBe(false);
    expect(rowsInto(games).some((r) => r.id === setId)).toBe(false);
    // The set is not even a candidate for the empty-title cleanup.
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].params).not.toContain(setId);
  });

  it('a re-send of a disk already in the set stays a no-op: no new title, no insert', async () => {
    byTable.set(games, [[{ id: setId }]]);
    byTable.set(disks, [[{ id: stableId('disk', setId, V3_SHA) }]]);
    const res = await upload('SomeGame.adf');
    expect(res.status).toBe(200);
    expect(rowsInto(games)).toEqual([]);
    expect(rowsInto(disks)).toEqual([]);
    expect(updates.filter((u) => u.table === disks)).toEqual([]);
    expect(deleteCalls).toHaveLength(0);
  });

  it('an ordinary (not human-arranged) title lands where it always did', async () => {
    byTable.set(games, [[]]);
    const res = await upload('SomeGame (Disk 2 of 3).adf');
    expect(res.status).toBe(200);
    expect(rowsInto(games)).toEqual([expect.objectContaining({ id: setId, metadataSource: 'filename' })]);
    expect(rowsInto(disks)).toEqual([expect.objectContaining({
      id: stableId('disk', setId, V3_SHA), gameId: setId, diskNo: 2,
    })]);
    // No disk lookup is spent when no human set is involved.
    expect(wheres.filter((w) => w.table === disks)).toHaveLength(0);
  });
});

describe('POST /api/ingest/complete: a new ADF keeps its AmigaDOS volume name as its label', () => {
  // The board prints "Disk n/c <label>"; the volume name is read here because
  // a first registration already holds the bytes (field report 2026-10-17).
  const ADF = syntheticVolume({ volumeName: 'Locale3.2' });
  const ADF_SHA = createHash('sha256').update(ADF).digest('hex');
  const upload = async () => {
    const { POST } = await import('./route');
    return POST(new Request('http://test/api/ingest/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: [{ sha256: ADF_SHA, sizeBytes: ADF.length, filename: 'Workbench 3.2 (Disk 5 of 13).adf' }] }),
    }));
  };
  const diskRows = () => inserts.filter((i) => i.table === disks).flatMap((i) => i.rows);

  it('stores the volume name on the disk row it creates', async () => {
    stat.mockResolvedValueOnce({ sizeBytes: ADF.length });
    read.mockResolvedValueOnce(ADF);
    expect((await upload()).status).toBe(200);
    expect(diskRows()).toEqual([expect.objectContaining({ label: 'Locale3.2', diskNo: 5 })]);
  });

  it('a dedupe hit is not read back just for a name: no label, the board falls back to the file name', async () => {
    byTable.set(blobs, [[{ sha256: ADF_SHA }]]);
    stat.mockResolvedValueOnce({ sizeBytes: ADF.length });
    expect((await upload()).status).toBe(200);
    expect(read).not.toHaveBeenCalled();
    expect(diskRows()[0].label).toBeUndefined();
  });
});
