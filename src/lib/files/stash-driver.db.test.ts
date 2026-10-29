// src/lib/files/stash-driver.db.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_stash_driver_test';
const url = new URL(base); url.pathname = `/${DB}`; process.env.DATABASE_URL = url.toString();
process.env.STORAGE_DIR ??= (await import('node:fs')).mkdtempSync('/tmp/webadf-stash-driver-');
process.env.BLOB_READ_WRITE_TOKEN = '';
async function admin(stmt: string) { const c = new Client({ connectionString: base }); await c.connect(); try { await c.query(stmt); } finally { await c.end(); } }

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { organization } = await import('@/db/schema/auth');
const { devices } = await import('@/db/schema/devices');
const { amigaUploads } = await import('@/db/schema/amiga-uploads');
const { diskStore } = await import('@/lib/storage');
const { createHash } = await import('node:crypto');
const { readFileSync } = await import('node:fs');
const { insertStash } = await import('@/lib/stash');
const { makeZip } = await import('@/lib/__fixtures__/make-zip');
const { parsePath } = await import('./path');
const { stashDriver } = await import('./stash-driver');

const ctx = { orgId: 'o1', userId: null };
const P = (s: string) => parsePath(s)!;
async function put(bytes: Uint8Array) { const sha = createHash('sha256').update(bytes).digest('hex'); await diskStore.put(sha, bytes); return sha; }
async function stash(path: string, bytes: Uint8Array, meta: { protection?: number; comment?: string; date?: Date } = {}) {
  const r = await insertStash(getDb(), 'o1', 'browser', [{ path, kind: 'file', sha256: await put(bytes), sizeBytes: bytes.length,
    date: meta.date ?? new Date(Date.UTC(2020, 0, 2)), protection: meta.protection ?? 0, comment: meta.comment ?? '' }]);
  if (!r.ok) throw new Error(r.code);
  return r.ids[0];
}
const enc = (s: string) => new TextEncoder().encode(s);

beforeAll(async () => {
  await admin(`drop database if exists ${DB} with (force)`);
  await admin(`create database ${DB}`);
  await migrate(getDb(), { migrationsFolder: 'drizzle' });
  await getDb().insert(organization).values([{ id: 'o1', name: 'o1', slug: 'o1', createdAt: new Date() }, { id: 'o2', name: 'o2', slug: 'o2', createdAt: new Date() }]);
  await getDb().insert(devices).values({ id: 'dev1', orgId: 'o1', name: 'A500 bench', macAddress: 'AA:BB:CC:DD:EE:01', tokenHash: 'h1' });
  await stash('ReadMe', enc('hello'), { protection: 0x05, comment: 'top' });
  await stash('Mods/enigma.mod', enc('mod!'));
  await stash('t.zip', new Uint8Array(readFileSync('src/lib/archive/fixtures/t.zip')));
  await stash('bad.lha', enc('not an lha at all'));
  // One member over MAX_ZIP_MEMBER_BYTES (4 MiB): the archive is refused whole (ruling 5), not listed short.
  await stash('big.zip', new Uint8Array(makeZip([{ name: 'small.txt', data: Buffer.from('hi') }, { name: 'huge.bin', data: Buffer.alloc(5 * 1024 * 1024), deflate: true }])));
  await getDb().insert(amigaUploads).values({ id: 'arr1', orgId: 'o1', deviceId: 'dev1', deviceName: 'A500 bench', path: 'Mods/arriving.mod',
    sizeBytes: 100, receivedBytes: 45, amigaDate: '17000.0.0', status: 'receiving', expiresAt: new Date(Date.now() + 3600_000) });
  await getDb().insert(amigaUploads).values({ id: 'bad1', orgId: 'o1', deviceId: 'dev1', deviceName: 'A500 bench', path: 'Broken.txt',
    sizeBytes: 10, receivedBytes: 10, amigaDate: '17000.0.0', status: 'failed', errorCode: 'crc', expiresAt: new Date(Date.now() + 3600_000) });
});
afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

describe('STASH: listing', () => {
  it('lists the root: folders, files and an archive, with protection, comment and the limit line', async () => {
    const l = (await stashDriver.list(ctx, P('STASH:')))!;
    expect(l.entries.map((e) => [e.kind, e.name, e.path])).toEqual(expect.arrayContaining([
      ['dir', 'Mods', 'STASH:/Mods'], ['file', 'ReadMe', 'STASH:/ReadMe'], ['archive', 't.zip', 'STASH:/t.zip']]));
    expect(l.entries.find((e) => e.name === 'ReadMe')).toMatchObject({ size: 5, comment: 'top', date: '2020-01-02T00:00:00.000Z', protection: '----r-e-' });
    expect(l.entries.find((e) => e.name === 'Mods')).toMatchObject({ protection: '----rwed', date: null, size: null });
    expect([l.writable, l.disk, l.crumbs]).toEqual([true, null, [{ label: 'STASH:', path: 'STASH:' }]]);
    expect(l.meta).toMatch(/of 256 MB · kept 30 days/);
  });
  it('marks a file still arriving with the board and its progress, and a failed one with why', async () => {
    const l = (await stashDriver.list(ctx, P('STASH:/mods')))!;
    expect(l.entries.find((e) => e.name === 'arriving.mod')!.marks).toEqual(['from A500 bench', 'arriving 45%']);
    expect(l.crumbs).toEqual([{ label: 'STASH:', path: 'STASH:' }, { label: 'Mods', path: 'STASH:/Mods' }]);
    expect(l.meta).toBe('0 folders · 2 files');
    const root = (await stashDriver.list(ctx, P('STASH:')))!;
    expect(root.entries.find((e) => e.name === 'Broken.txt')!.marks).toEqual(['from A500 bench', 'failed — damaged on the way: send it again']);
  });
  it('opens an archive as a read-only folder with the dates it records', async () => {
    const l = (await stashDriver.list(ctx, P('STASH:/t.zip/src')))!;
    expect([l.writable, l.readOnlyReason]).toEqual([false, 'archive']);
    expect(l.entries.map((e) => e.name)).toEqual(expect.arrayContaining(['sub', 'readme.txt', 'tiny.txt', 'noise.bin']));
    expect(l.entries.find((e) => e.name === 'readme.txt')!.date).toBe('2026-09-11T14:47:48.000Z');
    expect(l.entries.find((e) => e.name === 'readme.txt')).toMatchObject({ kind: 'file', size: 135, protection: '----rwed', path: 'STASH:/t.zip/src/readme.txt' });
    expect(l.crumbs.map((c) => c.label)).toEqual(['STASH:', 't.zip', 'src']);
    expect(l.meta).toBe('4 files in the archive');
  });
  it('an unreadable archive refuses its listing but still reads whole', async () => {
    await expect(stashDriver.list(ctx, P('STASH:/bad.lha'))).rejects.toMatchObject({ refusal: { code: 'archive_unreadable' }, status: 422 });
    expect(new TextDecoder().decode((await stashDriver.read(ctx, P('STASH:/bad.lha')))!.bytes)).toBe('not an lha at all');
  });
  it('an archive with a member over the caps is refused whole, not listed short (ruling 5)', async () => {
    await expect(stashDriver.list(ctx, P('STASH:/big.zip'))).rejects.toMatchObject({ refusal: { code: 'archive_unreadable' }, status: 422 });
    await expect(stashDriver.collect(ctx, P('STASH:/big.zip/huge.bin'))).rejects.toMatchObject({ refusal: { code: 'archive_unreadable' } });
    // The archive itself is still a file to copy.
    expect((await stashDriver.collect(ctx, P('STASH:/big.zip')))![0]).toMatchObject({ rel: ['big.zip'], kind: 'file', sha256: expect.any(String) });
  });
  it('is not found for another org, a missing name, or a path through a plain file', async () => {
    expect(await stashDriver.list({ orgId: 'o2', userId: null }, P('STASH:/Mods'))).toBeNull();
    expect(await stashDriver.read({ orgId: 'o2', userId: null }, P('STASH:/ReadMe'))).toBeNull();
    expect(await stashDriver.collect({ orgId: 'o2', userId: null }, P('STASH:/ReadMe'))).toBeNull();
    expect(await stashDriver.list(ctx, P('STASH:/Nope'))).toBeNull();
    expect(await stashDriver.list(ctx, P('STASH:/ReadMe/x'))).toBeNull();
    expect(await stashDriver.list(ctx, P('STASH:/t.zip/src/nope'))).toBeNull();
  });
});

describe('STASH: read and collect', () => {
  it('reads a file and an archive member with their meta', async () => {
    expect((await stashDriver.read(ctx, P('STASH:/ReadMe')))).toMatchObject({ name: 'ReadMe', comment: 'top', protection: '----r-e-' });
    const m = (await stashDriver.read(ctx, P('STASH:/t.zip/src/readme.txt')))!;
    expect(new TextDecoder().decode(m.bytes)).toMatch(/^The quick brown fox/);
    expect(m.date?.toISOString()).toBe('2026-09-11T14:47:48.000Z');
    expect(await stashDriver.read(ctx, P('STASH:/Mods'))).toBeNull();
    expect(await stashDriver.read(ctx, P('STASH:/Mods/arriving.mod'))).toBeNull();
  });
  it('collects a stored file with its blob, and refuses a folder with a file still arriving', async () => {
    const items = (await stashDriver.collect(ctx, P('STASH:/ReadMe')))!;
    expect(items).toEqual([expect.objectContaining({ rel: ['ReadMe'], kind: 'file', protection: 5, comment: 'top', sha256: expect.any(String) })]);
    // Ruling 13: a stored file's bytes stay in the store until a writer needs them.
    expect(items[0].bytes).toBeUndefined();
    await expect(stashDriver.collect(ctx, P('STASH:/Mods'))).rejects.toMatchObject({ refusal: { code: 'unsupported', detail: 'still arriving from the Amiga' } });
  });
  it('collects a folder: itself, then every file under it', async () => {
    await stash('Docs/a.txt', enc('a'));
    await stash('Docs/Deep/b.txt', enc('bb'));
    const items = (await stashDriver.collect(ctx, P('STASH:/docs')))!;
    expect(items.map((i) => [i.rel.join('/'), i.kind, i.sha256 ? 'sha' : '-'])).toEqual([
      ['Docs', 'dir', '-'], ['Docs/a.txt', 'file', 'sha'], ['Docs/Deep', 'dir', '-'], ['Docs/Deep/b.txt', 'file', 'sha']]);
  });
  it('collects an archive folder from its members', async () => {
    const items = (await stashDriver.collect(ctx, P('STASH:/t.zip/src/sub')))!;
    expect(items.map((i) => [i.rel.join('/'), i.kind])).toEqual([['sub', 'dir'], ['sub/deep.txt', 'file']]);
    expect(items[1].bytes).toBeInstanceOf(Uint8Array);
    expect(items[1].sha256).toBeUndefined();
  });
  it('a stored file whose blob is gone is blob_unavailable', async () => {
    await getDb().insert(amigaUploads).values({ id: 'gone1', orgId: 'o1', deviceId: null, deviceName: null, source: 'browser', path: 'Gone.txt',
      sizeBytes: 3, receivedBytes: 3, amigaDate: '17000.0.0', status: 'stored', blobSha256: 'f'.repeat(64), expiresAt: new Date(Date.now() + 3600_000) });
    await expect(stashDriver.read(ctx, P('STASH:/Gone.txt'))).rejects.toMatchObject({ refusal: { code: 'blob_unavailable' }, status: 503 });
  });
});
