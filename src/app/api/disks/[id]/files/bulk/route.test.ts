// POST /api/disks/[id]/files/bulk (A5): several entries deleted or moved in ONE
// commit, so the disk gets one new version and one Undo puts it all back.
import { describe, it, expect, vi, beforeEach } from 'vitest';
// The hidden-id guard (R-6b) is covered against a real database in src/app/api/remote/remote-api.db.test.ts.
vi.mock('@/lib/remote-hidden', async (orig) => ({ ...(await orig<typeof import('@/lib/remote-hidden')>()), refuseHidden: async () => null }));
import { createHash } from 'node:crypto';
import { syntheticVolume } from '@/lib/adffs/synthetic';
import { readVolume, type AdfEntry } from '@/lib/adffs';
import { addFile, makeDirectory } from '@/lib/adffs/write';

const diskStoreRead = vi.fn();
vi.mock('@/lib/storage', () => ({
  diskStore: { read: diskStoreRead, put: vi.fn(), remove: vi.fn(), storageKey: (s: string) => `adf/${s}` },
}));
const recordVersion = vi.fn(async (input: { next: Uint8Array }) => ({
  sha256: createHash('sha256').update(input.next).digest('hex'), seq: 4, kind: 'delta' as const, sectorCount: 1,
}));
vi.mock('@/lib/disk-history/store', () => ({ recordVersion }));
vi.mock('@/lib/session', () => ({
  requireOrg: () => Promise.resolve({ orgId: 'org-1', userId: 'user-1', email: 'a@b.test' }),
}));

let selectResults: unknown[][] = [];
function fakeDb() {
  const select = () => {
    const result = selectResults.shift() ?? [];
    const chain = { from: () => chain, innerJoin: () => chain, where: () => chain, limit: () => Promise.resolve(result) };
    return chain;
  };
  const insert = () => ({ values: () => ({ onConflictDoNothing: () => Promise.resolve(undefined) }) });
  const update = () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) });
  return { select, insert, update };
}
vi.mock('@/db', () => ({ getDb: () => fakeDb() }));

const DISK_ID = 'disk-1';
const ok = <T extends { ok: boolean }>(r: T) => { if (!r.ok) throw new Error('write'); return r as Extract<T, { ok: true }>; };

/** Root: Docs/ (holding inner.txt), a.txt, b.txt, c.txt. */
function disk() {
  let adf = syntheticVolume({ filesystem: 'FFS', volumeName: 'Bulk' });
  adf = ok(makeDirectory(adf, 880, 'Docs')).adf;
  for (const n of ['a.txt', 'b.txt', 'c.txt']) adf = ok(addFile(adf, 880, n, new Uint8Array([1, 2]))).adf;
  const v = readVolume(adf); if (!v.ok) throw new Error('read');
  const docs = v.root.find((e) => e.name === 'Docs')!.block;
  adf = ok(addFile(adf, docs, 'inner.txt', new Uint8Array([3]))).adf;
  const v2 = readVolume(adf); if (!v2.ok) throw new Error('read');
  const at = (name: string, list: AdfEntry[] = v2.root): number => {
    for (const e of list) { if (e.name === name) return e.block; const f = at(name, e.children); if (f) return f; }
    return 0;
  };
  return { adf, at };
}

async function post(body: unknown) {
  const { POST } = await import('./route');
  return POST(new Request(`http://test/api/disks/${DISK_ID}/files/bulk`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: DISK_ID }) });
}
const written = () => { const v = readVolume(recordVersion.mock.calls[0][0].next); if (!v.ok) throw new Error('read'); return v; };
const names = (list: AdfEntry[]) => list.map((e) => e.name).sort();

beforeEach(() => {
  vi.clearAllMocks();
  selectResults = [[{ sha256: 'a'.repeat(64), tosecName: 'G.adf', sourceFilename: 'G.adf' }], []];
});

describe('POST /api/disks/[id]/files/bulk', () => {
  it('deletes several entries in one recorded version', async () => {
    const { adf, at } = disk();
    diskStoreRead.mockResolvedValue(adf);
    const res = await post({ op: 'delete', blocks: [at('a.txt'), at('Docs')] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ seq: 4 });
    expect(recordVersion).toHaveBeenCalledTimes(1);
    expect(names(written().root)).toEqual(['b.txt', 'c.txt']);
  });

  it('a selected entry inside a selected folder goes with the folder, not twice', async () => {
    const { adf, at } = disk();
    diskStoreRead.mockResolvedValue(adf);
    const res = await post({ op: 'delete', blocks: [at('inner.txt'), at('Docs')] });
    expect(res.status).toBe(200);
    expect(names(written().root)).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  it('moves several entries into a folder in one version', async () => {
    const { adf, at } = disk();
    diskStoreRead.mockResolvedValue(adf);
    const res = await post({ op: 'move', blocks: [at('a.txt'), at('b.txt')], toParent: at('Docs') });
    expect(res.status).toBe(200);
    const v = written();
    expect(names(v.root)).toEqual(['Docs', 'c.txt']);
    expect(names(v.root.find((e) => e.name === 'Docs')!.children)).toEqual(['a.txt', 'b.txt', 'inner.txt']);
  });

  it('leaves an entry already in the destination where it is', async () => {
    const { adf, at } = disk();
    diskStoreRead.mockResolvedValue(adf);
    const res = await post({ op: 'move', blocks: [at('inner.txt'), at('c.txt')], toParent: at('Docs') });
    expect(res.status).toBe(200);
    expect(names(written().root.find((e) => e.name === 'Docs')!.children)).toEqual(['c.txt', 'inner.txt']);
  });

  it('refuses the whole move when one entry cannot go, writing nothing', async () => {
    const { adf, at } = disk();
    diskStoreRead.mockResolvedValue(adf);
    const res = await post({ op: 'move', blocks: [at('a.txt'), at('Docs')], toParent: at('Docs') });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: 'a folder cannot be moved inside itself' });
    expect(recordVersion).not.toHaveBeenCalled();
  });

  it('refuses a block that is not on the disk', async () => {
    const { adf } = disk();
    diskStoreRead.mockResolvedValue(adf);
    const res = await post({ op: 'delete', blocks: [1234] });
    expect(res.status).toBe(400);
    expect(recordVersion).not.toHaveBeenCalled();
  });

  it('refuses an empty selection', async () => {
    expect((await post({ op: 'delete', blocks: [] })).status).toBe(400);
  });
});
