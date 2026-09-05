// Route tests for PATCH /api/disks/[id]/files/[block]'s `toParent` (move)
// branch -- following the exact mocking convention
// ../batch/route.test.ts already established: @/db and @/lib/storage are
// hand-written fakes, not this repo's real Neon client, and applyDiskEdit
// itself is NOT mocked, so a 400/409/200 here is earned by the real thing.
//
// This file exists for the reviewer's Finding 4: the PATCH route used to
// pass the raw client `toParent` number straight into `moveEntry` without
// ever resolving it through the PARSED tree the way GET and DELETE resolve
// the block they act on. `moveEntry` itself gained its own T_HEADER +
// checksum check on the destination as a second, independent defense
// (write.test.ts's own "refuses a bogus destination block" test covers
// that layer); this file proves the ROUTE's layer -- a `toParent` that
// never appears in `readVolume`'s parsed tree at all is refused before
// `moveEntry` is even called.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { syntheticVolume } from '@/lib/adffs/synthetic';
import { readVolume } from '@/lib/adffs';
import { addFile, makeDirectory } from '@/lib/adffs/write';

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

const ORG_ID = 'org-1';

vi.mock('@/lib/session', () => ({
  requireOrg: () => Promise.resolve({ orgId: ORG_ID, userId: 'user-1', email: 'a@b.test' }),
}));

let selectResults: unknown[][] = [];
const updateCalls: { table: unknown; set: unknown }[] = [];

/**
 * The same narrow fake ../batch/route.test.ts uses: exactly the chain
 * shapes applyDiskEdit calls (select/from/innerJoin/where/limit,
 * insert/values/onConflictDoNothing, update/set/where) and nothing more.
 * This route makes no `.select(...)` calls of its own -- both queued
 * results here belong to applyDiskEdit: its disk lookup, then its
 * device-holder check.
 */
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
  const insert = () => ({
    values: () => ({ onConflictDoNothing: () => Promise.resolve(undefined) }),
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

function moveRequest(block: number, toParent: number): Request {
  return new Request(`http://test/api/disks/${DISK_ID}/files/${block}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ toParent }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  diskStoreStorageKey.mockImplementation((sha: string) => `adf/${sha}`);
  selectResults = [];
  updateCalls.length = 0;
});

describe('PATCH /api/disks/[id]/files/[block] -- move (toParent)', () => {
  it('moves a file into a real directory already on the disk', async () => {
    let adf = syntheticVolume({ filesystem: 'FFS', volumeName: 'MoveVol' });
    const dir = makeDirectory(adf, 880, 'Docs');
    if (!dir.ok) throw new Error('mkdir');
    adf = dir.adf;
    const added = addFile(adf, 880, 'note.txt', new Uint8Array([1]));
    if (!added.ok) throw new Error('add');
    adf = added.adf;

    const v0 = readVolume(adf);
    if (!v0.ok) throw new Error('read');
    const dirBlock = v0.root.find((e) => e.name === 'Docs')!.block;
    const fileBlock = v0.root.find((e) => e.name === 'note.txt')!.block;

    selectResults = [
      [{ sha256: OLD_SHA, tosecName: 'Game.adf', sourceFilename: 'Game.adf' }], // applyDiskEdit's disk lookup
      [], // no device holds it
    ];
    diskStoreRead.mockResolvedValue(adf);

    const { PATCH } = await import('./route');
    const response = await PATCH(
      moveRequest(fileBlock, dirBlock),
      { params: Promise.resolve({ id: DISK_ID, block: String(fileBlock) }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.sha256).not.toBe(OLD_SHA);

    const written = diskStorePut.mock.calls[0][1] as Uint8Array;
    const v1 = readVolume(written);
    if (!v1.ok) throw new Error('read after move');
    expect(v1.root.map((e) => e.name)).toEqual(['Docs']);
    expect(v1.root[0].children.map((e) => e.name)).toEqual(['note.txt']);
  });

  it('refuses a toParent that names an existing FILE, not a directory', async () => {
    let adf = syntheticVolume({ filesystem: 'FFS', volumeName: 'MoveVol' });
    const asFile = addFile(adf, 880, 'not-a-dir.txt', new Uint8Array([1]));
    if (!asFile.ok) throw new Error('add');
    adf = asFile.adf;
    const toMove = addFile(adf, 880, 'move.txt', new Uint8Array([2]));
    if (!toMove.ok) throw new Error('add 2');
    adf = toMove.adf;

    const v0 = readVolume(adf);
    if (!v0.ok) throw new Error('read');
    const fileAsDestBlock = v0.root.find((e) => e.name === 'not-a-dir.txt')!.block;
    const moveBlock = v0.root.find((e) => e.name === 'move.txt')!.block;

    selectResults = [
      [{ sha256: OLD_SHA, tosecName: 'Game.adf', sourceFilename: 'Game.adf' }],
      [],
    ];
    diskStoreRead.mockResolvedValue(adf);

    const { PATCH } = await import('./route');
    const response = await PATCH(
      moveRequest(moveBlock, fileAsDestBlock),
      { params: Promise.resolve({ id: DISK_ID, block: String(moveBlock) }) },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.reason).toBe('not-a-directory');
    expect(diskStorePut).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(0);
  });

  it('refuses a toParent block that is not part of the parsed tree at all -- Finding 4\'s bogus/attacker-supplied destination', async () => {
    // FINDING 4: the route used to pass this number straight into
    // `moveEntry` unresolved. Whatever block 1700 happens to hold in this
    // tiny fixture, it is certainly not a real directory header this
    // volume's tree contains -- `findEntry` against `volume.root` misses,
    // and the route must refuse before `moveEntry` (or `applyDiskEdit`) is
    // ever reached with it.
    const adf = syntheticVolume({ filesystem: 'FFS', volumeName: 'MoveVol' });
    const added = addFile(adf, 880, 'move.txt', new Uint8Array([1]));
    if (!added.ok) throw new Error('add');

    const v0 = readVolume(added.adf);
    if (!v0.ok) throw new Error('read');
    const moveBlock = v0.root.find((e) => e.name === 'move.txt')!.block;

    selectResults = [
      [{ sha256: OLD_SHA, tosecName: 'Game.adf', sourceFilename: 'Game.adf' }],
      [],
    ];
    diskStoreRead.mockResolvedValue(added.adf);

    const { PATCH } = await import('./route');
    const response = await PATCH(
      moveRequest(moveBlock, 1700),
      { params: Promise.resolve({ id: DISK_ID, block: String(moveBlock) }) },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.reason).toBe('not-found');
    expect(diskStorePut).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(0);
  });
});
