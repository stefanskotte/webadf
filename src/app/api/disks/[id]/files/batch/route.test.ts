// Route tests for POST /api/disks/[id]/files/batch, following the mocking
// convention src/lib/disk-write.test.ts established: @/db and @/lib/storage
// are hand-written fakes, not this repo's real Neon client, and every
// `.where(...)` condition is captured and rendered back to real SQL with
// drizzle's PgDialect.sqlToQuery() so an assertion proves the QUERY rather
// than merely the outcome a lenient fake could produce regardless of it.
//
// applyDiskEdit itself is NOT mocked: this route earns its 409-when-mounted
// refusal and its 404-never-403 tenancy boundary by calling the real thing,
// so a test that stubbed applyDiskEdit out would prove nothing about that
// inheritance -- exactly the reasoning disk-write.test.ts's own header
// gives for not reshaping the module under test to fit a double.
//
// The disk bytes themselves are real: `syntheticVolume` builds a genuine
// (if tiny) 880K AmigaDOS image, so `readVolume`/`readUsage`/`applyBatch`
// inside the route run against structured bytes a real Amiga could mount,
// not an arbitrary Uint8Array a lenient reader might accept by accident.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { syntheticVolume } from '@/lib/adffs/synthetic';
import { readVolume, readUsage, blocksForPlan } from '@/lib/adffs';

const dialect = new PgDialect();
function renderWhere(cond: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(cond as SQL);
}

const diskStoreRead = vi.fn();
const diskStorePut = vi.fn();
const diskStoreRemove = vi.fn();
const diskStoreStorageKey = vi.fn((sha: string) => `adf/${sha}`);

vi.mock('@/lib/storage', () => ({
  diskStore: {
    read: diskStoreRead,
    put: diskStorePut,
    remove: diskStoreRemove,
    storageKey: diskStoreStorageKey,
  },
}));

// The history store is the only writer of a disk's new image (it stores the
// blob and entitlement, records the version and repoints disks.sha256), so
// it is where this route's write lands. Faked here, answering with the real
// digest of the bytes it was handed; its own DB work is proven end to end by
// e2e/disk-history.spec.ts.
const recordVersion = vi.fn(async (input: { next: Uint8Array }) => ({
  sha256: createHash('sha256').update(input.next).digest('hex'),
  seq: 1, kind: 'delta' as const, sectorCount: 1,
}));
vi.mock('@/lib/disk-history/store', () => ({ recordVersion }));

const ORG_ID = 'org-1';

// A bare, narrow session fake -- this route only ever reads `orgId` off it.
vi.mock('@/lib/session', () => ({
  requireOrg: () => Promise.resolve({ orgId: ORG_ID, userId: 'user-1', email: 'a@b.test' }),
}));

let selectResults: unknown[][] = [];
const insertCalls: { table: unknown; values: unknown }[] = [];
const updateCalls: { table: unknown; set: unknown }[] = [];
// One entry per `.select(...)` call, in call order: this route's own
// pre-flight lookup first, then -- only if that lookup found a disk and the
// capacity check passed -- applyDiskEdit's disk lookup and its device-holder
// check.
const whereConditions: unknown[] = [];

/**
 * A fake NeonHttpDatabase, identical in shape to disk-write.test.ts's own:
 * exactly the chain shapes this route and applyDiskEdit call
 * (select/from/innerJoin/where/limit, insert/values/onConflictDoNothing,
 * update/set/where) and nothing more.
 */
function fakeDb() {
  const select = () => {
    const result = selectResults.shift() ?? [];
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: (cond: unknown) => { whereConditions.push(cond); return chain; },
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
  const update = (table: unknown) => ({
    set: (values: unknown) => {
      updateCalls.push({ table, set: values });
      return { where: () => Promise.resolve(undefined) };
    },
  });
  return { select, insert, update };
}

vi.mock('@/db', () => ({ getDb: () => fakeDb() }));

const DISK_ID = 'disk-1';
const OLD_SHA = 'a'.repeat(64);

/** A fresh, empty 880K FFS volume -- a real image, not a stand-in. */
function emptyDisk(): Uint8Array {
  return syntheticVolume({ filesystem: 'FFS', volumeName: 'BatchVol' });
}

/** Builds the exact multipart body this route parses: a `manifest` part plus one File part per path in `files`. */
function makeRequest(manifest: unknown[], files: Record<string, Uint8Array> = {}): Request {
  const form = new FormData();
  form.append('manifest', JSON.stringify(manifest));
  for (const [path, bytes] of Object.entries(files)) {
    form.append(path, new File([bytes as BlobPart], path.split('/').pop() ?? path));
  }
  return new Request(`http://test/api/disks/${DISK_ID}/files/batch`, { method: 'POST', body: form });
}

beforeEach(() => {
  vi.clearAllMocks();
  diskStoreStorageKey.mockImplementation((sha: string) => `adf/${sha}`);
  selectResults = [];
  insertCalls.length = 0;
  updateCalls.length = 0;
  whereConditions.length = 0;
});

describe('POST /api/disks/[id]/files/batch', () => {
  it('refuses a batch that does not fit BEFORE applyDiskEdit is ever called, naming both numbers', async () => {
    const adf = emptyDisk();
    selectResults = [[{ sha256: OLD_SHA }]]; // this route's own pre-flight lookup, ONLY
    diskStoreRead.mockResolvedValue(adf);

    // 1800 data blocks: costed the same way blocksForPlan itself does,
    // recomputed here independently rather than trusted from the route.
    const huge = new Uint8Array(1800 * 512);
    const expectedBlocks = blocksForPlan([{ kind: 'file', sizeBytes: huge.length }], 'FFS');
    const expectedFree = readUsage(adf)!.freeBlocks;
    expect(expectedBlocks).toBeGreaterThan(expectedFree); // sanity: the fixture really doesn't fit

    const { POST } = await import('./route');
    const request = makeRequest([{ op: 'add', path: 'huge.bin' }], { 'huge.bin': huge });
    const response = await POST(request, { params: Promise.resolve({ id: DISK_ID }) });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.reason).toBe('disk-full');
    expect(body.blocksNeeded).toBe(expectedBlocks);
    expect(body.freeBlocks).toBe(expectedFree);

    // THE REFUSAL THAT NEVER STARTED: only one `.select(...)` happened at
    // all (this route's own lookup) -- applyDiskEdit's disk lookup and
    // device-holder check never ran, and nothing was ever written.
    expect(whereConditions).toHaveLength(1);
    expect(diskStoreRead).toHaveBeenCalledTimes(1);
    expect(diskStorePut).not.toHaveBeenCalled();
    expect(recordVersion).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(0);
  });

  it('returns 404, never 403, for a disk outside this org', async () => {
    selectResults = [[]]; // the org-scoped join finds nothing
    diskStoreRead.mockResolvedValue(emptyDisk());

    const { POST } = await import('./route');
    const request = makeRequest([{ op: 'mkdir', path: 'C' }]);
    const response = await POST(request, { params: Promise.resolve({ id: DISK_ID }) });

    expect(response.status).toBe(404);
    expect(diskStoreRead).not.toHaveBeenCalled();

    // PROVES the org scoping, not just the 404 shape -- a lookup scoped by
    // disks.id alone would still hit this queued empty result and produce
    // the identical 404.
    expect(whereConditions).toHaveLength(1);
    const lookup = renderWhere(whereConditions[0]);
    expect(lookup.sql).toContain('"disks"."org_id"');
    expect(lookup.sql).toContain('"disks"."id"');
    expect(lookup.params).toEqual(expect.arrayContaining([ORG_ID, DISK_ID]));
  });

  it('refuses with 409 when a device has the disk mounted, naming it', async () => {
    const adf = emptyDisk();
    selectResults = [
      [{ sha256: OLD_SHA }], // this route's own pre-flight lookup
      [{ sha256: OLD_SHA, tosecName: 'Game.adf', sourceFilename: 'Game.adf' }], // applyDiskEdit's disk lookup
      [{ name: 'Amiga 500 #1' }], // a device holding it, mounted or desired
    ];
    diskStoreRead.mockResolvedValue(adf);

    const { POST } = await import('./route');
    const request = makeRequest([{ op: 'mkdir', path: 'C' }]);
    const response = await POST(request, { params: Promise.resolve({ id: DISK_ID }) });

    expect(response.status).toBe(409);
    const body = await response.json();
    // Named, so the operator knows where to eject it from.
    expect(body.reason).toContain('Amiga 500 #1');
    expect(diskStorePut).not.toHaveBeenCalled();
    expect(recordVersion).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(0);

    // PROVES both mount columns are checked (D-W-4), the same reasoning
    // disk-write.test.ts uses for applyDiskEdit's own device-holder query.
    expect(whereConditions).toHaveLength(3);
    const holderCheck = renderWhere(whereConditions[2]);
    expect(holderCheck.sql).toContain('"devices"."mounted_sha256"');
    expect(holderCheck.sql).toContain('"devices"."desired_sha256"');
    expect(holderCheck.sql).toContain('"devices"."org_id"');
    expect(holderCheck.params).toEqual(expect.arrayContaining([ORG_ID, OLD_SHA]));
  });

  it('commits a batch that fits, recording it through the history store', async () => {
    const adf = emptyDisk();
    selectResults = [
      [{ sha256: OLD_SHA }],
      [{ sha256: OLD_SHA, tosecName: 'Game.adf', sourceFilename: 'Game.adf' }],
      [], // no device holds it
    ];
    diskStoreRead.mockResolvedValue(adf);

    const { POST } = await import('./route');
    // Deliberately CHILD-FIRST in the manifest: the route, not applyBatch
    // (which applies ops exactly as given), is responsible for sorting by
    // path depth so the parent is created before the child that names it.
    const request = makeRequest(
      [
        { op: 'add', path: 'C/Assign' },
        { op: 'mkdir', path: 'C' },
      ],
      { 'C/Assign': new TextEncoder().encode('assign') },
    );
    const response = await POST(request, { params: Promise.resolve({ id: DISK_ID }) });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.id).toBe(DISK_ID);
    expect(body.sha256).not.toBe(OLD_SHA);

    // The write goes through the history store, exactly once, as a browser
    // edit on top of the digest the disk pointed at -- the store, not this
    // route, repoints disks.sha256 (never disks.id) and inserts the new
    // blob and entitlement.
    expect(recordVersion).toHaveBeenCalledTimes(1);
    expect(recordVersion).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_ID, diskId: DISK_ID, headSha: OLD_SHA, head: adf,
      source: 'browser', userId: 'user-1',
    }));
    expect(updateCalls).toHaveLength(0);
    expect(insertCalls).toHaveLength(0);

    // Prove the OUTCOME, not just the response shape: the bytes actually
    // handed to the history store really contain the tree the manifest asked
    // for, with the child correctly resolved under the parent the SAME
    // batch created despite arriving first in the manifest.
    const written = recordVersion.mock.calls[0][0].next;
    expect(body.sha256).toBe(createHash('sha256').update(written).digest('hex'));
    const volume = readVolume(written);
    expect(volume.ok).toBe(true);
    if (!volume.ok) return;
    expect(volume.root.map((e) => e.name)).toEqual(['C']);
    expect(volume.root[0].children.map((e) => e.name)).toEqual(['Assign']);
  });

  it('rejects a manifest whose add/replace entry has no matching file part', async () => {
    selectResults = []; // never reached -- the request is malformed up front
    const { POST } = await import('./route');
    const request = makeRequest([{ op: 'add', path: 'orphan.txt' }]); // no file part supplied

    const response = await POST(request, { params: Promise.resolve({ id: DISK_ID }) });

    expect(response.status).toBe(400);
    expect(whereConditions).toHaveLength(0);
    expect(diskStoreRead).not.toHaveBeenCalled();
  });
});
