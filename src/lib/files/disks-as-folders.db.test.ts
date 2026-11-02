// src/lib/files/disks-as-folders.db.test.ts
// Big copies part 2 (spec 2026-11-02): a DSK or TTL row copied onto a NET: volume arrives as a drawer per disk, each disk
// standing or falling by itself. Real ADFs, a real board row and a remembered listing, as net-write.db.test.ts builds them.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { Client } from 'pg';
import { createHash } from 'node:crypto';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_files_disks_as_folders_test';
const url = new URL(base); url.pathname = `/${DB}`; process.env.DATABASE_URL = url.toString();
process.env.STORAGE_DIR ??= (await import('node:fs')).mkdtempSync('/tmp/webadf-files-disks-');
process.env.BLOB_READ_WRITE_TOKEN = '';
async function admin(stmt: string) { const c = new Client({ connectionString: base }); await c.connect(); try { await c.query(stmt); } finally { await c.end(); } }

vi.mock('next/server', () => ({ after: () => {} }));
vi.mock('@/lib/tosec-sweep', () => ({ sweep: async () => {} }));
// No file on a floppy reaches the real 4 MB: the limit is lowered so one on a real ADF can cross it.
vi.mock('@/lib/transfers', async (orig) => ({ ...(await orig<typeof import('@/lib/transfers')>()), SEND_FILE_MAX: 20_000 }));

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { asc, eq } = await import('drizzle-orm');
const { organization } = await import('@/db/schema/auth');
const { blobs, disks, entitlements, games } = await import('@/db/schema/catalog');
const { collections, collectionGames } = await import('@/db/schema/collections');
const { devices } = await import('@/db/schema/devices');
const { transfers } = await import('@/db/schema/transfers');
const { remoteRequests } = await import('@/db/schema/remote-requests');
const { diskStore } = await import('@/lib/storage');
const { formatVolume } = await import('@/lib/adffs/format');
const { addFile, makeDirectory } = await import('@/lib/adffs/write');
const { ROOT_BLOCK } = await import('@/lib/adffs/constants');
const { readVolume } = await import('@/lib/adffs');
const { runOp } = await import('./ops');
const { copyDisksOntoVolume } = await import('./disks-as-folders');
const { parsePath } = await import('./path');
const { DISKS_STAY_IN_LIBRARY, COLLECTIONS_STAY } = await import('./shelf-rules');
const { COPY_MAX_DISKS } = await import('@/lib/remote-limits');

const ctx = { orgId: 'o1', userId: 'u1' };
const DATE = '2020-01-02T00:00:00.000Z';
const ent = (name: string, size: number, dir = false) => ({ name, dir, size, protection: 0, date: DATE, comment: '' });
const text = (s: string) => new TextEncoder().encode(s);
const must = (r: { ok: true; adf: Uint8Array } | { ok: false; reason: string }) => { if (!r.ok) throw new Error(r.reason); return r.adf; };
const DEST = 'NET:/w1/Work/Monkey';
const DISK = (g: string, d: string) => `LIBRARY:/${g}/${d}`;

const rows = async () => getDb().select().from(transfers).where(eq(transfers.deviceId, 'w1')).orderBy(asc(transfers.createdAt));
const dests = async () => (await rows()).map((r) => r.amigaDest);
const writes = async () => (await getDb().select().from(remoteRequests).where(eq(remoteRequests.deviceId, 'w1'))
  .orderBy(asc(remoteRequests.createdAt))).filter((r) => r.kind !== 'dir');
const copy = (sources: string[], onClash: 'ask' | 'replace' | 'skip' | 'keep-both' = 'ask', dest = DEST) =>
  runOp(ctx, { op: 'copy', sources, dest, onClash });

let n = 0;
async function remember(amigaPath: string, entries: ReturnType<typeof ent>[]) {
  const now = new Date();
  await getDb().insert(remoteRequests).values({ id: `dir-${++n}`, orgId: 'o1', deviceId: 'w1', kind: 'dir', amigaPath,
    status: 'done', answer: { volumes: [], entries }, createdAt: now, sentAt: now, answeredAt: now });
}
async function seed(gameId: string, title: string, diskId: string, diskNo: number, adf: Uint8Array, label: string | null = null) {
  const sha = createHash('sha256').update(adf).digest('hex');
  await diskStore.put(sha, adf, { overwrite: true });
  const db = getDb();
  await db.insert(blobs).values({ sha256: sha, sizeBytes: adf.length, storageKey: `adf/${sha}` }).onConflictDoNothing();
  await db.insert(entitlements).values({ orgId: 'o1', sha256: sha, sourceFilename: `${title}.adf` }).onConflictDoNothing();
  await db.insert(games).values({ id: gameId, orgId: 'o1', title, sortTitle: title.toLowerCase() }).onConflictDoNothing();
  await db.insert(disks).values({ id: diskId, gameId, orgId: 'o1', diskNo, label, sha256: sha, sizeBytes: adf.length });
}
/** A disk of its own bytes: `Files/inner.txt` (commented), `top.txt`, and `Empty`, a drawer holding nothing. */
function fullDisk(volumeName: string) {
  let adf = formatVolume({ filesystem: 'FFS', volumeName });
  adf = must(makeDirectory(adf, ROOT_BLOCK, 'Files'));
  adf = must(makeDirectory(adf, ROOT_BLOCK, 'Empty'));
  const block = (readVolume(adf) as { ok: true; root: { name: string; block: number }[] }).root.find((e) => e.name === 'Files')!.block;
  adf = must(addFile(adf, block, 'inner.txt', text(`inner of ${volumeName}`), 0, { comment: 'kept' }));
  return must(addFile(adf, ROOT_BLOCK, 'top.txt', text(`top of ${volumeName}`)));
}
const emptyDisk = (volumeName: string) => formatVolume({ filesystem: 'OFS', volumeName });
const nonDos = (fill: number) => new Uint8Array(901_120).fill(fill);

beforeAll(async () => {
  await admin(`drop database if exists ${DB} with (force)`);
  await admin(`create database ${DB}`);
  await migrate(getDb(), { migrationsFolder: 'drizzle' });
  await getDb().insert(organization).values([{ id: 'o1', name: 'o1', slug: 'o1', createdAt: new Date() }]);
});
beforeEach(async () => {
  const db = getDb();
  await db.delete(remoteRequests);
  await db.delete(transfers);
  await db.delete(devices);
  await db.delete(collectionGames);
  await db.delete(collections);
  await db.delete(disks);
  await db.delete(games);
  await db.delete(entitlements);
  const now = new Date();
  // rxProto 6: a Makedir from anywhere else in Files would ask for a drawer icon here.
  await db.insert(devices).values({ id: 'w1', orgId: 'o1', name: 'A500', tokenHash: 'h1', firmwareVersion: '1.24.0+gabc', lastSeenAt: now,
    sendRx: 'c', sendRxAt: now, rxProto: 6, browseOn: true, writeOn: true });
  await remember('Work:Monkey', []);
});
afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

describe('a DSK row onto a volume', () => {
  it('a DSK row makes a drawer', async () => {
    await seed('g1', 'Monkey', 'd1', 1, fullDisk('M1'));
    const r = await copy([DISK('g1', 'd1')]);
    expect(r).toMatchObject({ kind: 'done', items: [{ source: DISK('g1', 'd1'), ok: true }], job: { files: 2, writes: 2 } });
    expect((await dests()).sort()).toEqual(['Work:Monkey/Disk 1/Files/inner.txt', 'Work:Monkey/Disk 1/top.txt']);
    expect((await rows()).find((x) => x.path === 'inner.txt')).toMatchObject({ comment: 'kept', onClash: 'keep' });
    // The drawer holding no file comes by a Makedir, parents first, and nothing on this path asks for a drawer icon.
    const w = await writes();
    expect(w.map((x) => [x.kind, x.amigaPath])).toEqual([['mkdir', 'Work:Monkey/Disk 1'], ['mkdir', 'Work:Monkey/Disk 1/Empty']]);
    for (const x of w) expect((x.target as { drawerIcon?: boolean }).drawerIcon).toBeUndefined();
  });

  it('an empty disk still makes its drawer', async () => {
    await seed('g1', 'Monkey', 'd1', 1, emptyDisk('M1'));
    expect(await copy([DISK('g1', 'd1')])).toMatchObject({ kind: 'done', job: { files: 0, writes: 1 } });
    expect(await rows()).toEqual([]);
    const w = await writes();
    expect(w.map((x) => [x.kind, x.amigaPath])).toEqual([['mkdir', 'Work:Monkey/Disk 1']]);
    expect(w[0].target).toMatchObject({ ensure: true });
    expect((w[0].target as { drawerIcon?: boolean }).drawerIcon).toBeUndefined();
  });

  it('a labelled disk takes the name its row shows', async () => {
    await seed('g1', 'Monkey', 'd1', 1, fullDisk('M1'), 'Part One');
    await copy([DISK('g1', 'd1')]);
    expect(await dests()).toContain('Work:Monkey/Part One/top.txt');
  });
});

describe('a TTL row onto a volume', () => {
  it('a TTL row is its disks', async () => {
    await seed('g1', 'Monkey', 'd2', 2, fullDisk('M2'));
    await seed('g1', 'Monkey', 'd1', 1, fullDisk('M1'));
    const r = await copy(['LIBRARY:/g1']);
    expect(r).toMatchObject({ kind: 'done', items: [{ source: DISK('g1', 'd1'), ok: true }, { source: DISK('g1', 'd2'), ok: true }] });
    const all = await dests();
    expect(all.filter((d) => d!.startsWith('Work:Monkey/Disk 1/'))).toHaveLength(2);
    expect(all.filter((d) => d!.startsWith('Work:Monkey/Disk 2/'))).toHaveLength(2);
    expect(all.filter((d) => d!.includes('Monkey/Monkey'))).toEqual([]);
    expect(all).toHaveLength(4);
  });

  it('a title reached through its collection keeps the collection in its disks\' paths', async () => {
    await seed('g1', 'Monkey', 'd1', 1, fullDisk('M1'));
    await getDb().insert(collections).values({ id: 'c1', orgId: 'o1', name: 'Adventures' });
    await getDb().insert(collectionGames).values({ collectionId: 'c1', gameId: 'g1', sortKey: 0 });
    expect(await copy(['LIBRARY:/c1/g1'])).toMatchObject({ kind: 'done', items: [{ source: 'LIBRARY:/c1/g1/d1', ok: true }] });
  });

  it('a title with no disks here, or none at all, is that item not found', async () => {
    await seed('g1', 'Monkey', 'd1', 1, fullDisk('M1'));
    expect(await copy(['LIBRARY:/nope', 'LIBRARY:/g1'])).toMatchObject({ kind: 'done', items: [
      { source: 'LIBRARY:/nope', ok: false, refusal: { code: 'not_found' } }, { source: DISK('g1', 'd1'), ok: true }] });
  });
});

describe('what a copy of disks refuses whole', () => {
  it('move is refused; the disk still exists', async () => {
    await seed('g1', 'Monkey', 'd1', 1, fullDisk('M1'));
    expect(await runOp(ctx, { op: 'move', sources: [DISK('g1', 'd1')], dest: DEST, onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', status: 400, refusal: { code: 'unsupported', detail: DISKS_STAY_IN_LIBRARY } });
    expect(await getDb().select().from(disks).where(eq(disks.id, 'd1'))).toHaveLength(1);
    expect(await rows()).toEqual([]);
    expect(await writes()).toEqual([]);
  });

  it('nine disks: too_large, before any image is read', async () => {
    expect(COPY_MAX_DISKS).toBe(8);
    for (let i = 1; i <= 9; i++) await seed('g1', 'Many', `d${i}`, i, emptyDisk(`M${i}`));
    const spy = vi.spyOn(diskStore, 'read');
    try {
      expect(await copy(['LIBRARY:/g1'])).toMatchObject({ kind: 'refused', status: 413, refusal: { code: 'too_large', detail: 'at most 8 disks at a time' } });
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
    expect(await writes()).toEqual([]);
  });

  it('eight disks go', async () => {
    for (let i = 1; i <= 8; i++) await seed('g1', 'Many', `d${i}`, i, emptyDisk(`M${i}`));
    expect(await copy(['LIBRARY:/g1'])).toMatchObject({ kind: 'done', job: { files: 0, writes: 8 } });
  });

  it('a source that is neither row kind, mixed in: refused whole', async () => {
    await seed('g1', 'Monkey', 'd1', 1, fullDisk('M1'));
    expect(await copy([DISK('g1', 'd1'), `${DISK('g1', 'd1')}/top.txt`])).toMatchObject({ kind: 'refused', status: 400, refusal: { code: 'unsupported' } });
    expect(await copy([DISK('g1', 'd1'), 'STASH:/x.txt'])).toMatchObject({ kind: 'refused', status: 400, refusal: { code: 'unsupported' } });
    expect(await rows()).toEqual([]);
  });

  it('a collection mixed in with titles: refused whole, as filing says it', async () => {
    await seed('g1', 'Monkey', 'd1', 1, fullDisk('M1'));
    await getDb().insert(collections).values({ id: 'c1', orgId: 'o1', name: 'Adventures' });
    expect(await copy(['LIBRARY:/g1', 'LIBRARY:/c1'])).toMatchObject({ kind: 'refused', refusal: { code: 'unsupported', detail: COLLECTIONS_STAY } });
    expect(await rows()).toEqual([]);
  });

  it('two disks share a name: refused name_exists', async () => {
    await seed('g1', 'Monkey', 'd1', 1, fullDisk('M1'));
    await seed('g2', 'Loom', 'd2', 1, fullDisk('L1'));
    expect(await copy([DISK('g1', 'd1'), DISK('g2', 'd2')])).toMatchObject({ kind: 'refused', refusal: { code: 'name_exists' } });
    expect(await rows()).toEqual([]);
  });
});

describe('each disk by itself', () => {
  it('one unreadable disk: the good one is queued, the bad one named', async () => {
    await seed('g1', 'Monkey', 'd1', 1, nonDos(1));
    await seed('g1', 'Monkey', 'd2', 2, fullDisk('M2'));
    const r = await copy(['LIBRARY:/g1']);
    expect(r).toMatchObject({ kind: 'done', job: { files: 2 }, items: [
      { source: DISK('g1', 'd1'), ok: false, refusal: { code: 'unsupported', detail: 'Disk 1 cannot be read as files' } },
      { source: DISK('g1', 'd2'), ok: true }] });
    expect((await dests()).every((d) => d!.startsWith('Work:Monkey/Disk 2/'))).toBe(true);
  });

  it('nothing can go: no job, no rows, every item refused', async () => {
    await seed('g1', 'Monkey', 'd1', 1, nonDos(1));
    await seed('g1', 'Monkey', 'd2', 2, nonDos(2));
    const r = await copy(['LIBRARY:/g1']);
    expect(r).toMatchObject({ kind: 'done', items: [{ ok: false }, { ok: false }] });
    expect(r).not.toHaveProperty('job');
    expect(await rows()).toEqual([]);
    expect(await writes()).toEqual([]);
  });

  it('a label the Amiga cannot take is refused by name; the other goes', async () => {
    await seed('g1', 'Monkey', 'd1', 1, fullDisk('M1'), 'Foo: Bar');
    await seed('g1', 'Monkey', 'd2', 2, fullDisk('M2'));
    expect(await copy(['LIBRARY:/g1'])).toMatchObject({ kind: 'done', items: [
      { source: DISK('g1', 'd1'), ok: false, refusal: { code: 'bad_name' } }, { source: DISK('g1', 'd2'), ok: true }] });
    expect((await dests()).every((d) => d!.startsWith('Work:Monkey/Disk 2/'))).toBe(true);
  });

  it('a file over the limit refuses its disk, in words naming both', async () => {
    let big = formatVolume({ filesystem: 'FFS', volumeName: 'Big' });
    big = must(addFile(big, ROOT_BLOCK, 'huge.dat', new Uint8Array(30_000).fill(7)));
    await seed('g1', 'Monkey', 'd1', 1, big);
    await seed('g1', 'Monkey', 'd2', 2, fullDisk('M2'));
    expect(await copy(['LIBRARY:/g1'])).toMatchObject({ kind: 'done', items: [
      { source: DISK('g1', 'd1'), ok: false, refusal: { code: 'too_large', detail: 'Disk 1: huge.dat is over 4 MB' } }, { source: DISK('g1', 'd2'), ok: true }] });
  });

  it('a store failure is that disk\'s refusal; the other goes', async () => {
    await seed('g1', 'Monkey', 'd1', 1, fullDisk('M1'));
    await seed('g1', 'Monkey', 'd2', 2, fullDisk('M2'));
    const real = diskStore.read.bind(diskStore);
    const [{ sha256: bad }] = await getDb().select({ sha256: disks.sha256 }).from(disks).where(eq(disks.id, 'd1'));
    const spy = vi.spyOn(diskStore, 'read').mockImplementation(async (sha) => {
      if (sha === bad) throw new Error('store down');
      return real(sha);
    });
    try {
      expect(await copy(['LIBRARY:/g1'])).toMatchObject({ kind: 'done', items: [
        { source: DISK('g1', 'd1'), ok: false, refusal: { code: 'blob_unavailable' } }, { source: DISK('g1', 'd2'), ok: true }] });
    } finally { spy.mockRestore(); }
  });
});

describe('clashes', () => {
  it('asks with the disk path as source; replace then writes into the drawer and deletes nothing', async () => {
    await remember('Work:Monkey', [ent('Disk 1', 0, true)]);
    await seed('g1', 'Monkey', 'd1', 1, fullDisk('M1'));
    expect(await copy([DISK('g1', 'd1')])).toEqual({ kind: 'clashes', clashes: [{ source: DISK('g1', 'd1'), name: 'Disk 1', dest: DEST }] });
    expect(await rows()).toEqual([]);
    expect(await writes()).toEqual([]);
    expect(await copy([DISK('g1', 'd1')], 'replace')).toMatchObject({ kind: 'done', job: { files: 2 } });
    expect((await rows()).map((r) => r.onClash)).toEqual(['replace', 'replace']);
    expect((await writes()).filter((w) => w.kind === 'delete')).toEqual([]);
  });

  it('a clash through a title names each disk path', async () => {
    await remember('Work:Monkey', [ent('Disk 2', 0, true)]);
    await seed('g1', 'Monkey', 'd1', 1, fullDisk('M1'));
    await seed('g1', 'Monkey', 'd2', 2, fullDisk('M2'));
    expect(await copy(['LIBRARY:/g1'])).toEqual({ kind: 'clashes', clashes: [{ source: DISK('g1', 'd2'), name: 'Disk 2', dest: DEST }] });
    expect(await rows()).toEqual([]);
  });
});

describe('everywhere else stays as it was', () => {
  it('a disk row onto STASH: answers the refusal it does today', async () => {
    await seed('g1', 'Monkey', 'd1', 1, fullDisk('M1'));
    const req = { op: 'copy' as const, sources: [DISK('g1', 'd1')], dest: 'STASH:', onClash: 'ask' as const };
    expect(await copyDisksOntoVolume({ ...ctx, versions: [] }, req, parsePath('STASH:')!)).toBeNull();
    expect(await copy([DISK('g1', 'd1')], 'ask', 'STASH:')).toMatchObject({ kind: 'refused', status: 400, refusal: { code: 'unsupported', detail: 'not an entry on a disk' } });
  });

  it('a file on a disk onto a volume is an ordinary copy, not a disk', async () => {
    await seed('g1', 'Monkey', 'd1', 1, fullDisk('M1'));
    expect(await copy([`${DISK('g1', 'd1')}/top.txt`])).toMatchObject({ kind: 'done', job: { files: 1 } });
    expect(await dests()).toEqual(['Work:Monkey/top.txt']);
  });

  it('a collection alone onto a volume answers as it does today', async () => {
    await getDb().insert(collections).values({ id: 'c1', orgId: 'o1', name: 'Adventures' });
    expect(await copy(['LIBRARY:/c1'])).toMatchObject({ kind: 'refused', refusal: { code: 'unsupported', detail: 'not inside a disk' } });
  });
});
