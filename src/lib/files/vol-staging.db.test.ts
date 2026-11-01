// src/lib/files/vol-staging.db.test.ts
// Volume-to-volume copies without STASH: (plan 2026-11-01-vol-to-vol-staging): a Copy or Move between two NET: volumes
// -- one board or two -- holds each fetched file as internal staging (an amiga_uploads row of source `staging`) that
// STASH:'s listing and quota never see, released once handed to the destination queue or once its get ends any other
// way, and swept by the daily cron when stale. The blob stays referenced (blob GC's sources) while anything needs it.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { Client } from 'pg';
import { crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_vol_staging_test';
const url = new URL(base); url.pathname = `/${DB}`; process.env.DATABASE_URL = url.toString();
process.env.STORAGE_DIR ??= (await import('node:fs')).mkdtempSync('/tmp/webadf-vol-staging-');
process.env.BLOB_READ_WRITE_TOKEN = '';
async function admin(stmt: string) { const c = new Client({ connectionString: base }); await c.connect(); try { await c.query(stmt); } finally { await c.end(); } }

vi.mock('next/server', () => ({ after: () => {} }));
vi.mock('@/lib/tosec-sweep', () => ({ sweep: async () => {} }));

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { asc, eq } = await import('drizzle-orm');
const { organization } = await import('@/db/schema/auth');
const { devices } = await import('@/db/schema/devices');
const { transfers } = await import('@/db/schema/transfers');
const { amigaUploads, amigaUploadChunks } = await import('@/db/schema/amiga-uploads');
const { remoteRequests } = await import('@/db/schema/remote-requests');
const { insertStash, listStash } = await import('@/lib/stash');
const { takeWaiting, answerPiece } = await import('@/lib/remote-requests');
const { openUpload, storeChunk, closeUpload, expireUploads, blobRefsElsewhere, getUpload } = await import('@/lib/amiga-uploads');
const { finishTransfer, cancelTransfer } = await import('@/lib/transfers');
const { UPLOAD_AREA_MAX_BYTES } = await import('@/lib/amiga-upload-limits');
const { diskStore } = await import('@/lib/storage');
const { runOp } = await import('./ops');
const { fetchProgress, placeFetched, afterTransferDone } = await import('./net-fetch');
const { afterRequestAnswered } = await import('./net-moves');

const ctx = { orgId: 'o1', userId: 'u1' };
const DATE = '2020-01-02T00:00:00.000Z';
const ent = (name: string, size: number, dir = false) => ({ name, dir, size, protection: 0, date: DATE, comment: '' });
const W = (p: string) => `NET:/w1/Work/${p}`;
const op = (o: Parameters<typeof runOp>[1]) => runOp(ctx, o);
const gets = async () => (await getDb().select().from(remoteRequests).where(eq(remoteRequests.kind, 'get'))).sort((a, b) => a.amigaPath.localeCompare(b.amigaPath));
const rows = async (deviceId: string) => getDb().select().from(transfers).where(eq(transfers.deviceId, deviceId)).orderBy(asc(transfers.createdAt));
const uploads = async () => getDb().select().from(amigaUploads).orderBy(asc(amigaUploads.createdAt));
const stashNames = async () => (await listStash(getDb(), 'o1')).map((r) => r.path).sort();
const shaOf = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const bytes = (s: string) => new TextEncoder().encode(s);

let n = 0;
const amigaNow = new Map<string, ReturnType<typeof ent>[]>();
async function remember(amigaPath: string, entries: ReturnType<typeof ent>[], deviceId = 'w1') {
  amigaNow.set(`${deviceId} ${amigaPath.toLowerCase()}`, entries);
  const now = new Date();
  await getDb().insert(remoteRequests).values({ id: `dir-${deviceId}-${++n}`, orgId: 'o1', deviceId, kind: 'dir', amigaPath,
    status: 'done', answer: { volumes: [], entries }, createdAt: now, sentAt: now, answeredAt: now });
}
async function stash(path: string, body: string, sizeBytes?: number) {
  const b = bytes(body);
  const sha = shaOf(b);
  await diskStore.put(sha, b, { overwrite: true });
  const r = await insertStash(getDb(), 'o1', 'browser', [{ path, kind: 'file', sha256: sha, sizeBytes: sizeBytes ?? b.length, date: null, protection: 0, comment: '' }]);
  if (!r.ok) throw new Error(r.code);
}

/**
 * The board's side of one get, step by step, with `check` called at every step (STASH: must stay as it was): GOT, the
 * open tied to the get, each chunk, the close, the placement. `crc` overrides the CRC sent (a damaged copy).
 */
async function arrive(rid: string, amigaPath: string, data: Uint8Array, check: (step: string) => Promise<void>, o: { deviceId?: string; crc?: number } = {}) {
  const deviceId = o.deviceId ?? 'w1';
  await takeWaiting(getDb(), deviceId);
  expect(await answerPiece(getDb(), deviceId, rid, { piece: 0, lines: [`GOT ${rid} 7`], last: true })).toEqual({ ok: true });
  const up = await openUpload(getDb(), { deviceId, orgId: 'o1' }, { size: data.length, date: '1.2.3', protection: 0, path: amigaPath, comment: '', request: rid });
  if (!up.ok) throw new Error(`open refused: ${up.code}`);
  await check('opened');
  for (let at = 0; at < data.length; at += 16_384) {
    expect((await storeChunk(getDb(), deviceId, up.id, at, data.subarray(at, at + 16_384))).ok).toBe(true);
    await check('chunk');
  }
  const closed = await closeUpload(getDb(), deviceId, up.id, o.crc ?? (crc32(data) >>> 0));
  await check('closed');
  if (closed.ok) await placeFetched(getDb(), up.id);
  await check('placed');
  return up.id;
}
async function deliver(id: string, outcome: Parameters<typeof finishTransfer>[3], deviceId: string) {
  expect(await finishTransfer(getDb(), deviceId, id, outcome)).toBe(true);
  await afterTransferDone(getDb(), id);
}
/** The fresh listings a move off a volume asks before it removes anything, answered as the Amiga holds them now. */
async function answerFresh(deviceId = 'w1') {
  const day = (iso: string) => `${Math.round((Date.parse(iso) - Date.UTC(1978, 0, 1)) / 86_400_000)}.0.0`;
  for (const r of (await takeWaiting(getDb(), deviceId)).filter((x) => x.kind === 'dir')) {
    const es = amigaNow.get(`${deviceId} ${r.amigaPath.toLowerCase()}`) ?? [];
    const lines = [...es.map((e) => `ENT ${r.id} ${e.dir ? 'd' : 'f'} ${e.size} 0 ${day(e.date)} ${e.name.length}:${e.name} 0:`), `DONE ${r.id} ${es.length}`];
    expect(await answerPiece(getDb(), deviceId, r.id, { piece: 0, lines, last: true })).toEqual({ ok: true });
    await afterRequestAnswered(getDb(), deviceId, r.id);
  }
}
const deletesOn = async (deviceId: string) => (await getDb().select().from(remoteRequests).where(eq(remoteRequests.deviceId, deviceId)))
  .filter((r) => r.kind === 'delete').map((r) => `${r.amigaPath}${(r.target as { one?: boolean }).one ? ' one' : ''}`).sort();

/** STASH: shows exactly `names` (the person's own files), whatever step the copy is at. */
const stays = (names: string[]) => async (step: string) => { expect(await stashNames(), step).toEqual(names); };

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
  await db.delete(amigaUploads);
  await db.delete(devices);
  const now = new Date();
  const can = { firmwareVersion: '1.23.1+gabc', lastSeenAt: now, sendRx: 'c', sendRxAt: now, rxProto: 5, browseOn: true, writeOn: true };
  await db.insert(devices).values([
    { id: 'w1', orgId: 'o1', name: 'A500', tokenHash: 'h1', ...can },
    { id: 'w2', orgId: 'o1', name: 'A1200', tokenHash: 'h2', ...can },
  ]);
  await remember('Work:', [ent('x', 2), ent('Pair', 0, true)]);
  await remember('Work:Pair', [ent('a', 1), ent('b', 1)]);
  await remember('DF0:', []);
  await remember('DF0:', [], 'w2');
  await stash('mine.txt', 'mine');
});
afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

describe('a copy between volumes is never in STASH:', () => {
  it('same board: no STASH: row at any step; handed over, the staging is released and the queue row keeps the blob', async () => {
    const r = await op({ op: 'copy', sources: [W('x')], dest: 'NET:/w1/DF0', onClash: 'ask' });
    const job = (r as { job: { id: string } }).job.id;
    const [g] = await gets();
    const data = bytes('xx');
    let sha = '';
    const id = await arrive(g.id, 'Work:x', data, async (step) => {
      await stays(['mine.txt'])(step);
      if (step === 'closed') {
        sha = shaOf(data);
        expect(await blobRefsElsewhere(getDb(), [sha]), 'GC keeps it while staged').toEqual([sha]);
      }
    });
    const [u] = (await uploads()).filter((x) => x.id === id);
    expect(u).toMatchObject({ source: 'staging', status: 'deleted' });
    expect(await getUpload(getDb(), 'o1', id)).toBeNull();
    const [row] = await rows('w1');
    expect(row).toMatchObject({ amigaDest: 'DF0:x', jobId: job, blobSha256: sha });
    expect(await blobRefsElsewhere(getDb(), [sha]), 'GC keeps it while queued').toEqual([sha]);
    await deliver(row.id, { ok: true, savedAs: 'DF0:x' }, 'w1');
    expect(await blobRefsElsewhere(getDb(), [sha]), 'and while the finished row is kept').toEqual([sha]);
    expect(await stashNames()).toEqual(['mine.txt']);
    expect(await fetchProgress(getDb(), 'o1', job, new Date())).toMatchObject({ total: 1, done: 1, waiting: 0, arrived: [] });
  });

  it('two boards: the same, the file fetched on one and queued on the other', async () => {
    const r = await op({ op: 'copy', sources: [W('Pair')], dest: 'NET:/w2/DF0', onClash: 'ask' });
    const job = (r as { job: { id: string } }).job.id;
    for (const g of await gets()) await arrive(g.id, g.amigaPath, bytes('z'), stays(['mine.txt']));
    expect((await uploads()).filter((u) => u.source === 'staging').map((u) => u.status)).toEqual(['deleted', 'deleted']);
    const queued = await rows('w2');
    expect(queued.map((q) => q.amigaDest)).toEqual(['DF0:Pair/a', 'DF0:Pair/b']);
    for (const q of queued) await deliver(q.id, { ok: true, savedAs: q.amigaDest! }, 'w2');
    expect(await stashNames()).toEqual(['mine.txt']);
    expect(await fetchProgress(getDb(), 'o1', job, new Date())).toMatchObject({ total: 2, done: 2, waiting: 0 });
  });

  it('a cancelled queue row: nothing in STASH:, the blob named by the row until the cron clears it', async () => {
    await op({ op: 'copy', sources: [W('x')], dest: 'NET:/w2/DF0', onClash: 'ask' });
    const [g] = await gets();
    await arrive(g.id, 'Work:x', bytes('xx'), stays(['mine.txt']));
    const [row] = await rows('w2');
    expect(await cancelTransfer(getDb(), 'o1', row.id)).toBe(true);
    expect(await stashNames()).toEqual(['mine.txt']);
    expect((await uploads()).filter((u) => u.source === 'staging').map((u) => u.status)).toEqual(['deleted']);
    expect(await blobRefsElsewhere(getDb(), [row.blobSha256])).toEqual([row.blobSha256]);
  });

  it('STASH: at its quota does not stop it, and staging does not count against STASH:', async () => {
    await stash('big.bin', 'b', UPLOAD_AREA_MAX_BYTES - 'mine'.length);   // STASH: now exactly full
    await op({ op: 'copy', sources: [W('x')], dest: 'NET:/w2/DF0', onClash: 'ask' });
    const [g] = await gets();
    await takeWaiting(getDb(), 'w1');
    await answerPiece(getDb(), 'w1', g.id, { piece: 0, lines: [`GOT ${g.id} 2`], last: true });
    const up = await openUpload(getDb(), { deviceId: 'w1', orgId: 'o1' }, { size: 2, date: '1.2.3', protection: 0, path: 'Work:x', comment: '', request: g.id });
    expect(up.ok).toBe(true);
    // Staging takes none of STASH:'s room: with mine.txt gone, a 4-byte file of the person's fits again.
    await getDb().update(amigaUploads).set({ status: 'deleted' }).where(eq(amigaUploads.path, 'mine.txt'));
    await stash('four.txt', 'four');
    expect(await stashNames()).toEqual(['big.bin', 'four.txt']);
  });

  it('a damaged copy (CRC) is no STASH: stub', async () => {
    await op({ op: 'copy', sources: [W('x')], dest: 'NET:/w2/DF0', onClash: 'ask' });
    const [g] = await gets();
    await arrive(g.id, 'Work:x', bytes('xx'), stays(['mine.txt']), { crc: 1 });
    expect((await gets())[0]).toMatchObject({ status: 'failed', errorCode: 'crc' });
    expect(await rows('w2')).toEqual([]);
  });

  it('a Receive upload of the same name, size and date never resumes into a staging row', async () => {
    await op({ op: 'copy', sources: [W('x')], dest: 'NET:/w2/DF0', onClash: 'ask' });
    const [g] = await gets();
    await takeWaiting(getDb(), 'w1');
    await answerPiece(getDb(), 'w1', g.id, { piece: 0, lines: [`GOT ${g.id} 2`], last: true });
    const staged = await openUpload(getDb(), { deviceId: 'w1', orgId: 'o1' }, { size: 2, date: '1.2.3', protection: 0, path: 'x', comment: '', request: g.id });
    const mine = await openUpload(getDb(), { deviceId: 'w1', orgId: 'o1' }, { size: 2, date: '1.2.3', protection: 0, path: 'x', comment: '' });
    expect(staged.ok && mine.ok && staged.id !== mine.id).toBe(true);
    expect(await stashNames()).toEqual(['mine.txt', 'x']);
  });
});

describe('staging is released however the get ends', () => {
  it('the destination queue refuses it (full): the get fails with the words, nothing stays anywhere', async () => {
    await op({ op: 'copy', sources: [W('x')], dest: 'NET:/w2/DF0', onClash: 'ask' });
    const later = new Date(Date.now() + 3600_000);
    await getDb().insert(transfers).values(Array.from({ length: 32 }, (_, k) => ({ id: `full-${k}`, orgId: 'o1', deviceId: 'w2', createdByUserId: 'u1',
      path: `f${k}`, sizeBytes: 1, crc32: 0, blobSha256: 'f'.repeat(64), expiresAt: later })));
    const [g] = await gets();
    const id = await arrive(g.id, 'Work:x', bytes('xx'), stays(['mine.txt']));
    expect((await gets())[0]).toMatchObject({ status: 'failed', errorCode: 'queue_full' });
    expect((await uploads()).find((u) => u.id === id)).toMatchObject({ source: 'staging', status: 'deleted' });
    expect(await blobRefsElsewhere(getDb(), [shaOf(bytes('xx'))])).toEqual([]);
  });

  it('the get failed while its file was still going up: the late close releases it', async () => {
    await op({ op: 'copy', sources: [W('x')], dest: 'NET:/w2/DF0', onClash: 'ask' });
    const [g] = await gets();
    const data = bytes('xx');
    await takeWaiting(getDb(), 'w1');
    await answerPiece(getDb(), 'w1', g.id, { piece: 0, lines: [`GOT ${g.id} 2`], last: true });
    const up = await openUpload(getDb(), { deviceId: 'w1', orgId: 'o1' }, { size: 2, date: '1.2.3', protection: 0, path: 'Work:x', comment: '', request: g.id });
    if (!up.ok) throw new Error(up.code);
    await storeChunk(getDb(), 'w1', up.id, 0, data);
    await getDb().update(remoteRequests).set({ status: 'failed', errorCode: 'io', errorText: 'read error' }).where(eq(remoteRequests.id, g.id));
    expect((await closeUpload(getDb(), 'w1', up.id, crc32(data) >>> 0)).ok).toBe(true);
    await placeFetched(getDb(), up.id);
    expect((await uploads()).find((u) => u.id === up.id)).toMatchObject({ status: 'deleted' });
    expect(await rows('w2')).toEqual([]);
    expect(await stashNames()).toEqual(['mine.txt']);
  });

  it('the daily sweep deletes staging older than 24 h (receiving or stored) with its chunks; fresh staging and STASH: stay', async () => {
    const day = 24 * 3600_000;
    const old = new Date(Date.now() - day - 3600_000);
    const later = new Date(Date.now() + day);
    await getDb().insert(amigaUploads).values([
      { id: 's-recv', orgId: 'o1', deviceId: 'w1', path: 'a', sizeBytes: 20_000, amigaDate: '1.2.3', source: 'staging', status: 'receiving', receivedBytes: 16_384, createdAt: old, expiresAt: later },
      { id: 's-stored', orgId: 'o1', deviceId: 'w1', path: 'b', sizeBytes: 1, amigaDate: '1.2.3', source: 'staging', status: 'stored', blobSha256: 'a'.repeat(64), createdAt: old, expiresAt: later },
      { id: 's-fresh', orgId: 'o1', deviceId: 'w1', path: 'c', sizeBytes: 1, amigaDate: '1.2.3', source: 'staging', status: 'receiving', createdAt: new Date(), expiresAt: later },
      { id: 'u-old', orgId: 'o1', deviceId: 'w1', path: 'kept.txt', sizeBytes: 1, amigaDate: '1.2.3', source: 'amiga', status: 'stored', blobSha256: 'b'.repeat(64), createdAt: old, expiresAt: later },
    ]);
    await getDb().insert(amigaUploadChunks).values({ uploadId: 's-recv', offset: 0, data: new Uint8Array(16_384) });
    await expireUploads(getDb());
    const left = (await uploads()).map((u) => u.id).sort();
    expect(left).toContain('s-fresh');
    expect(left).toContain('u-old');
    expect(left).not.toContain('s-recv');
    expect(left).not.toContain('s-stored');
    expect(await getDb().select().from(amigaUploadChunks).where(eq(amigaUploadChunks.uploadId, 's-recv'))).toEqual([]);
    expect(await blobRefsElsewhere(getDb(), ['a'.repeat(64)])).toEqual([]);
  });
});

describe('moves between volumes keep §9 and touch no STASH:', () => {
  it('two boards: the copied files, then the drawer, removed once delivered; STASH: untouched throughout', async () => {
    const r = await op({ op: 'move', sources: [W('Pair')], dest: 'NET:/w2/DF0', onClash: 'ask' });
    const job = (r as { job: { id: string } }).job.id;
    for (const g of await gets()) await arrive(g.id, g.amigaPath, bytes('z'), stays(['mine.txt']));
    for (const q of await rows('w2')) await deliver(q.id, { ok: true, savedAs: q.amigaDest! }, 'w2');
    await answerFresh();
    expect(await deletesOn('w1')).toEqual(['Work:Pair one', 'Work:Pair/a one', 'Work:Pair/b one']);
    expect(await stashNames()).toEqual(['mine.txt']);
    expect(await fetchProgress(getDb(), 'o1', job, new Date())).toMatchObject({ total: 2, done: 2, waiting: 0 });
  });

  it('same board, another volume: the file removed once delivered', async () => {
    await op({ op: 'move', sources: [W('x')], dest: 'NET:/w1/DF0', onClash: 'ask' });
    const [g] = await gets();
    await arrive(g.id, 'Work:x', bytes('xx'), stays(['mine.txt']));
    const [row] = await rows('w1');
    await deliver(row.id, { ok: true, savedAs: 'DF0:x' }, 'w1');
    await answerFresh();
    expect(await deletesOn('w1')).toEqual(['Work:x one']);
    expect(await stashNames()).toEqual(['mine.txt']);
  });
});
