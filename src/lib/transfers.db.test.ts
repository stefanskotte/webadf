import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { eq } from 'drizzle-orm';

// A database of its own (the shared one is the live one): the queue writes devices and transfers rows.
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_transfers_test';
const url = new URL(base);
url.pathname = `/${DB}`;
process.env.DATABASE_URL = url.toString();
const storageDir = mkdtempSync(join(tmpdir(), 'webadf-transfers-'));
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
const { diskStore } = await import('@/lib/storage');
const T = await import('./transfers');

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
async function blob(b: Uint8Array) { const s = sha(b); if (!(await diskStore.stat(s))) await diskStore.put(s, b); return s; }
let n = 0;
async function device(orgId = 'org-a') {
  const id = `dev-${++n}`;
  await getDb().insert(devices).values({ id, orgId, name: id, tokenHash: `hash-${id}` });
  return id;
}
const version = async (id: string) => (await getDb().select({ v: devices.sendVersion }).from(devices).where(eq(devices.id, id)))[0].v;
const row = async (id: string) => (await getDb().select().from(transfers).where(eq(transfers.id, id)))[0];
const q = (deviceId: string, sha256: string, extra: Partial<Parameters<typeof T.queueTransferFromBlob>[1]> = {}) =>
  T.queueTransferFromBlob(getDb(), { orgId: 'org-a', deviceId, userId: 'u1', path: 'File.bin', sha256, ...extra });

describe('transfers', () => {
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

  it('queues a blob with its size and CRC-32 and bumps the board cursor', async () => {
    const d = await device(); const b = new TextEncoder().encode('hello');
    const r = await q(d, await blob(b), { path: '../x/Café.txt' });
    expect(r.ok).toBe(true);
    const t = await row((r as { id: string }).id);
    expect(t).toMatchObject({ sizeBytes: 5, crc32: crc32(b) >>> 0, path: 'x/Café.txt', status: 'queued' });
    expect(await version(d)).toBe(1);
  });

  it('refuses another org, an unknown blob, an oversized blob and a bad name', async () => {
    const d = await device();
    expect(await T.queueTransferFromBlob(getDb(), { orgId: 'org-b', deviceId: d, userId: 'u', path: 'x', sha256: await blob(new Uint8Array([1])) }))
      .toEqual({ ok: false, reason: 'no_device' });
    expect(await q(d, 'f'.repeat(64))).toEqual({ ok: false, reason: 'no_blob' });
    expect(await q(d, await blob(new Uint8Array(T.SEND_FILE_MAX + 1)))).toEqual({ ok: false, reason: 'too_large' });
    expect(await q(d, await blob(new Uint8Array([2])), { path: '../..' })).toEqual({ ok: false, reason: 'bad_name' });
  });

  it('keeps a board to 32 files and 16 MB', async () => {
    const d = await device();
    for (let i = 0; i < 32; i++) expect((await q(d, await blob(new Uint8Array([10, i])))).ok).toBe(true);
    expect(await q(d, await blob(new Uint8Array([11])))).toEqual({ ok: false, reason: 'queue_full' });
    const d2 = await device();
    for (let i = 0; i < 4; i++) expect((await q(d2, await blob(new Uint8Array(T.SEND_FILE_MAX).fill(i + 1)))).ok).toBe(true);
    expect(await q(d2, await blob(new Uint8Array(T.SEND_FILE_MAX).fill(9)))).toEqual({ ok: false, reason: 'queue_full' });
  });

  it('puts the oldest queued or sending row first and leaves expired rows out', async () => {
    const d = await device(); const t0 = new Date('2026-10-16T10:00:00Z');
    const a = await q(d, await blob(new Uint8Array([20])), { path: 'A', now: t0 });
    const b = await q(d, await blob(new Uint8Array([21])), { path: 'B', now: new Date(t0.getTime() + 1000) });
    const ida = (a as { id: string }).id, idb = (b as { id: string }).id;
    let text = await T.sendQueueText(getDb(), d, new Date(t0.getTime() + 2000));
    expect(text.startsWith(`NEXT ${ida} `)).toBe(true);
    expect(text).toContain('LIST 2\n');
    await T.recordChunk(getDb(), d, ida, 0);
    text = await T.sendQueueText(getDb(), d, new Date(t0.getTime() + 2000));
    expect(text.startsWith(`NEXT ${ida} `)).toBe(true);
    text = await T.sendQueueText(getDb(), d, new Date(t0.getTime() + T.SEND_EXPIRE_MS + 1500));
    expect(text).toBe('NEXT -\nLIST 0\n');
    expect(idb).toBeTruthy();
  });

  it('records a chunk only for this board and an active row', async () => {
    const d = await device(), other = await device();
    const r = await q(d, await blob(new Uint8Array([30, 1, 2])));
    const id = (r as { id: string }).id;
    expect(await T.recordChunk(getDb(), other, id, 0)).toEqual({ ok: false, status: 404 });
    expect(await T.recordChunk(getDb(), d, id, 2)).toMatchObject({ ok: true, sizeBytes: 3 });
    expect((await row(id)).bytesSent).toBe(2);
    await T.cancelTransfer(getDb(), 'org-a', id);
    expect(await T.recordChunk(getDb(), d, id, 0)).toEqual({ ok: false, status: 409 });
  });

  it('finishes once, delivered or failed', async () => {
    const d = await device();
    const a = (await q(d, await blob(new Uint8Array([40]))) as { id: string }).id;
    const v0 = await version(d);
    expect(await T.finishTransfer(getDb(), d, a, { ok: true, savedAs: 'File_2.bin' })).toBe(true);
    expect(await row(a)).toMatchObject({ status: 'delivered', savedAs: 'File_2.bin' });
    expect(await version(d)).toBe(v0 + 1);
    expect(await T.finishTransfer(getDb(), d, a, { ok: false, code: 'crc', text: 'x' })).toBe(false);
    const b = (await q(d, await blob(new Uint8Array([41]))) as { id: string }).id;
    await T.finishTransfer(getDb(), d, b, { ok: false, code: 'space', text: 'n'.repeat(300) });
    expect(await row(b)).toMatchObject({ status: 'failed', errorCode: 'space' });
    expect((await row(b)).errorText!.length).toBe(120);
  });

  it('cancels only an active row', async () => {
    const d = await device();
    const a = (await q(d, await blob(new Uint8Array([50]))) as { id: string }).id;
    const v0 = await version(d);
    expect(await T.cancelTransfer(getDb(), 'org-a', a)).toBe(true);
    expect(await version(d)).toBe(v0 + 1);
    expect(await T.cancelTransfer(getDb(), 'org-a', a)).toBe(false);
  });

  it('expires waiting rows after 24 h and deletes finished rows after 7 days', async () => {
    const d = await device(); const t0 = new Date('2026-10-01T00:00:00Z');
    const a = (await q(d, await blob(new Uint8Array([60])), { now: t0 }) as { id: string }).id;
    const r1 = await T.expireTransfers(getDb(), new Date(t0.getTime() + 25 * 3600_000));
    expect(r1.expired).toBeGreaterThanOrEqual(1);
    expect((await row(a)).status).toBe('expired');
    const r2 = await T.expireTransfers(getDb(), new Date(t0.getTime() + 25 * 3600_000 + T.SEND_KEEP_FINISHED_MS + 1000));
    expect(r2.deleted).toBeGreaterThanOrEqual(1);
    expect(await row(a)).toBeUndefined();
  });

  it('expires a row stuck in sending (the board vanished mid-file), so it stops counting against the limits', async () => {
    const d = await device(); const t0 = new Date('2026-10-02T00:00:00Z');
    const a = (await q(d, await blob(new Uint8Array([70])), { now: t0 }) as { id: string }).id;
    await T.recordChunk(getDb(), d, a, 0);
    await T.expireTransfers(getDb(), new Date(t0.getTime() + 25 * 3600_000));
    expect((await row(a)).status).toBe('expired');
  });

  it('never turns a cancelled row back into sending, and refuses an offset past the end before marking', async () => {
    const d = await device();
    const a = (await q(d, await blob(new Uint8Array([71, 72, 73]))) as { id: string }).id;
    await T.cancelTransfer(getDb(), 'org-a', a);
    expect(await T.recordChunk(getDb(), d, a, 0)).toEqual({ ok: false, status: 409 });
    expect((await row(a)).status).toBe('cancelled');
    const b = (await q(d, await blob(new Uint8Array([74, 75]))) as { id: string }).id;
    expect(await T.recordChunk(getDb(), d, b, 2)).toEqual({ ok: false, status: 400 });
    expect((await row(b)).status).toBe('queued');
  });

  it('writes the receiver state only on a change or after 30 s', async () => {
    const d = await device(); const t0 = new Date('2026-10-16T12:00:00Z');
    const at = async () => (await getDb().select({ rx: devices.sendRx, at: devices.sendRxAt }).from(devices).where(eq(devices.id, d)))[0];
    await T.recordSendRx(getDb(), d, 'c', t0);
    await T.recordSendRx(getDb(), d, 'c', new Date(t0.getTime() + 10_000));
    expect((await at()).at!.getTime()).toBe(t0.getTime());
    await T.recordSendRx(getDb(), d, 'r', new Date(t0.getTime() + 11_000));
    expect(await at()).toMatchObject({ rx: 'r' });
  });
});
