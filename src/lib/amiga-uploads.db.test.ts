import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { eq, sql } from 'drizzle-orm';

// A database of its own (the shared one is the live one).
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_amiga_uploads_test';
const url = new URL(base);
url.pathname = `/${DB}`;
process.env.DATABASE_URL = url.toString();
const storageDir = mkdtempSync(join(tmpdir(), 'webadf-amiga-uploads-'));
process.env.STORAGE_DIR = storageDir;
process.env.BLOB_READ_WRITE_TOKEN = '';

async function admin(stmt: string) {
  const c = new Client({ connectionString: base });
  await c.connect();
  try { await c.query(stmt); } finally { await c.end(); }
}

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { devices } = await import('@/db/schema/devices');
const { transfers } = await import('@/db/schema/transfers');
const { amigaUploads, amigaUploadChunks } = await import('@/db/schema/amiga-uploads');
const { diskStore } = await import('@/lib/storage');
const { recordStatus } = await import('@/lib/mount');
const U = await import('./amiga-uploads');

const db = () => getDb();
let n = 0;
async function device(orgId = 'org-a', name = 'Bench', firmwareVersion: string | null = null) {
  const id = `dev-${++n}`;
  await db().insert(devices).values({ id, orgId, name, tokenHash: `hash-${id}`, firmwareVersion });
  return { deviceId: id, orgId };
}
type Dev = { deviceId: string; orgId: string };
const open = (d: Dev, extra: Partial<Parameters<typeof U.openUpload>[2]> = {}, now?: Date) =>
  U.openUpload(db(), d, { size: 5, date: '1.2.3', protection: 0, path: 'Hello.txt', comment: '', ...extra }, now);
const opened = async (d: Dev, extra: Partial<Parameters<typeof U.openUpload>[2]> = {}) => {
  const r = await open(d, extra);
  if (!r.ok) throw new Error(`open refused: ${r.code}`);
  return r;
};
const row = async (id: string) => (await db().select().from(amigaUploads).where(eq(amigaUploads.id, id)))[0];
const chunkRows = async (id: string) => (await db().select().from(amigaUploadChunks).where(eq(amigaUploadChunks.uploadId, id))).length;
const bytes = (len: number, seed = 1) => { const b = new Uint8Array(len); let x = seed; for (let i = 0; i < len; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; } return b; };
const crc = (b: Uint8Array) => crc32(b) >>> 0;
async function upload(d: Dev, data: Uint8Array, path = 'File.bin') {
  const o = await opened(d, { size: data.byteLength, path });
  for (let at = o.offset; at < data.byteLength; at += 16384) {
    expect((await U.storeChunk(db(), d.deviceId, o.id, at, data.subarray(at, Math.min(at + 16384, data.byteLength)))).ok).toBe(true);
  }
  return o.id;
}
async function stored(d: Dev, data: Uint8Array, path = 'File.bin') {
  const id = await upload(d, data, path);
  expect((await U.closeUpload(db(), d.deviceId, id, crc(data))).ok).toBe(true);
  return id;
}
const later = () => new Date(Date.now() + 3600_000);
const filler = (orgId: string, deviceId: string, k: number) => Array.from({ length: k }, (_, i) => ({
  id: `${orgId}-fill-${i}`, orgId, deviceId, deviceName: 'B', path: `f${i}`, sizeBytes: 1, amigaDate: '1.1.1', status: 'stored', expiresAt: later(),
}));

describe('amiga uploads', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
  });
  afterAll(async () => {
    await closeDb();
    await admin(`drop database if exists ${DB} with (force)`);
    rmSync(storageDir, { recursive: true, force: true });
  });

  it("opens at 0 with the board's name, a cleaned path and a 24 h window", async () => {
    const d = await device('org-a', 'Bench A500');
    const now = new Date('2026-10-20T10:00:00Z');
    const r = await U.openUpload(db(), d, { size: 5, date: '1.2.3', protection: 0x40, path: '../Up/Hello.txt', comment: 'a\u0007b' }, now);
    expect(r).toMatchObject({ ok: true, offset: 0 });
    const t = await row((r as { id: string }).id);
    expect(t).toMatchObject({ deviceName: 'Bench A500', path: 'Up/Hello.txt', status: 'receiving', protection: 0x40, comment: 'ab', amigaDate: '1.2.3' });
    expect(t.expiresAt.getTime() - now.getTime()).toBe(24 * 3600_000);
  });

  it('a Latin-1 path is stored as UTF-8', async () => {
    const t = await row((await opened(await device(), { path: 'Café.txt' })).id);
    expect(t.path).toBe('Café.txt');
    expect(Buffer.byteLength(t.path, 'utf8')).toBe(9);
  });

  it('refuses a file over 4 MB and a name that cleans to nothing', async () => {
    const d = await device();
    expect(await open(d, { size: 4_194_305 })).toEqual({ ok: false, code: 'size' });
    expect(await open(d, { path: '../..' })).toEqual({ ok: false, code: 'name' });
  });

  it('resumes the same file from the same board within 24 h, and only that', async () => {
    const d = await device(); const data = bytes(40000);
    const o = await opened(d, { size: 40000 });
    await U.storeChunk(db(), d.deviceId, o.id, 0, data.subarray(0, 16384));
    expect(await open(d, { size: 40000 })).toEqual({ ok: true, id: o.id, offset: 16384 });
    expect((await opened(d, { size: 40000, date: '1.2.4' })).id).not.toBe(o.id);
    expect((await opened(await device(), { size: 40000 })).id).not.toBe(o.id);
    const r = await open(d, { size: 40000 }, new Date(Date.now() + 25 * 3600_000));
    expect(r.ok && r.id).not.toBe(o.id);
  });

  it('stores chunks in order: a repeated chunk is not stored twice, a gap is 409, a short chunk mid-file is 400', async () => {
    const d = await device(); const data = bytes(40000);
    const o = await opened(d, { size: 40000 });
    expect(await U.storeChunk(db(), d.deviceId, o.id, 0, data.subarray(0, 16384))).toEqual({ ok: true, received: 16384 });
    expect(await U.storeChunk(db(), d.deviceId, o.id, 0, data.subarray(0, 16384))).toEqual({ ok: true, received: 16384 });
    expect(await chunkRows(o.id)).toBe(1);
    expect(await U.storeChunk(db(), d.deviceId, o.id, 32768, data.subarray(32768))).toEqual({ ok: false, status: 409, received: 16384 });
    expect(await U.storeChunk(db(), d.deviceId, o.id, 16384, data.subarray(16384, 20000))).toEqual({ ok: false, status: 400 });
    expect(await U.storeChunk(db(), d.deviceId, o.id, 16384, new Uint8Array(16385))).toEqual({ ok: false, status: 400 });
    expect(await U.storeChunk(db(), 'dev-nobody', o.id, 16384, data.subarray(16384, 32768))).toEqual({ ok: false, status: 404 });
  });

  it('closes: size and CRC checked, the bytes in the store, the chunks gone, kept 30 days; a repeat answers the same name', async () => {
    const d = await device(); const data = bytes(40000);
    const id = await upload(d, data);
    const now = new Date();
    expect(await U.closeUpload(db(), d.deviceId, id, crc(data), now)).toEqual({ ok: true, name: 'File.bin' });
    const t = await row(id);
    expect(t).toMatchObject({ status: 'stored', crc32: crc(data), receivedBytes: 40000 });
    expect(Buffer.compare(Buffer.from(await diskStore.read(t.blobSha256!)), Buffer.from(data))).toBe(0);
    expect(await chunkRows(id)).toBe(0);
    expect(t.expiresAt.getTime() - now.getTime()).toBe(30 * 24 * 3600_000);
    expect(await U.closeUpload(db(), d.deviceId, id, crc(data))).toEqual({ ok: true, name: 'File.bin' });
  });

  it('a CRC mismatch is final: failed crc, the chunks gone, and the next send starts at 0', async () => {
    const d = await device(); const data = bytes(20000);
    const id = await upload(d, data, 'Bad.bin');
    expect(await U.closeUpload(db(), d.deviceId, id, crc(data) ^ 1)).toEqual({ ok: false, status: 409, code: 'crc' });
    expect(await row(id)).toMatchObject({ status: 'failed', errorCode: 'crc' });
    expect(await chunkRows(id)).toBe(0);
    const again = await opened(d, { size: 20000, path: 'Bad.bin' });
    expect(again.id).not.toBe(id); expect(again.offset).toBe(0);
  });

  it('a close before every chunk is in is refused, and the upload stays resumable', async () => {
    const d = await device(); const data = bytes(40000);
    const o = await opened(d, { size: 40000, path: 'Half.bin' });
    await U.storeChunk(db(), d.deviceId, o.id, 0, data.subarray(0, 16384));
    expect(await U.closeUpload(db(), d.deviceId, o.id, crc(data))).toEqual({ ok: false, status: 409, code: 'size' });
    expect(await open(d, { size: 40000, path: 'Half.bin' })).toEqual({ ok: true, id: o.id, offset: 16384 });
  });

  it('an empty file is stored', async () => {
    const d = await device();
    const o = await opened(d, { size: 0, path: 'Empty' });
    expect(await U.closeUpload(db(), d.deviceId, o.id, 0)).toEqual({ ok: true, name: 'Empty' });
    expect((await row(o.id)).blobSha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('a full but unclosed upload resumes at its size and closes', async () => {
    const d = await device(); const data = bytes(20000);
    const id = await upload(d, data, 'Full.bin');
    expect(await open(d, { size: 20000, path: 'Full.bin' })).toEqual({ ok: true, id, offset: 20000 });
    expect(await U.closeUpload(db(), d.deviceId, id, crc(data))).toEqual({ ok: true, name: 'Full.bin' });
  });

  it('the area counts only rows that still count: 500 files and 256 MB per org', async () => {
    const d = await device('org-limits');
    await db().insert(amigaUploads).values(filler('org-limits', d.deviceId, 499));
    await db().insert(amigaUploads).values([
      { id: 'lim-old', orgId: 'org-limits', deviceId: d.deviceId, deviceName: 'B', path: 'old', sizeBytes: 1, amigaDate: '1.1.1', status: 'stored', expiresAt: new Date(Date.now() - 1000) },
      { id: 'lim-gone', orgId: 'org-limits', deviceId: d.deviceId, deviceName: 'B', path: 'gone', sizeBytes: 1, amigaDate: '1.1.1', status: 'deleted', expiresAt: later() },
      { id: 'lim-bad', orgId: 'org-limits', deviceId: d.deviceId, deviceName: 'B', path: 'bad', sizeBytes: 1, amigaDate: '1.1.1', status: 'failed', expiresAt: later() },
    ]);
    expect((await open(d, { path: 'n500' })).ok).toBe(true);
    expect(await open(d, { path: 'n501' })).toEqual({ ok: false, code: 'full' });
    const e = await device('org-bytes');
    await db().insert(amigaUploads).values({ id: 'huge', orgId: 'org-bytes', deviceId: e.deviceId, deviceName: 'B', path: 'h',
      sizeBytes: 256 * 1024 * 1024 - 10, amigaDate: '1.1.1', status: 'stored', expiresAt: later() });
    expect(await open(e, { size: 11, path: 'one-too-many' })).toEqual({ ok: false, code: 'full' });
    expect((await open(e, { size: 10, path: 'fits' })).ok).toBe(true);
  });

  it('two opens at once with room for one: exactly one passes', async () => {
    const d = await device('org-race');
    await db().insert(amigaUploads).values(filler('org-race', d.deviceId, 499));
    const [a, b] = await Promise.all([open(d, { path: 'race-a' }), open(d, { path: 'race-b' })]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it('a 4 MB close stays well inside the 60 s function limit', async () => {
    const d = await device(); const data = bytes(4_194_304, 9);
    const id = await upload(d, data, 'Big.bin');
    const t0 = Date.now();
    const r = await U.closeUpload(db(), d.deviceId, id, crc(data));
    const ms = Date.now() - t0;
    console.log(`  4 MB close: ${ms} ms (256 chunk rows)`);
    expect(r.ok).toBe(true);
    expect(ms).toBeLessThan(20_000);
  }, 120_000);

  it('org scoping: another org never sees, deletes or clears a row', async () => {
    const d = await device('org-own');
    const id = await stored(d, bytes(10), 'Mine.txt');
    expect(await U.getUpload(db(), 'org-other', id)).toBeNull();
    expect(await U.deleteUpload(db(), 'org-other', id)).toBe(false);
    expect(await U.clearUploads(db(), 'org-other', '2999-01-01T00:00:00.000000Z')).toBe(0);
    expect((await U.listUploads(db(), 'org-other', null)).some((r) => r.id === id)).toBe(false);
    expect((await U.getUpload(db(), 'org-own', id))?.status).toBe('stored');
  });

  it('clear spares a newer row and a receiving row; delete drops a row and its chunks', async () => {
    const d = await device('org-clear');
    const s1 = await stored(d, bytes(10, 2), 'One.txt');
    const recv = await opened(d, { size: 40000, path: 'Moving.bin' });
    await U.storeChunk(db(), d.deviceId, recv.id, 0, bytes(16384, 3));
    const seen = (await U.listUploads(db(), 'org-clear', null))[0].cursor;   // the newest row the person saw
    const s2 = await stored(d, bytes(10, 4), 'Two.txt');          // arrived while the confirm was open
    expect(await U.clearUploads(db(), 'org-clear', seen)).toBe(1);
    expect((await row(s1)).status).toBe('deleted');
    expect((await row(s2)).status).toBe('stored');
    expect((await row(recv.id)).status).toBe('receiving');
    expect(await U.deleteUpload(db(), 'org-clear', recv.id)).toBe(true);
    expect((await row(recv.id)).status).toBe('deleted');
    expect(await chunkRows(recv.id)).toBe(0);
    expect((await U.listUploads(db(), 'org-clear', null)).map((r) => r.id)).toEqual([s2]);
  });

  it('clear keeps a row created microseconds after the newest one the person saw (ruling PF4)', async () => {
    const d = await device('org-micro');
    const at = (us: string) => sql`${'2026-10-20 10:00:00.' + us + '+00'}::timestamptz` as unknown as Date;
    const mk = (id: string, us: string) => ({ id, orgId: 'org-micro', deviceId: d.deviceId, deviceName: 'B', path: id, sizeBytes: 1,
      amigaDate: '1.1.1', status: 'stored', createdAt: at(us), expiresAt: later() });
    await db().insert(amigaUploads).values([mk('m-old', '000100'), mk('m-new', '000900')]);
    // Both are the same millisecond: a Date (ms) could not tell them apart.
    await db().delete(amigaUploads).where(eq(amigaUploads.id, 'm-new'));
    const seen = (await U.listUploads(db(), 'org-micro', null))[0].cursor;
    expect(seen).toBe('2026-10-20T10:00:00.000100Z');
    await db().insert(amigaUploads).values(mk('m-new', '000900'));
    expect(await U.clearUploads(db(), 'org-micro', seen)).toBe(1);
    expect((await row('m-old')).status).toBe('deleted');
    expect((await row('m-new')).status).toBe('stored');
    await expect(U.clearUploads(db(), 'org-micro', "x'; drop table amiga_uploads; --")).rejects.toThrow(RangeError);
  });

  it('clear with a board clears only that board, up to the cursor the filtered list gave', async () => {
    const a = await device('org-board'); const b = await device('org-board');
    const a1 = await stored(a, bytes(10, 40), 'A1.txt');
    const b1 = await stored(b, bytes(10, 41), 'B1.txt');
    const a2 = await stored(a, bytes(10, 42), 'A2.txt');
    const seen = (await U.listUploads(db(), 'org-board', a.deviceId))[0].cursor;   // newest of board a's list: a2
    const b2 = await stored(b, bytes(10, 43), 'B2.txt');
    expect(await U.clearUploads(db(), 'org-board', seen, a.deviceId)).toBe(2);
    expect((await row(a1)).status).toBe('deleted'); expect((await row(a2)).status).toBe('deleted');
    expect((await row(b1)).status).toBe('stored');   // older than the cursor, but another board
    expect((await row(b2)).status).toBe('stored');
  });

  it('a cursor has one exact shape; anything else is rejected before SQL', async () => {
    expect(U.isUploadCursor('2026-10-20T10:00:00.000100Z')).toBe(true);
    for (const bad of ['2026-10-20 10:00:00.000100+00', '2026-10-20T10:00:00Z', '2026-10-20T10:00:00.000100+02:00',
      '2026-13-20T10:00:00.000100Z', '2026-02-30T10:00:00.000100Z', '2026-10-20T24:00:00.000000Z', '', 5, null]) {
      expect(U.isUploadCursor(bad)).toBe(false);
    }
    await expect(U.clearUploads(db(), 'org-micro', '2026-02-30T10:00:00.000100Z')).rejects.toThrow(RangeError);
    const d = await device('org-shape');
    await stored(d, bytes(5, 20), 'S.txt');
    expect(U.isUploadCursor((await U.listUploads(db(), 'org-shape', null))[0].cursor)).toBe(true);
  });

  it('the resume lookup is scoped by org as well as board', async () => {
    const d = await device('org-res-a');
    const o = await opened(d, { path: 'Moved.bin' });
    const r = await U.openUpload(db(), { deviceId: d.deviceId, orgId: 'org-res-b' }, { size: 5, date: '1.2.3', protection: 0, path: 'Moved.bin', comment: '' });
    expect(r.ok && r.id).not.toBe(o.id);
  });

  it('a close that loses the race to a delete answers gone and revives nothing', async () => {
    for (const goodCrc of [true, false]) {
      const d = await device('org-race-close'); const data = bytes(20000, goodCrc ? 30 : 31);
      const id = await upload(d, data, `Race${goodCrc}.bin`);
      const racy = new Proxy(db(), {
        get(t, k) {
          if (k === 'transaction') return async (fn: never) => { await U.deleteUpload(db(), 'org-race-close', id); return t.transaction(fn); };
          const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v;
        },
      });
      expect(await U.closeUpload(racy, d.deviceId, id, goodCrc ? crc(data) : crc(data) ^ 1)).toEqual({ ok: false, status: 404, code: 'gone' });
      expect(await row(id)).toMatchObject({ status: 'deleted', errorCode: null });
    }
  });

  // Increment-2 review, item 2: the board retries a close after its 30 s read timeout while the first still runs.
  it('two closes at once both answer ok with the name; a repeat with another CRC is not ok', async () => {
    const d = await device('org-close-twice'); const data = bytes(40000, 40);
    const id = await upload(d, data, 'Twice.bin');
    // Deterministic: the other close finishes between this one's checks and its guarded update.
    const racy = new Proxy(db(), {
      get(t, k) {
        if (k === 'transaction') return async (fn: never) => {
          expect(await U.closeUpload(db(), d.deviceId, id, crc(data))).toEqual({ ok: true, name: 'Twice.bin' });
          return t.transaction(fn);
        };
        const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    expect(await U.closeUpload(racy, d.deviceId, id, crc(data))).toEqual({ ok: true, name: 'Twice.bin' });
    expect(await row(id)).toMatchObject({ status: 'stored', crc32: crc(data) });
    expect(await U.closeUpload(db(), d.deviceId, id, crc(data) ^ 1)).toEqual({ ok: false, status: 409, code: 'gone' });
    // And truly at once.
    const data2 = bytes(40000, 41);
    const id2 = await upload(d, data2, 'Twice2.bin');
    const both = await Promise.all([U.closeUpload(db(), d.deviceId, id2, crc(data2)), U.closeUpload(db(), d.deviceId, id2, crc(data2))]);
    expect(both).toEqual([{ ok: true, name: 'Twice2.bin' }, { ok: true, name: 'Twice2.bin' }]);
  });

  // Increment-2 review, item 3: the answer to a CRC-failed close is lost; the board asks again with the same CRC.
  it('a repeat of a CRC-failed close with the same CRC answers crc again; another CRC answers gone', async () => {
    const d = await device('org-crc-repeat'); const data = bytes(20000, 42);
    const id = await upload(d, data, 'Crc.bin');
    const bad = (crc(data) ^ 1) >>> 0;
    expect(await U.closeUpload(db(), d.deviceId, id, bad)).toEqual({ ok: false, status: 409, code: 'crc' });
    expect(await row(id)).toMatchObject({ status: 'failed', errorCode: 'crc', crc32: bad });
    expect(await U.closeUpload(db(), d.deviceId, id, bad)).toEqual({ ok: false, status: 409, code: 'crc' });
    expect(await U.closeUpload(db(), d.deviceId, id, crc(data))).toEqual({ ok: false, status: 409, code: 'gone' });
    // Two CRC-failed closes at once: both hear crc.
    const id2 = await upload(d, data, 'Crc2.bin');
    const both = await Promise.all([U.closeUpload(db(), d.deviceId, id2, bad), U.closeUpload(db(), d.deviceId, id2, bad)]);
    expect(both).toEqual([{ ok: false, status: 409, code: 'crc' }, { ok: false, status: 409, code: 'crc' }]);
  });

  it('lists newest first, filtered by board, with the board on each row; a lapsed partial reads failed', async () => {
    const a = await device('org-list', 'Bench'); const b = await device('org-list', 'Den');
    await stored(a, bytes(5, 5), 'A.txt');
    const o = await opened(b, { path: 'B.txt' });
    const all = await U.listUploads(db(), 'org-list', null);
    expect(all.map((r) => r.path)).toEqual(['B.txt', 'A.txt']);
    expect(all.map((r) => r.deviceName)).toEqual(['Den', 'Bench']);
    expect((await U.listUploads(db(), 'org-list', a.deviceId)).map((r) => r.path)).toEqual(['A.txt']);
    const lapsed = await U.listUploads(db(), 'org-list', b.deviceId, new Date(Date.now() + 25 * 3600_000));
    expect(lapsed[0]).toMatchObject({ id: o.id, status: 'failed', errorCode: 'expired' });
  });

  it('the boards for the filter, with their key digits and whether they can upload', async () => {
    const a = await device('org-boards', 'Bench', '1.19.0+gabc');
    await device('org-boards', 'Old', '1.18.2+gdef');
    await recordStatus(a.deviceId, { mountedSha256: null, upKey: 'ab12' });
    expect(await U.uploadBoards(db(), 'org-boards')).toEqual([
      { id: a.deviceId, name: 'Bench', key: 'AB12', canUpload: true },
      { id: expect.any(String), name: 'Old', key: null, canUpload: false },
    ]);
  });

  it('counts files stored within 24 h per board, for the card', async () => {
    const d = await device('org-card');
    await stored(d, bytes(5, 6), 'C1'); await stored(d, bytes(5, 7), 'C2');
    expect(await U.uploadSummaries(db(), 'org-card')).toEqual({ [d.deviceId]: 2 });
    expect(await U.uploadSummaries(db(), 'org-card', new Date(Date.now() + 25 * 3600_000))).toEqual({});
  });

  it('names the blobs an upload or a transfer still holds', async () => {
    const d = await device('org-refs');
    const id = await stored(d, bytes(7, 8), 'Ref.bin');
    const sha = (await row(id)).blobSha256!;
    await db().insert(transfers).values({ id: 't-ref', orgId: 'org-refs', deviceId: d.deviceId, createdByUserId: 'u', path: 'x',
      sizeBytes: 1, crc32: 0, blobSha256: 'f'.repeat(64), expiresAt: later() });
    expect((await U.blobRefsElsewhere(db(), [sha, 'f'.repeat(64), 'e'.repeat(64)])).sort()).toEqual([sha, 'f'.repeat(64)].sort());
    await U.deleteUpload(db(), 'org-refs', id);
    expect(await U.blobRefsElsewhere(db(), [sha])).toEqual([]);
  });

  // Last: it moves the clock for every row in this database.
  it('housekeeping: a partial over 24 h fails expired; stored rows past 30 days and old deleted rows go', async () => {
    const d = await device('org-cron');
    const part = await opened(d, { size: 40000, path: 'Part.bin' });
    await U.storeChunk(db(), d.deviceId, part.id, 0, bytes(16384, 10));
    const keep = await stored(d, bytes(5, 11), 'Keep.txt');
    const gone = await stored(d, bytes(5, 12), 'Gone.txt');
    await U.deleteUpload(db(), 'org-cron', gone);
    const r1 = await U.expireUploads(db(), new Date(Date.now() + 25 * 3600_000));
    expect(r1.failed).toBeGreaterThanOrEqual(1);
    expect(await row(part.id)).toMatchObject({ status: 'failed', errorCode: 'expired' });
    expect(await chunkRows(part.id)).toBe(0);
    expect((await row(keep)).status).toBe('stored');
    const r2 = await U.expireUploads(db(), new Date(Date.now() + 31 * 24 * 3600_000));
    expect(r2.deleted).toBeGreaterThanOrEqual(3);
    expect(await row(keep)).toBeUndefined();
    expect(await row(gone)).toBeUndefined();
    expect(await row(part.id)).toBeUndefined();
  });

  it('recordStatus stores the key digits', async () => {
    const d = await device();
    await recordStatus(d.deviceId, { mountedSha256: null, upKey: 'cd34' });
    expect((await db().select({ k: devices.upKey }).from(devices).where(eq(devices.id, d.deviceId)))[0].k).toBe('cd34');
  });
});
