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
import { blobs, disks, entitlements } from '@/db/schema/catalog';
import { diskVersions } from '@/db/schema/disk-history';
import { fixture } from '@/lib/hfe/__fixtures__/load';

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

function fakeDb() {
  const select = () => {
    let table: unknown;
    const chain = {
      from: (t: unknown) => { table = t; selectedFrom.push(t); return chain; },
      where: () => {
        const rows = byTable.get(table)?.shift() ?? [];
        return Promise.resolve(rows);
      },
    };
    return chain;
  };
  const insert = () => ({ values: () => ({ onConflictDoNothing: () => Promise.resolve(undefined) }) });
  const update = () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) });
  return { select, selectDistinct: select, insert, update };
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
