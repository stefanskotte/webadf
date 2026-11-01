// src/lib/files/net-consistency.db.test.ts
// NET: volumes server-side consistency (plan 2026-11-01-net-consistency): a repeated close placing a file once, staging
// keyed by its get, staging released however a get ends, a settle failure leaving the get alone, a settle that never
// waits on itself, one Amiga fold for remembered listings, and the rest of the plan's items. The database is made with
// LC_COLLATE/LC_CTYPE 'C', where Postgres's own lower() folds ASCII only (production's collation question).
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { Client } from 'pg';
import { crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_net_consistency_test';
const url = new URL(base); url.pathname = `/${DB}`; process.env.DATABASE_URL = url.toString();
process.env.STORAGE_DIR ??= (await import('node:fs')).mkdtempSync('/tmp/webadf-net-consistency-');
process.env.BLOB_READ_WRITE_TOKEN = '';
async function admin(stmt: string) { const c = new Client({ connectionString: base }); await c.connect(); try { await c.query(stmt); } finally { await c.end(); } }

vi.mock('next/server', () => ({ after: () => {} }));
vi.mock('@/lib/tosec-sweep', () => ({ sweep: async () => {} }));
/** Switches the tests flip: the next call of each throws once. */
const boom = { releaseStaging: false, settleMoveOfGet: false, settleMovesOfJob: false };
vi.mock('@/lib/amiga-uploads', async (orig) => {
  const m = await orig<typeof import('@/lib/amiga-uploads')>();
  return { ...m, releaseStaging: async (...a: Parameters<typeof m.releaseStaging>) => {
    if (boom.releaseStaging) { boom.releaseStaging = false; throw new Error('boom: releaseStaging'); }
    return m.releaseStaging(...a);
  } };
});
vi.mock('./net-moves', async (orig) => {
  const m = await orig<typeof import('./net-moves')>();
  return { ...m,
    settleMoveOfGet: async (...a: Parameters<typeof m.settleMoveOfGet>) => {
      if (boom.settleMoveOfGet) { boom.settleMoveOfGet = false; throw new Error('boom: settleMoveOfGet'); }
      return m.settleMoveOfGet(...a);
    },
    settleMovesOfJob: async (...a: Parameters<typeof m.settleMovesOfJob>) => {
      if (boom.settleMovesOfJob) { boom.settleMovesOfJob = false; throw new Error('boom: settleMovesOfJob'); }
      return m.settleMovesOfJob(...a);
    } };
});

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
const { openUpload, storeChunk, closeUpload } = await import('@/lib/amiga-uploads');
const { finishTransfer } = await import('@/lib/transfers');
const { diskStore } = await import('@/lib/storage');
const { runOp } = await import('./ops');
const { fetchProgress, placeFetched, afterTransferDone } = await import('./net-fetch');
const { afterRequestAnswered } = await import('./net-moves');

const ctx = { orgId: 'o1', userId: 'u1' };
const DATE = '2020-01-02T00:00:00.000Z';
const ent = (name: string, size: number, dir = false) => ({ name, dir, size, protection: 0, date: DATE, comment: '' });
const W = (p: string) => `NET:/w1/Work/${p}`;
const op = (o: Parameters<typeof runOp>[1]) => runOp(ctx, o);
const gets = async () => (await getDb().select().from(remoteRequests).where(eq(remoteRequests.kind, 'get'))).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.amigaPath.localeCompare(b.amigaPath));
const getById = async (id: string) => (await getDb().select().from(remoteRequests).where(eq(remoteRequests.id, id)))[0];
const rows = async (deviceId: string) => getDb().select().from(transfers).where(eq(transfers.deviceId, deviceId)).orderBy(asc(transfers.createdAt));
const uploads = async () => getDb().select().from(amigaUploads).orderBy(asc(amigaUploads.createdAt));
const bytes = (s: string) => new TextEncoder().encode(s);
const shaOf = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

let n = 0;
const amigaNow = new Map<string, ReturnType<typeof ent>[]>();
async function remember(amigaPath: string, entries: ReturnType<typeof ent>[], deviceId = 'w1', at = new Date()) {
  amigaNow.set(`${deviceId} ${amigaPath.toLowerCase()}`, entries);
  await getDb().insert(remoteRequests).values({ id: `dir-${deviceId}-${++n}`, orgId: 'o1', deviceId, kind: 'dir', amigaPath,
    status: 'done', answer: { volumes: [], entries }, createdAt: at, sentAt: at, answeredAt: at });
}
async function stash(path: string, body: string) {
  const b = bytes(body);
  const sha = shaOf(b);
  await diskStore.put(sha, b, { overwrite: true });
  const r = await insertStash(getDb(), 'o1', 'browser', [{ path, kind: 'file', sha256: sha, sizeBytes: b.length, date: null, protection: 0, comment: '' }]);
  if (!r.ok) throw new Error(r.code);
}
/** The board takes the get, says GOT, opens its upload and stores every chunk: the upload id, not closed yet. */
async function upTo(rid: string, amigaPath: string, data: Uint8Array, deviceId = 'w1') {
  await takeWaiting(getDb(), deviceId);
  expect(await answerPiece(getDb(), deviceId, rid, { piece: 0, lines: [`GOT ${rid} 7`], last: true })).toEqual({ ok: true });
  const up = await openUpload(getDb(), { deviceId, orgId: 'o1' }, { size: data.length, date: '1.2.3', protection: 0, path: amigaPath, comment: '', request: rid });
  if (!up.ok) throw new Error(`open refused: ${up.code}`);
  for (let at = 0; at < data.length; at += 16_384) expect((await storeChunk(getDb(), deviceId, up.id, at, data.subarray(at, at + 16_384))).ok).toBe(true);
  return up.id;
}
async function arrive(rid: string, amigaPath: string, data: Uint8Array, deviceId = 'w1') {
  const id = await upTo(rid, amigaPath, data, deviceId);
  expect((await closeUpload(getDb(), deviceId, id, crc32(data) >>> 0)).ok).toBe(true);
  await placeFetched(getDb(), id);
  return id;
}
async function deliver(id: string, deviceId: string) {
  expect(await finishTransfer(getDb(), deviceId, id, { ok: true, savedAs: 'x' })).toBe(true);
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

beforeAll(async () => {
  await admin(`drop database if exists ${DB} with (force)`);
  await admin(`create database ${DB} template template0 lc_collate 'C' lc_ctype 'C'`);
  await migrate(getDb(), { migrationsFolder: 'drizzle' });
  await getDb().insert(organization).values([{ id: 'o1', name: 'o1', slug: 'o1', createdAt: new Date() }]);
});
beforeEach(async () => {
  Object.assign(boom, { releaseStaging: false, settleMoveOfGet: false, settleMovesOfJob: false });
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
});
afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

describe('item 1: a get is placed once (m1, m5)', () => {
  it('two placements of one upload at once (the board retried the close): one queue row, the get done', async () => {
    await op({ op: 'copy', sources: [W('x')], dest: 'NET:/w2/DF0', onClash: 'ask' });
    const [g] = await gets();
    const data = bytes('xx');
    const id = await upTo(g.id, 'Work:x', data);
    expect((await closeUpload(getDb(), 'w1', id, crc32(data) >>> 0)).ok).toBe(true);
    await Promise.all([placeFetched(getDb(), id), placeFetched(getDb(), id), placeFetched(getDb(), id)]);
    expect((await rows('w2')).length).toBe(1);
    expect(await getById(g.id)).toMatchObject({ status: 'done' });
  });

  it('two placements of a copy into STASH: at once: one STASH: file, the get done', async () => {
    await op({ op: 'copy', sources: [W('x')], dest: 'STASH:', onClash: 'ask' });
    const [g] = await gets();
    const data = bytes('xx');
    const id = await upTo(g.id, 'Work:x', data);
    expect((await closeUpload(getDb(), 'w1', id, crc32(data) >>> 0)).ok).toBe(true);
    await Promise.all([placeFetched(getDb(), id), placeFetched(getDb(), id)]);
    expect((await listStash(getDb(), 'o1')).map((r) => r.path)).toEqual(['x']);
    expect(await getById(g.id)).toMatchObject({ status: 'done' });
  });

  it('a throw after the queue took the file: the get is done, not failed', async () => {
    await op({ op: 'copy', sources: [W('x')], dest: 'NET:/w2/DF0', onClash: 'ask' });
    const [g] = await gets();
    const data = bytes('xx');
    const id = await upTo(g.id, 'Work:x', data);
    expect((await closeUpload(getDb(), 'w1', id, crc32(data) >>> 0)).ok).toBe(true);
    boom.releaseStaging = true;
    await placeFetched(getDb(), id);
    expect((await rows('w2')).length).toBe(1);
    expect(await getById(g.id)).toMatchObject({ status: 'done' });
  });

  it('a repeated close after the first placed it changes nothing', async () => {
    await op({ op: 'copy', sources: [W('x')], dest: 'NET:/w2/DF0', onClash: 'ask' });
    const [g] = await gets();
    const id = await arrive(g.id, 'Work:x', bytes('xx'));
    expect((await closeUpload(getDb(), 'w1', id, crc32(bytes('xx')) >>> 0)).ok).toBe(true);
    await placeFetched(getDb(), id);
    expect((await rows('w2')).length).toBe(1);
    expect(await getById(g.id)).toMatchObject({ status: 'done' });
  });
});
