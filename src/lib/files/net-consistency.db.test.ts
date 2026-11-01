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
const { asc, eq, sql } = await import('drizzle-orm');
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

const BIG = 20_000;
const big = () => new Uint8Array(BIG).map((_, k) => k & 0xff);
/** The board took the get and sent its first chunk only (a file over one chunk): the upload id. */
async function partly(rid: string) {
  await takeWaiting(getDb(), 'w1');
  await answerPiece(getDb(), 'w1', rid, { piece: 0, lines: [`GOT ${rid} 7`], last: true });
  const up = await openUpload(getDb(), { deviceId: 'w1', orgId: 'o1' }, { size: BIG, date: '1.2.3', protection: 0, path: 'Work:big', comment: '', request: rid });
  if (!up.ok) throw new Error(up.code);
  expect((await storeChunk(getDb(), 'w1', up.id, 0, big().subarray(0, 16_384))).ok).toBe(true);
  return up.id;
}
const timedOut = (rid: string) => getDb().update(remoteRequests).set({ status: 'failed', errorCode: 'timeout', errorText: 'stopped answering' }).where(eq(remoteRequests.id, rid));
async function reopen(rid: string) {
  await takeWaiting(getDb(), 'w1');
  await answerPiece(getDb(), 'w1', rid, { piece: 0, lines: [`GOT ${rid} 8`], last: true });
  return openUpload(getDb(), { deviceId: 'w1', orgId: 'o1' }, { size: BIG, date: '1.2.3', protection: 0, path: 'Work:big', comment: '', request: rid });
}

describe('item 2: resume keyed by the get (m2)', () => {
  beforeEach(async () => { await remember('Work:', [ent('x', 2), ent('big', BIG)]); });

  it('a re-run copy between volumes never resumes staging an earlier timed-out get left', async () => {
    await op({ op: 'copy', sources: [W('big')], dest: 'NET:/w2/DF0', onClash: 'ask' });
    const [g1] = await gets();
    const first = await partly(g1.id);
    await timedOut(g1.id);
    await op({ op: 'copy', sources: [W('big')], dest: 'NET:/w2/DF0', onClash: 'ask' });
    const g2 = (await gets()).find((g) => g.id !== g1.id)!;
    const up = await reopen(g2.id);
    expect(up.ok && up.id !== first && up.offset === 0).toBe(true);
    expect((await getById(g1.id)).uploadId).toBe(first);
  });

  it('a re-run copy into STASH: resumes its row there, and the earlier get no longer names it', async () => {
    await op({ op: 'copy', sources: [W('big')], dest: 'STASH:', onClash: 'ask' });
    const [g1] = await gets();
    const first = await partly(g1.id);
    await timedOut(g1.id);
    // The half-arrived row holds the name in STASH: already: the re-run says Replace.
    await op({ op: 'copy', sources: [W('big')], dest: 'STASH:', onClash: 'replace' });
    const g2 = (await gets()).find((g) => g.id !== g1.id)!;
    const up = await reopen(g2.id);
    expect(up.ok && up.id === first && up.offset === 16_384).toBe(true);
    expect((await getById(g1.id)).uploadId).toBeNull();
    expect((await storeChunk(getDb(), 'w1', first, 16_384, big().subarray(16_384))).ok).toBe(true);
    expect((await closeUpload(getDb(), 'w1', first, crc32(big()) >>> 0)).ok).toBe(true);
    await placeFetched(getDb(), first);
    expect(await getById(g2.id)).toMatchObject({ status: 'done' });
    expect(await getById(g1.id)).toMatchObject({ status: 'failed' });
  });
});

describe('item 3: staging released when its get ends by an error (m3)', () => {
  beforeEach(async () => { await remember('Work:', [ent('x', 2), ent('big', BIG)]); });

  it('the board says the get failed mid-file: the staging row and its chunks go at once', async () => {
    await op({ op: 'copy', sources: [W('big')], dest: 'NET:/w2/DF0', onClash: 'ask' });
    const [g] = await gets();
    const id = await partly(g.id);
    expect(await answerPiece(getDb(), 'w1', g.id, { piece: 1, lines: [`ERR ${g.id} io 10:read error`], last: true })).toEqual({ ok: true });
    expect((await uploads()).find((u) => u.id === id)).toMatchObject({ status: 'deleted' });
    expect(await getDb().select().from(amigaUploadChunks).where(eq(amigaUploadChunks.uploadId, id))).toEqual([]);
  });

  it('a copy into STASH: whose get failed keeps its row for the person (not staging)', async () => {
    await op({ op: 'copy', sources: [W('big')], dest: 'STASH:', onClash: 'ask' });
    const [g] = await gets();
    const id = await partly(g.id);
    await answerPiece(getDb(), 'w1', g.id, { piece: 1, lines: [`ERR ${g.id} io 10:read error`], last: true });
    expect((await uploads()).find((u) => u.id === id)).toMatchObject({ status: 'receiving' });
  });
});

describe('item 4: a settle failure leaves the get as it ended', () => {
  it('settleMoveOfGet throws after a move\'s file is stored: the get is done, and the job settles the move later', async () => {
    const r = await op({ op: 'move', sources: [W('x')], dest: 'STASH:', onClash: 'ask' });
    const job = (r as { fetching: { id: string } }).fetching.id;
    const [g] = await gets();
    boom.settleMoveOfGet = true;
    await arrive(g.id, 'Work:x', bytes('xx'));
    expect(await getById(g.id)).toMatchObject({ status: 'done' });
    expect((await getById(g.id)).target).toMatchObject({ moveSource: W('x') });
    // The job's progress settles what the throw left: it asks the fresh listing, then removes the copied file.
    await fetchProgress(getDb(), 'o1', job, new Date());
    await answerFresh();
    expect(await deletesOn('w1')).toEqual(['Work:x one']);
  });

  it('the progress still answers when settling the job\'s moves throws', async () => {
    const r = await op({ op: 'move', sources: [W('x')], dest: 'STASH:', onClash: 'ask' });
    const job = (r as { fetching: { id: string } }).fetching.id;
    boom.settleMovesOfJob = true;
    expect(await fetchProgress(getDb(), 'o1', job, new Date())).toMatchObject({ total: 1, waiting: 1 });
  });
});

describe('item 5: settleMove decides under its locks, then removes (pool 5)', () => {
  const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error(`still waiting after ${ms} ms`)), ms))]);

  it('a move whose parts are over a day old: the removal is queued, nothing waits on the settle\'s own locks', { timeout: 30_000 }, async () => {
    await op({ op: 'move', sources: [W('x')], dest: 'STASH:', onClash: 'ask' });
    const [g] = await gets();
    await arrive(g.id, 'Work:x', bytes('xx'));
    // addWrites' 24 h cleanup deletes requests older than a day: the move's own get is one of them now.
    await getDb().update(remoteRequests).set({ createdAt: new Date(Date.now() - 25 * 3600_000) }).where(eq(remoteRequests.id, g.id));
    await within(answerFresh(), 8_000);
    expect(await deletesOn('w1')).toEqual(['Work:x one']);
  });

  it('two settles of one move at once queue its removal once', async () => {
    const { settleMove } = await import('./net-moves');
    const r = await op({ op: 'move', sources: [W('Pair')], dest: 'NET:/w2/DF0', onClash: 'ask' });
    const job = (r as { job: { id: string } }).job.id;
    for (const g of await gets()) await arrive(g.id, g.amigaPath, bytes('z'));
    for (const q of await rows('w2')) await deliver(q.id, 'w2');
    await answerFresh();
    await getDb().delete(remoteRequests).where(eq(remoteRequests.kind, 'delete'));
    // Put the markers back as they were before the settle: two callers race for one move.
    await getDb().update(remoteRequests).set({ target: sql`jsonb_set(${remoteRequests.target}, '{relay,moveSource}', ${JSON.stringify(W('Pair'))}::jsonb)` })
      .where(eq(remoteRequests.kind, 'get'));
    await getDb().update(transfers).set({ moveSource: W('Pair') }).where(eq(transfers.deviceId, 'w2'));
    await Promise.all([settleMove(getDb(), 'o1', job, W('Pair')), settleMove(getDb(), 'o1', job, W('Pair')), settleMove(getDb(), 'o1', job, W('Pair'))]);
    expect(await deletesOn('w1')).toEqual(['Work:Pair one', 'Work:Pair/a one', 'Work:Pair/b one']);
  });
});
