import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

// A database of its own (the shared one is the live one).
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_staging_server_test';
const url = new URL(base);
url.pathname = `/${DB}`;
process.env.DATABASE_URL = url.toString();
const storageDir = mkdtempSync(join(tmpdir(), 'webadf-staging-server-'));
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
const { blobs, games, disks } = await import('@/db/schema/catalog');
const { uploadFailureText } = await import('./from-amiga-ui');
const S = await import('./staging-server');

const db = () => getDb();
let n = 0;
const later = (ms = 3600_000) => new Date(Date.now() + ms);
const earlier = (ms = 3600_000) => new Date(Date.now() - ms);
const sha = (k: number) => k.toString(16).padStart(64, '0');
async function device(orgId: string, name: string) {
  const id = `dev-${++n}`;
  await db().insert(devices).values({ id, orgId, name, tokenHash: `hash-${id}` });
  return id;
}
async function send(orgId: string, deviceId: string, extra: Partial<typeof transfers.$inferInsert> = {}) {
  const id = `t-${++n}`;
  await db().insert(transfers).values({ id, orgId, deviceId, createdByUserId: 'u', path: `send${n}.txt`, sizeBytes: 8192, crc32: 0,
    blobSha256: sha(900), status: 'queued', expiresAt: later(), ...extra });
  return id;
}
async function up(orgId: string, deviceId: string | null, extra: Partial<typeof amigaUploads.$inferInsert> = {}) {
  const id = `u-${++n}`;
  await db().insert(amigaUploads).values({ id, orgId, deviceId, deviceName: 'Bench', path: `up${n}.adf`, sizeBytes: 901120, amigaDate: '1.1.1',
    status: 'receiving', expiresAt: later(), ...extra });
  return id;
}
const transferExists = async (id: string) => (await db().select().from(transfers).where(eq(transfers.id, id))).length === 1;
const upStatus = async (id: string) => (await db().select().from(amigaUploads).where(eq(amigaUploads.id, id)))[0].status;
const chunkCount = async (id: string) => (await db().select().from(amigaUploadChunks).where(eq(amigaUploadChunks.uploadId, id))).length;
const chunk = (uploadId: string) => db().insert(amigaUploadChunks).values({ uploadId, offset: 0, data: new Uint8Array([1, 2, 3]) });

describe('staging server', () => {
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

  it('lists sends and Amiga files of every board of the org, and nothing of another org', async () => {
    const a1 = await device('org-l', 'Alpha'); const a2 = await device('org-l', 'Beta'); const b1 = await device('org-lx', 'Other');
    const s1 = await send('org-l', a1); const s2 = await send('org-l', a2);
    const u1 = await up('org-l', a1); const u2 = await up('org-l', a2);
    await send('org-lx', b1); await up('org-lx', b1);
    const rows = await S.listStaging(db(), 'org-l');
    expect(rows.map((r) => r.key).sort()).toEqual([`amiga:${u1}`, `amiga:${u2}`, `send:${s1}`, `send:${s2}`].sort());
    const by = (k: string) => rows.find((r) => r.key === k)!;
    expect(by(`send:${s1}`)).toMatchObject({ source: 'server', kind: 'out', id: s1, board: { id: a1, name: 'Alpha' }, status: 'queued', pct: null, error: null, isDiskImage: false, title: null });
    expect(by(`send:${s2}`).board).toEqual({ id: a2, name: 'Beta' });
    expect(by(`amiga:${u1}`)).toMatchObject({ kind: 'in', id: u1, status: 'receiving' });
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].at > rows[i].at || (rows[i - 1].at === rows[i].at && rows[i - 1].key > rows[i].key)).toBe(true);
    }
  });

  it('reads lapsed rows as expired / failed', async () => {
    const d = await device('org-e', 'Bench');
    const s = await send('org-e', d, { expiresAt: earlier() });
    const u = await up('org-e', d, { expiresAt: earlier() });
    const rows = await S.listStaging(db(), 'org-e');
    expect(rows.find((r) => r.id === s)).toMatchObject({ status: 'expired' });
    expect(rows.find((r) => r.id === u)).toMatchObject({ status: 'failed', error: uploadFailureText('expired'), pct: null });
  });

  it('gives progress while moving and the saved name once delivered', async () => {
    const d = await device('org-p', 'Bench');
    const s = await send('org-p', d, { status: 'sending', bytesSent: 4096 });
    const dl = await send('org-p', d, { status: 'delivered', savedAs: 'Work:x', bytesSent: 8192 });
    const u = await up('org-p', d, { receivedBytes: 450560 });
    const rows = await S.listStaging(db(), 'org-p');
    expect(rows.find((r) => r.id === s)).toMatchObject({ status: 'sending', pct: 50, doneBytes: 4096 });
    expect(rows.find((r) => r.id === dl)).toMatchObject({ status: 'delivered', pct: null, savedAs: 'Work:x' });
    expect(rows.find((r) => r.id === u)).toMatchObject({ status: 'receiving', pct: 50, doneBytes: 450560 });
  });

  it('titles a stored file by its library disk, or by the lowest disk id with its sha in the org', async () => {
    const d = await device('org-t', 'Bench');
    await db().insert(blobs).values([1, 2].map((k) => ({ sha256: sha(k), sizeBytes: 100, storageKey: sha(k) })));
    await db().insert(games).values([
      { id: 'gt1', orgId: 'org-t', title: 'Alpha Game', sortTitle: 'alpha game' }, { id: 'gt2', orgId: 'org-t', title: 'Beta Game', sortTitle: 'beta game' },
      { id: 'gt3', orgId: 'org-tx', title: 'Foreign', sortTitle: 'foreign' },
    ]);
    await db().insert(disks).values([
      { id: 'dk-b', gameId: 'gt2', orgId: 'org-t', diskNo: 1, sha256: sha(1), sizeBytes: 100 },
      { id: 'dk-a', gameId: 'gt1', orgId: 'org-t', diskNo: 1, sha256: sha(1), sizeBytes: 100 },
      { id: 'dk-x', gameId: 'gt3', orgId: 'org-tx', diskNo: 1, sha256: sha(2), sizeBytes: 100 },
    ]);
    const bySha = await up('org-t', d, { status: 'stored', blobSha256: sha(1), expiresAt: later() });
    const foreign = await up('org-t', d, { status: 'stored', blobSha256: sha(2), expiresAt: later() });
    const linked = await up('org-t', d, { status: 'stored', blobSha256: sha(1), libraryDiskId: 'dk-b', expiresAt: later() });
    const rows = await S.listStaging(db(), 'org-t');
    const of = (id: string) => rows.find((r) => r.id === id)!;
    expect(of(bySha).title).toEqual({ gameId: 'gt1', title: 'Alpha Game' });
    expect(of(bySha)).toMatchObject({ status: 'stored', isDiskImage: true });
    expect(of(foreign).title).toBeNull();
    expect(of(linked).title).toEqual({ gameId: 'gt2', title: 'Beta Game' });
  });

  it('names the board as it was when the upload opened, even after a rename', async () => {
    const d = await device('org-r', 'Old name');
    const u = await up('org-r', d, { deviceName: 'Old name' });
    await db().update(devices).set({ name: 'New name' }).where(eq(devices.id, d));
    const row = (await S.listStaging(db(), 'org-r')).find((r) => r.id === u)!;
    expect(row.board).toEqual({ id: d, name: 'Old name' });
  });

  it('clears only finished rows of the org, by key', async () => {
    const d = await device('org-c', 'Bench'); const dx = await device('org-cx', 'Other');
    const sDone = await send('org-c', d, { status: 'delivered' });
    const sQueued = await send('org-c', d);
    const sLapsed = await send('org-c', d, { status: 'sending', expiresAt: earlier() });
    const sForeign = await send('org-cx', dx, { status: 'delivered' });
    const uFailed = await up('org-c', d, { status: 'failed', errorCode: 'crc' });
    const uLapsed = await up('org-c', d, { expiresAt: earlier() });
    const uRecv = await up('org-c', d);
    const uStored = await up('org-c', d, { status: 'stored', blobSha256: sha(5) });
    for (const id of [uFailed, uLapsed, uRecv]) await chunk(id);
    const keys = [`send:${sDone}`, `send:${sQueued}`, `send:${sLapsed}`, `send:${sForeign}`, `amiga:${uFailed}`, `amiga:${uLapsed}`, `amiga:${uRecv}`, `amiga:${uStored}`,
      'bogus', 'send:', 'x:send:1', 'amiga:no-such'];
    expect(await S.clearStaging(db(), 'org-c', keys)).toBe(4);
    expect(await transferExists(sDone)).toBe(false);
    expect(await transferExists(sLapsed)).toBe(false);
    expect(await transferExists(sQueued)).toBe(true);
    expect(await transferExists(sForeign)).toBe(true);
    expect(await upStatus(uFailed)).toBe('deleted'); expect(await upStatus(uLapsed)).toBe('deleted');
    expect(await upStatus(uRecv)).toBe('receiving'); expect(await upStatus(uStored)).toBe('stored');
    expect(await chunkCount(uFailed)).toBe(0); expect(await chunkCount(uLapsed)).toBe(0); expect(await chunkCount(uRecv)).toBe(1);
    expect(await S.clearStaging(db(), 'org-c', [])).toBe(0);
  });
});
