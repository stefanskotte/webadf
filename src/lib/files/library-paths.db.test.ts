// src/lib/files/library-paths.db.test.ts
// LIBRARY: through collections (Files 2 §3.1): the root, a collection, a title or disk through one, stale and foreign
// paths, and ops that must not care which form of a disk's path they were given.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_files_library_paths_test';
const url = new URL(base); url.pathname = `/${DB}`; process.env.DATABASE_URL = url.toString();
process.env.STORAGE_DIR ??= (await import('node:fs')).mkdtempSync('/tmp/webadf-files-libpaths-');
process.env.BLOB_READ_WRITE_TOKEN = '';
async function admin(stmt: string) { const c = new Client({ connectionString: base }); await c.connect(); try { await c.query(stmt); } finally { await c.end(); } }

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { createHash } = await import('node:crypto');
const { games, disks, entitlements, blobs } = await import('@/db/schema/catalog');
const { collections, collectionGames } = await import('@/db/schema/collections');
const { organization } = await import('@/db/schema/auth');
const { diskStore } = await import('@/lib/storage');
const { formatVolume } = await import('@/lib/adffs/format');
const { addFile, makeDirectory } = await import('@/lib/adffs/write');
const { ROOT_BLOCK } = await import('@/lib/adffs/constants');
const { readVolume } = await import('@/lib/adffs');
const { parsePath } = await import('./path');
const { listLibrary, readLibraryFile } = await import('./library');
const { placeInLibrary } = await import('./library-paths');
const { libraryDriver } = await import('./library-driver');
const { Refused } = await import('./driver');
const { runOp } = await import('./ops');

const ctx = { orgId: 'o1', userId: null };
const must = (r: { ok: true; adf: Uint8Array } | { ok: false; reason: string }) => { if (!r.ok) throw new Error(r.reason); return r.adf; };
const P = (s: string) => parsePath(s)!;

async function seedDisk(gameId: string, title: string, diskId: string, adf: Uint8Array, store = true) {
  const sha = createHash('sha256').update(adf).digest('hex');
  if (store) await diskStore.put(sha, adf);
  const db = getDb();
  await db.insert(blobs).values({ sha256: sha, sizeBytes: adf.length, storageKey: `adf/${sha}` }).onConflictDoNothing();
  await db.insert(entitlements).values({ orgId: 'o1', sha256: sha, sourceFilename: `${title}.adf` }).onConflictDoNothing();
  await db.insert(games).values({ id: gameId, orgId: 'o1', title, sortTitle: title.toLowerCase() }).onConflictDoNothing();
  await db.insert(disks).values({ id: diskId, gameId, orgId: 'o1', diskNo: 1, sha256: sha, sizeBytes: adf.length });
}

beforeAll(async () => {
  await admin(`drop database if exists ${DB} with (force)`);
  await admin(`create database ${DB}`);
  await migrate(getDb(), { migrationsFolder: 'drizzle' });
  const db = getDb();
  await db.insert(organization).values([{ id: 'o1', name: 'o1', slug: 'o1', createdAt: new Date() }, { id: 'o2', name: 'o2', slug: 'o2', createdAt: new Date() }]);
  let adf = formatVolume({ filesystem: 'FFS', volumeName: 'SysInfo' });
  adf = must(makeDirectory(adf, ROOT_BLOCK, 'C'));
  const cBlock = (readVolume(adf) as { ok: true; root: { name: string; block: number }[] }).root.find((e) => e.name === 'C')!.block;
  adf = must(addFile(adf, cBlock, 'Assign', new TextEncoder().encode('assign!'), 0));
  adf = must(addFile(adf, ROOT_BLOCK, 'ReadMe', new TextEncoder().encode('hello')));
  await seedDisk('g1', 'SysInfo', 'd1', adf);
  await seedDisk('g2', 'Turrican', 'd2', formatVolume({ filesystem: 'FFS', volumeName: 'T1' }));
  await seedDisk('g3', 'Loose', 'd3', formatVolume({ filesystem: 'OFS', volumeName: 'L1' }));
  // A disk row whose image is not in the store.
  await seedDisk('g4', 'Broken', 'd4', formatVolume({ filesystem: 'OFS', volumeName: 'B1', density: 'dd' }).map((b, i) => (i === 0 ? 1 : b)), false);
  await db.insert(collections).values([
    { id: 'c2', orgId: 'o1', name: 'Games', sortKey: 1 },
    { id: 'c1', orgId: 'o1', name: 'Demos', sortKey: 0 },
    { id: 'c9', orgId: 'o2', name: 'Theirs', sortKey: 0 },
  ]);
  await db.insert(collectionGames).values([
    { collectionId: 'c1', gameId: 'g2', sortKey: 0 }, { collectionId: 'c1', gameId: 'g1', sortKey: 1 },
    { collectionId: 'c2', gameId: 'g1', sortKey: 0 }, { collectionId: 'c1', gameId: 'g4', sortKey: 2 },
  ]);
});
afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

describe('LIBRARY: as the Library (Files 2 §3.1)', () => {
  it('the root lists the collections in their order, then the titles in no collection', async () => {
    const l = (await listLibrary(ctx, P('LIBRARY:')))!;
    expect(l.entries.map((e) => [e.kind, e.name, e.path, e.sizeText ?? null])).toEqual([
      ['collection', 'Demos', 'LIBRARY:/c1', '3 titles'],
      ['collection', 'Games', 'LIBRARY:/c2', '1 title'],
      ['title', 'Loose', 'LIBRARY:/g3', null],
    ]);
    expect(l.meta).toBe('2 collections · 1 title');
    expect(l.library).toEqual({ level: 'root', collectionId: null });
  });
  it('a collection lists its titles in its own order; a title in two collections is in both', async () => {
    const c1 = (await listLibrary(ctx, P('LIBRARY:/c1')))!;
    expect(c1.entries.map((e) => [e.kind, e.name, e.path])).toEqual([
      ['title', 'Turrican', 'LIBRARY:/c1/g2'], ['title', 'SysInfo', 'LIBRARY:/c1/g1'], ['title', 'Broken', 'LIBRARY:/c1/g4'],
    ]);
    expect(c1.crumbs).toEqual([{ label: 'LIBRARY:', path: 'LIBRARY:' }, { label: 'Demos', path: 'LIBRARY:/c1' }]);
    expect(c1.library).toEqual({ level: 'collection', collectionId: 'c1' });
    expect((await listLibrary(ctx, P('LIBRARY:/c2')))!.entries.map((e) => e.path)).toEqual(['LIBRARY:/c2/g1']);
  });
  it('a disk through a collection keeps the prefix in every path, crumb and its diskBase', async () => {
    const l = (await listLibrary(ctx, P('LIBRARY:/c1/g1/d1/C')))!;
    expect(l.entries.map((e) => e.path)).toEqual(['LIBRARY:/c1/g1/d1/C/Assign']);
    expect(l.crumbs.map((c) => [c.label, c.path])).toEqual([
      ['LIBRARY:', 'LIBRARY:'], ['Demos', 'LIBRARY:/c1'], ['SysInfo', 'LIBRARY:/c1/g1'], ['Disk 1', 'LIBRARY:/c1/g1/d1'], ['C', 'LIBRARY:/c1/g1/d1/C'],
    ]);
    expect(l.diskBase).toBe('LIBRARY:/c1/g1/d1');
    expect(l.library).toEqual({ level: 'disk', collectionId: 'c1' });
    expect((await listLibrary(ctx, P('LIBRARY:/c1/g1')))!.entries.map((e) => e.path)).toEqual(['LIBRARY:/c1/g1/d1']);
    expect((await readLibraryFile(ctx, P('LIBRARY:/c1/g1/d1/C/Assign')))!.name).toBe('Assign');
  });
  it('the unfiled form still works for a filed title, and Parent from it is LIBRARY:', async () => {
    const l = (await listLibrary(ctx, P('LIBRARY:/g1/d1')))!;
    expect(l.crumbs.map((c) => c.path)).toEqual(['LIBRARY:', 'LIBRARY:/g1', 'LIBRARY:/g1/d1']);
    expect(l.diskBase).toBe('LIBRARY:/g1/d1');
    expect(l.library).toEqual({ level: 'disk', collectionId: null });
  });
  it('a path through a collection the title is not in, or another org\'s, is not found', async () => {
    expect(await listLibrary(ctx, P('LIBRARY:/c2/g2'))).toBeNull();
    expect(await listLibrary(ctx, P('LIBRARY:/c2/g2/d2'))).toBeNull();
    expect(await readLibraryFile(ctx, P('LIBRARY:/c2/g3/d3/x'))).toBeNull();
    expect(await placeInLibrary(ctx, ['c2', 'g2'])).toBeNull();
    // Another org's collection is no collection here: its id reads as a title id, and there is no such title.
    expect(await listLibrary(ctx, P('LIBRARY:/c9'))).toBeNull();
    expect(await listLibrary(ctx, P('LIBRARY:/c9/g1'))).toBeNull();
  });
  it('an unreadable image refuses with its disk id, through a collection too', async () => {
    const err = await libraryDriver.list(ctx, P('LIBRARY:/c1/g4/d4')).catch((e) => e);
    expect(err).toBeInstanceOf(Refused);
    expect(err.refusal).toEqual({ code: 'blob_unavailable', detail: 'd4' });
  });
});

describe('firstCollectionOf (Files 2 §3.1: where Files… opens a disk)', () => {
  it('the first of the org\'s collections, in collection order, the title is filed in; null when in none or foreign', async () => {
    const { firstCollectionOf } = await import('@/lib/collections');
    expect(await firstCollectionOf('o1', 'g1')).toBe('c1');   // in c2 (sortKey 1) and c1 (sortKey 0)
    expect(await firstCollectionOf('o1', 'g2')).toBe('c1');
    expect(await firstCollectionOf('o1', 'g3')).toBeNull();
    expect(await firstCollectionOf('o2', 'g1')).toBeNull();
  });
});

describe('ops through a collection prefix are prefix-blind', () => {
  it('a copy out of a disk reached through a collection writes one version of the destination', async () => {
    const r = await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/c1/g1/d1/ReadMe'], dest: 'LIBRARY:/g2/d2', onClash: 'ask' });
    expect(r).toMatchObject({ kind: 'done', items: [{ source: 'LIBRARY:/c1/g1/d1/ReadMe', ok: true }], versions: [{ diskId: 'd2' }] });
    expect((await readLibraryFile(ctx, P('LIBRARY:/g2/d2/ReadMe')))!.bytes).toEqual(new TextEncoder().encode('hello'));
  });
  it('a folder moved into itself through mixed prefixes is a cycle', async () => {
    expect(await runOp(ctx, { op: 'move', sources: ['LIBRARY:/c1/g1/d1/C'], dest: 'LIBRARY:/c2/g1/d1/C', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', refusal: { code: 'cycle' } });
  });
  it('makedir through a collection answers the new folder under the same prefix', async () => {
    expect(await runOp(ctx, { op: 'makedir', dest: 'LIBRARY:/c1/g1/d1', name: 'S' }))
      .toMatchObject({ kind: 'done', items: [{ source: 'LIBRARY:/c1/g1/d1/S', ok: true }] });
  });
  it('a disk path through a collection the title is not in is not found for an op', async () => {
    expect(await runOp(ctx, { op: 'delete', sources: ['LIBRARY:/c2/g2/d2/ReadMe'] }))
      .toMatchObject({ kind: 'refused', refusal: { code: 'not_found' } });
  });
});
