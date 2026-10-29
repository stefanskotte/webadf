// src/lib/stash.db.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_stash_test';
const url = new URL(base); url.pathname = `/${DB}`; process.env.DATABASE_URL = url.toString();
process.env.STORAGE_DIR ??= (await import('node:fs')).mkdtempSync('/tmp/webadf-stash-');
process.env.BLOB_READ_WRITE_TOKEN = '';
async function admin(stmt: string) { const c = new Client({ connectionString: base }); await c.connect(); try { await c.query(stmt); } finally { await c.end(); } }

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { eq } = await import('drizzle-orm');
const { crc32 } = await import('node:zlib');
const { organization } = await import('@/db/schema/auth');
const { devices } = await import('@/db/schema/devices');
const { amigaUploads, amigaUploadChunks } = await import('@/db/schema/amiga-uploads');
const { insertStash, listStash, deleteStash, moveStash, setStashMeta, STASH_FULL, StashBusy } = await import('./stash');
const { openUpload, storeChunk, closeUpload, listUploads, clearUploads } = await import('./amiga-uploads');

const db = () => getDb();
const file = (path: string, size = 5) => ({ path, kind: 'file' as const, sha256: 'a'.repeat(64), sizeBytes: size, date: new Date(Date.UTC(2020, 0, 2)), protection: 0, comment: '' });
async function upload(path: string, data: Buffer, date: string) {
  const o = await openUpload(db(), { deviceId: 'dev1', orgId: 'o1' }, { size: data.length, date, protection: 0, path, comment: '' });
  if (!o.ok) throw new Error(o.code);
  if (data.length) await storeChunk(db(), 'dev1', o.id, 0, new Uint8Array(data));
  return { id: o.id, close: await closeUpload(db(), 'dev1', o.id, crc32(data) >>> 0) };
}

beforeAll(async () => {
  await admin(`drop database if exists ${DB} with (force)`);
  await admin(`create database ${DB}`);
  await migrate(db(), { migrationsFolder: 'drizzle' });
  await db().insert(organization).values([{ id: 'o1', name: 'o1', slug: 'o1', createdAt: new Date() }, { id: 'o2', name: 'o2', slug: 'o2', createdAt: new Date() }]);
  await db().insert(devices).values({ id: 'dev1', orgId: 'o1', name: 'A500 bench', macAddress: 'AA:BB:CC:DD:EE:01', tokenHash: 'h1' });
});
afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

describe('STASH: store', () => {
  it('inserts browser files and an empty folder, listed with source, kind and date; another org sees nothing', async () => {
    const r = await insertStash(db(), 'o1', 'browser', [file('Docs/a.txt'), { ...file('Empty'), kind: 'dir', sha256: null, sizeBytes: 0 }]);
    expect(r.ok).toBe(true);
    const rows = await listStash(db(), 'o1');
    expect(rows.map((x) => [x.path, x.kind, x.source, x.status, x.deviceName])).toEqual([
      ['Docs/a.txt', 'file', 'browser', 'stored', null], ['Empty', 'dir', 'browser', 'stored', null]]);
    expect(rows[0].date?.toISOString()).toBe('2020-01-02T00:00:00.000Z');
    expect(await listStash(db(), 'o2')).toEqual([]);
  });
  it('the Upload page lists only files from the Amiga, and its Clear all leaves STASH: rows', async () => {
    await upload('From/amiga.txt', Buffer.from('hi'), '17000.600.0');
    expect((await listUploads(db(), 'o1', null)).map((u) => u.path)).toEqual(['From/amiga.txt']);
    const views = await listUploads(db(), 'o1', null);
    await clearUploads(db(), 'o1', views[0].cursor);
    expect((await listStash(db(), 'o1')).map((x) => x.path)).toEqual(['Docs/a.txt', 'Empty']);
  });
  it('a second upload of the same path keeps both: the newcomer is stored as name_1, and the board hears its own name', async () => {
    const one = await upload('Mods/ReadMe', Buffer.from('one'), '17000.600.0');
    const two = await upload('mods/readme', Buffer.from('two'), '17001.600.0');
    expect(two.close).toEqual({ ok: true, name: 'mods/readme' });
    const paths = (await listStash(db(), 'o1')).filter((x) => x.source === 'amiga').map((x) => x.path);
    expect(paths).toEqual(expect.arrayContaining(['Mods/ReadMe', 'Mods/readme_1']));
    await deleteStash(db(), 'o1', [one.id, two.id]);
  });
  it('refuses a batch that would pass 500 entries, inserting nothing', async () => {
    const live = (await listStash(db(), 'o1')).length;
    const fill = Array.from({ length: 500 - live - 1 }, (_, i) => file(`Fill/f${i}`, 1));
    expect((await insertStash(db(), 'o1', 'copy', fill)).ok).toBe(true);
    expect(await insertStash(db(), 'o1', 'copy', [file('x1', 1), file('x2', 1)])).toEqual({ ok: false, code: 'stash_full' });
    expect((await listStash(db(), 'o1')).length).toBe(499);
    const fillIds = (await listStash(db(), 'o1')).filter((x) => x.path.startsWith('Fill/')).map((x) => x.id);
    expect(await deleteStash(db(), 'o1', fillIds)).toBe(fillIds.length);
  });
  it('refuses a batch that would pass 256 MB; replaced rows do not count', async () => {
    const big = await insertStash(db(), 'o1', 'copy', [file('big.bin', 256 * 1024 * 1024 - 10)]);
    expect(big.ok).toBe(true);
    expect(await insertStash(db(), 'o1', 'copy', [file('y', 11)])).toEqual({ ok: false, code: 'stash_full' });
    const ids = (big as { ids: string[] }).ids;
    expect((await insertStash(db(), 'o1', 'copy', [file('big.bin', 20)], { replaceIds: ids })).ok).toBe(true);
    expect(STASH_FULL).toMatch(/500 files \/ 256 MB/);
  });
  it('moves paths and sets protection and comment on the org\'s rows only', async () => {
    const [a] = (await listStash(db(), 'o1')).filter((x) => x.path === 'Docs/a.txt');
    await moveStash(db(), 'o1', [{ id: a.id, path: 'Papers/a.txt' }]);
    await setStashMeta(db(), 'o1', [a.id], { protection: 0x05, comment: 'kept' });
    await setStashMeta(db(), 'o2', [a.id], { comment: 'not yours' });
    const [b] = (await listStash(db(), 'o1')).filter((x) => x.id === a.id);
    expect([b.path, b.protection, b.comment]).toEqual(['Papers/a.txt', 5, 'kept']);
  });
  it('a repeated close of a keep-both file hears the name the board sent, not the stored one (ruling 10)', async () => {
    const one = await upload('Rep/Same', Buffer.from('one'), '17000.600.0');
    const data = Buffer.from('two');
    const two = await upload('rep/same', data, '17001.600.0');
    expect(two.close).toEqual({ ok: true, name: 'rep/same' });
    expect((await listStash(db(), 'o1')).find((x) => x.id === two.id)!.path).toBe('Rep/same_1');
    expect(await closeUpload(db(), 'dev1', two.id, crc32(data) >>> 0)).toEqual({ ok: true, name: 'rep/same' });
    await deleteStash(db(), 'o1', [one.id, two.id]);
  });
  it('a folder row is kept alive when a file arrives under it (ruling 16)', async () => {
    const t0 = new Date(Date.UTC(2026, 0, 1));
    const dir = await insertStash(db(), 'o1', 'browser', [{ ...file('Keep'), kind: 'dir', sha256: null, sizeBytes: 0 }], { now: t0 });
    const id = (dir as { ids: string[] }).ids[0];
    const t1 = new Date(Date.UTC(2026, 0, 20));
    await insertStash(db(), 'o1', 'browser', [file('keep/inside.txt')], { now: t1 });
    const [row] = await db().select().from(amigaUploads).where(eq(amigaUploads.id, id));
    expect(row.expiresAt.getTime()).toBe(t1.getTime() + 30 * 24 * 3600_000);
    // an Amiga upload under it does the same
    await db().update(amigaUploads).set({ expiresAt: new Date(Date.now() + 3600_000) }).where(eq(amigaUploads.id, id));
    const up = await upload('Keep/amiga.txt', Buffer.from('x'), '17000.600.0');
    const [row2] = await db().select().from(amigaUploads).where(eq(amigaUploads.id, id));
    expect(row2.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600_000);
    const live = (await listStash(db(), 'o1')).filter((x) => /^keep/i.test(x.path)).map((x) => x.id);
    await deleteStash(db(), 'o1', live);
    void up;
  });
  it('refuses to move a subtree holding a file still arriving from the Amiga (ruling 6)', async () => {
    const o = await openUpload(db(), { deviceId: 'dev1', orgId: 'o1' }, { size: 10, date: '17000.600.0', path: 'Arr/part.bin', comment: '', protection: 0 });
    if (!o.ok) throw new Error(o.code);
    await expect(moveStash(db(), 'o1', [{ id: o.id, path: 'Arr2/part.bin' }])).rejects.toBeInstanceOf(StashBusy);
    await expect(moveStash(db(), 'o1', [{ id: o.id, path: 'Arr2/part.bin' }])).rejects.toThrow('still arriving from the Amiga');
    expect((await listStash(db(), 'o1')).find((x) => x.id === o.id)!.path).toBe('Arr/part.bin');
    await deleteStash(db(), 'o1', [o.id]);
  });
  it('a retry after a CRC-failed upload is stored under the plain name, not name_1', async () => {
    const bad = await upload('Retry/X.bin', Buffer.from('abc'), '17000.600.0');
    // upload() closed with the right CRC; make a failed stub by closing another with a wrong one
    await deleteStash(db(), 'o1', [bad.id]);
    const o = await openUpload(db(), { deviceId: 'dev1', orgId: 'o1' }, { size: 3, date: '17005.600.0', path: 'Retry/X.bin', comment: '', protection: 0 });
    if (!o.ok) throw new Error(o.code);
    await storeChunk(db(), 'dev1', o.id, 0, new Uint8Array(Buffer.from('abc')));
    expect(await closeUpload(db(), 'dev1', o.id, 1)).toMatchObject({ ok: false, code: 'crc' });
    const good = await upload('Retry/X.bin', Buffer.from('abc'), '17006.600.0');
    expect(good.close).toEqual({ ok: true, name: 'Retry/X.bin' });
    const rows = await listStash(db(), 'o1');
    expect(rows.find((x) => x.id === good.id)!.path).toBe('Retry/X.bin');
    await deleteStash(db(), 'o1', [o.id, good.id]);
  });
  it('ruling 16: a folder row under a folder, and a move into a folder, refresh every ancestor', async () => {
    const t0 = new Date(Date.UTC(2026, 0, 1));
    const mk = async (path: string) => ((await insertStash(db(), 'o1', 'browser', [{ ...file(path), kind: 'dir', sha256: null, sizeBytes: 0 }], { now: t0 })) as { ids: string[] }).ids[0];
    const a = await mk('Anc'); const b = await mk('Anc/Mid');
    const exp = async (id: string) => (await db().select().from(amigaUploads).where(eq(amigaUploads.id, id)))[0].expiresAt.getTime();
    const t1 = new Date(Date.UTC(2026, 0, 10));
    const c = await mk2('Anc/Mid/Leaf', t1);
    expect(await exp(a)).toBe(t1.getTime() + 30 * 24 * 3600_000);
    expect(await exp(b)).toBe(t1.getTime() + 30 * 24 * 3600_000);
    const [f] = ((await insertStash(db(), 'o1', 'browser', [file('loose.txt')], { now: t0 })) as { ids: string[] }).ids;
    const t2 = new Date(Date.UTC(2026, 0, 20));
    await moveStash(db(), 'o1', [{ id: f, path: 'Anc/Mid/loose.txt' }], t2);
    expect(await exp(a)).toBe(t2.getTime() + 30 * 24 * 3600_000);
    expect(await exp(b)).toBe(t2.getTime() + 30 * 24 * 3600_000);
    await deleteStash(db(), 'o1', [a, b, c, f]);
    async function mk2(path: string, now: Date) { return ((await insertStash(db(), 'o1', 'browser', [{ ...file(path), kind: 'dir', sha256: null, sizeBytes: 0 }], { now })) as { ids: string[] }).ids[0]; }
  });
  it('another org\'s ids are ignored by delete, move, meta and replaceIds', async () => {
    const [x] = ((await insertStash(db(), 'o2', 'browser', [file('theirs.txt')])) as { ids: string[] }).ids;
    expect(await deleteStash(db(), 'o1', [x])).toBe(0);
    await moveStash(db(), 'o1', [{ id: x, path: 'mine.txt' }]);
    await setStashMeta(db(), 'o1', [x], { comment: 'mine', protection: 7 });
    const r = await insertStash(db(), 'o1', 'copy', [file('new.txt')], { replaceIds: [x] });
    expect(r.ok).toBe(true);
    const [row] = await db().select().from(amigaUploads).where(eq(amigaUploads.id, x));
    expect([row.status, row.path, row.comment, row.protection]).toEqual(['stored', 'theirs.txt', '', 0]);
    await deleteStash(db(), 'o2', [x]);
    await deleteStash(db(), 'o1', (r as { ids: string[] }).ids);
  });
  it('replaceIds of another org\'s receiving row leaves its row and chunks alone', async () => {
    await db().insert(devices).values({ id: 'dev2', orgId: 'o2', name: 'Other', macAddress: 'AA:BB:CC:DD:EE:02', tokenHash: 'h2' });
    const o = await openUpload(db(), { deviceId: 'dev2', orgId: 'o2' }, { size: 20000, date: '17000.600.0', path: 'Inflight', comment: '', protection: 0 });
    if (!o.ok) throw new Error(o.code);
    await storeChunk(db(), 'dev2', o.id, 0, new Uint8Array(16384));
    const r = await insertStash(db(), 'o1', 'copy', [file('z.txt')], { replaceIds: [o.id] });
    expect(r.ok).toBe(true);
    const chunks = await db().select().from(amigaUploadChunks).where(eq(amigaUploadChunks.uploadId, o.id));
    const [row] = await db().select().from(amigaUploads).where(eq(amigaUploads.id, o.id));
    expect([chunks.length, row.status]).toEqual([1, 'receiving']);
    await deleteStash(db(), 'o1', (r as { ids: string[] }).ids);
    await deleteStash(db(), 'o2', [o.id]);
  });
});
