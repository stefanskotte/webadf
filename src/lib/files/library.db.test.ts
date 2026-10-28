// src/lib/files/library.db.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_files_library_test';
const url = new URL(base); url.pathname = `/${DB}`; process.env.DATABASE_URL = url.toString();
process.env.STORAGE_DIR ??= (await import('node:fs')).mkdtempSync('/tmp/webadf-files-lib-');
process.env.BLOB_READ_WRITE_TOKEN = '';
async function admin(stmt: string) { const c = new Client({ connectionString: base }); await c.connect(); try { await c.query(stmt); } finally { await c.end(); } }

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { createHash } = await import('node:crypto');
const { games, disks, entitlements, blobs } = await import('@/db/schema/catalog');
const { organization } = await import('@/db/schema/auth');
const { devices } = await import('@/db/schema/devices');
const { diskStore } = await import('@/lib/storage');
const { formatVolume } = await import('@/lib/adffs/format');
const { addFile, makeDirectory } = await import('@/lib/adffs/write');
const { ROOT_BLOCK } = await import('@/lib/adffs/constants');
const { readVolume } = await import('@/lib/adffs');
const { parsePath } = await import('./path');
const { listLibrary, readLibraryFile } = await import('./library');

const ctx = { orgId: 'o1', userId: null };
const must = (r: { ok: true; adf: Uint8Array } | { ok: false; reason: string }) => { if (!r.ok) throw new Error(r.reason); return r.adf; };
const P = (s: string) => parsePath(s)!;

async function seedDisk(gameId: string, title: string, diskId: string, diskNo: number, adf: Uint8Array) {
  const sha = createHash('sha256').update(adf).digest('hex');
  await diskStore.put(sha, adf);
  const db = getDb();
  await db.insert(blobs).values({ sha256: sha, sizeBytes: adf.length, storageKey: `adf/${sha}` }).onConflictDoNothing();
  await db.insert(entitlements).values({ orgId: 'o1', sha256: sha, sourceFilename: `${title}.adf` }).onConflictDoNothing();
  await db.insert(games).values({ id: gameId, orgId: 'o1', title, sortTitle: title.toLowerCase() }).onConflictDoNothing();
  await db.insert(disks).values({ id: diskId, gameId, orgId: 'o1', diskNo, sha256: sha, sizeBytes: adf.length });
  return sha;
}

let sysSha = '';
beforeAll(async () => {
  await admin(`drop database if exists ${DB} with (force)`);
  await admin(`create database ${DB}`);
  await migrate(getDb(), { migrationsFolder: 'drizzle' });
  await getDb().insert(organization).values([{ id: 'o1', name: 'o1', slug: 'o1', createdAt: new Date() }, { id: 'o2', name: 'o2', slug: 'o2', createdAt: new Date() }]);
  let adf = formatVolume({ filesystem: 'FFS', volumeName: 'SysInfo' });
  adf = must(makeDirectory(adf, ROOT_BLOCK, 'C'));
  const cBlock = (readVolume(adf) as { ok: true; root: { name: string; block: number }[] }).root.find((e) => e.name === 'C')!.block;
  adf = must(addFile(adf, cBlock, 'Assign', new TextEncoder().encode('assign!'), 0, { comment: 'cmd' }));
  adf = must(addFile(adf, ROOT_BLOCK, 'ReadMe', new TextEncoder().encode('hello')));
  sysSha = await seedDisk('g1', 'SysInfo', 'd1', 1, adf);
  await seedDisk('g2', 'Turrican', 'd2', 1, formatVolume({ filesystem: 'OFS', volumeName: 'T1' }));
});
afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

describe('LIBRARY: listing', () => {
  it('lists titles at the root', async () => {
    const l = (await listLibrary(ctx, P('LIBRARY:')))!;
    expect(l.entries.map((e) => [e.kind, e.name, e.path])).toEqual([
      ['title', 'SysInfo', 'LIBRARY:/g1'], ['title', 'Turrican', 'LIBRARY:/g2']]);
    expect(l.writable).toBe(false);
  });
  it("lists a title's disks with a Disk N name", async () => {
    const l = (await listLibrary(ctx, P('LIBRARY:/g1')))!;
    expect(l.entries.map((e) => [e.kind, e.name, e.path])).toEqual([['disk', 'Disk 1', 'LIBRARY:/g1/d1']]);
    expect(l.crumbs.map((c) => c.label)).toEqual(['LIBRARY:', 'SysInfo']);
  });
  it("lists a disk's root and a folder, with protection, comment and the disk info", async () => {
    const root = (await listLibrary(ctx, P('LIBRARY:/g1/d1')))!;
    expect(root.entries.map((e) => [e.kind, e.name])).toEqual(expect.arrayContaining([['dir', 'C'], ['file', 'ReadMe']]));
    expect(root.disk).toMatchObject({ diskId: 'd1', gameId: 'g1', filesystem: 'FFS', holder: null, sha256: sysSha });
    expect(root.writable).toBe(true);
    const c = (await listLibrary(ctx, P('LIBRARY:/g1/d1/c')))!;   // case-insensitive, as AmigaDOS
    expect(c.entries).toEqual([expect.objectContaining({ name: 'Assign', kind: 'file', size: 7, comment: 'cmd', protection: expect.any(String) })]);
    expect(c.crumbs.map((x) => x.label)).toEqual(['LIBRARY:', 'SysInfo', 'Disk 1', 'C']);
  });
  it('is read-only with the board named while a board holds the disk', async () => {
    await getDb().insert(devices).values({ id: 'dev1', orgId: 'o1', name: 'A500 bench', macAddress: 'AA:BB:CC:DD:EE:01', tokenHash: 'h1', desiredSha256: sysSha });
    const l = (await listLibrary(ctx, P('LIBRARY:/g1/d1')))!;
    expect(l.writable).toBe(false);
    expect(l.readOnlyReason).toMatch(/A500 bench/);
    expect(l.disk!.holder).toBe('A500 bench');
    await getDb().delete(devices);
  });
  it('is not found for another org, an unknown id, or a file path', async () => {
    expect(await listLibrary({ orgId: 'o2', userId: null }, P('LIBRARY:/g1'))).toBeNull();
    expect(await listLibrary(ctx, P('LIBRARY:/nope'))).toBeNull();
    expect(await listLibrary(ctx, P('LIBRARY:/g1/d2'))).toBeNull();          // d2 is not g1's
    expect(await listLibrary(ctx, P('LIBRARY:/g1/d1/ReadMe'))).toBeNull();
  });
});

describe('readLibraryFile', () => {
  it('returns bytes and meta, and null for a folder or another org', async () => {
    const f = (await readLibraryFile(ctx, P('LIBRARY:/g1/d1/C/Assign')))!;
    expect(new TextDecoder().decode(f.bytes)).toBe('assign!');
    expect(f.comment).toBe('cmd');
    expect(await readLibraryFile(ctx, P('LIBRARY:/g1/d1/C'))).toBeNull();
    expect(await readLibraryFile({ orgId: 'o2', userId: null }, P('LIBRARY:/g1/d1/ReadMe'))).toBeNull();
  });
});
