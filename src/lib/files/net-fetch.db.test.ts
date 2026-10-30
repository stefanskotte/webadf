// src/lib/files/net-fetch.db.test.ts
// NET: volumes, copy out of a volume (spec 2026-10-30 §4.5, plan Task 6): a copy from NET:/<board>/<Volume>/… becomes one
// get per file, drawers expanded from remembered listings only (P3), clashes decided at the start (P4); each file is
// placed as its upload closes, in STASH: or the library (P5), and the copy's progress is read back by its fetch id.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { Client } from 'pg';
import { crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_files_net_fetch_test';
const url = new URL(base); url.pathname = `/${DB}`; process.env.DATABASE_URL = url.toString();
process.env.STORAGE_DIR ??= (await import('node:fs')).mkdtempSync('/tmp/webadf-files-net-fetch-');
process.env.BLOB_READ_WRITE_TOKEN = '';
async function admin(stmt: string) { const c = new Client({ connectionString: base }); await c.connect(); try { await c.query(stmt); } finally { await c.end(); } }

// after() only works inside a request; the TOSEC sweep is not what this file tests.
vi.mock('next/server', () => ({ after: () => {} }));
vi.mock('@/lib/tosec-sweep', () => ({ sweep: async () => {} }));

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { eq } = await import('drizzle-orm');
const { organization } = await import('@/db/schema/auth');
const { devices } = await import('@/db/schema/devices');
const { amigaUploads } = await import('@/db/schema/amiga-uploads');
const { collectionGames } = await import('@/db/schema/collections');
const { remoteRequests } = await import('@/db/schema/remote-requests');
const { formatVolume } = await import('@/lib/adffs/format');
const { insertStash, listStash } = await import('@/lib/stash');
const { createCollection } = await import('@/lib/collections');
const { takeWaiting, answerPiece, addGets } = await import('@/lib/remote-requests');
const { openUpload, storeChunk, closeUpload } = await import('@/lib/amiga-uploads');
const { UPLOAD_AREA_MAX_FILES } = await import('@/lib/amiga-upload-limits');
const { diskStore } = await import('@/lib/storage');
const { runOp } = await import('./ops');
const { fetchProgress, placeFetched } = await import('./net-fetch');

const ctx = { orgId: 'o1', userId: 'u1' };
const dev = { deviceId: 'b1', orgId: 'o1' };
const MB = 1024 * 1024;
const DATE = '2020-01-02T00:00:00.000Z';
const ent = (name: string, size: number, dir = false) => ({ name, dir, size, protection: 0, date: DATE, comment: '' });
const gets = async () => getDb().select().from(remoteRequests).where(eq(remoteRequests.kind, 'get'));
const version = async () => (await getDb().select({ v: devices.reqVersion }).from(devices).where(eq(devices.id, 'b1')))[0].v;
const copy = (sources: string[], dest: string, onClash: 'ask' | 'replace' | 'skip' | 'keep-both' = 'keep-both', op: 'copy' | 'move' = 'copy') =>
  runOp(ctx, { op, sources, dest, onClash });
const W = (p: string) => `NET:/b1/Work/${p}`;

/** A remembered (answered just now) listing of `amigaPath` on b1. */
async function remember(amigaPath: string, entries: ReturnType<typeof ent>[]) {
  const now = new Date();
  await getDb().insert(remoteRequests).values({ id: `dir-${amigaPath}`, orgId: 'o1', deviceId: 'b1', kind: 'dir', amigaPath,
    status: 'done', answer: { volumes: [], entries }, createdAt: now, sentAt: now, answeredAt: now });
}
async function stash(path: string, bytes = new TextEncoder().encode('old')) {
  const sha = createHash('sha256').update(bytes).digest('hex');
  await diskStore.put(sha, bytes, { overwrite: true });
  const r = await insertStash(getDb(), 'o1', 'browser', [{ path, kind: 'file', sha256: sha, sizeBytes: bytes.length, date: null, protection: 0, comment: '' }]);
  if (!r.ok) throw new Error(r.code);
}
/** The board's side of one get: fetched, GOT, opened with the request, every chunk, the close; then the placement. */
async function arrive(rid: string, amigaPath: string, bytes: Uint8Array) {
  await takeWaiting(getDb(), 'b1');
  expect(await answerPiece(getDb(), 'b1', rid, { piece: 0, lines: [`GOT ${rid} 7`], last: true })).toEqual({ ok: true });
  const o = await openUpload(getDb(), dev, { size: bytes.length, date: '1.2.3', protection: 0, path: amigaPath, comment: '', request: rid });
  if (!o.ok) throw new Error(o.code);
  for (let at = 0; at < bytes.length; at += 16384) {
    expect((await storeChunk(getDb(), 'b1', o.id, at, bytes.subarray(at, Math.min(at + 16384, bytes.length)))).ok).toBe(true);
  }
  expect((await closeUpload(getDb(), 'b1', o.id, crc32(bytes) >>> 0)).ok).toBe(true);
  await placeFetched(getDb(), o.id);
  return o.id;
}
const getRow = async (rid: string) => (await getDb().select().from(remoteRequests).where(eq(remoteRequests.id, rid)))[0];
const uploadRow = async (id: string) => (await getDb().select().from(amigaUploads).where(eq(amigaUploads.id, id)))[0];

beforeAll(async () => {
  await admin(`drop database if exists ${DB} with (force)`);
  await admin(`create database ${DB}`);
  await migrate(getDb(), { migrationsFolder: 'drizzle' });
  const db = getDb();
  await db.insert(organization).values([{ id: 'o1', name: 'o1', slug: 'o1', createdAt: new Date() }, { id: 'o2', name: 'o2', slug: 'o2', createdAt: new Date() }]);
  const now = new Date();
  await db.insert(devices).values([
    { id: 'b1', orgId: 'o1', name: 'A500', tokenHash: 'h1', firmwareVersion: '1.22.0+gabc', lastSeenAt: now, sendRx: 'c', sendRxAt: now, rxProto: 3, browseOn: true },
    // b2 is online but Transfer is not browsable (browsing off).
    { id: 'b2', orgId: 'o1', name: 'A1200', tokenHash: 'h2', firmwareVersion: '1.22.0+gabc', lastSeenAt: now, sendRx: 'c', sendRxAt: now, rxProto: 3, browseOn: false },
  ]);
});
beforeEach(async () => {
  const db = getDb();
  await db.delete(remoteRequests);
  await db.delete(amigaUploads);
  await remember('Work:', [ent('a.lha', 1000), ent('Games.adf', 901120), ent('Sub', 0, true)]);
  await remember('Work:Sub', [ent('b.txt', 10)]);
});
afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

describe('startFetch: one get per file', () => {
  it('a file and a drawer into STASH:/In: two gets, the drawer walked from its remembered listing, the board woken once', async () => {
    const v0 = await version();
    const r = await copy([W('a.lha'), W('Sub')], 'STASH:/In');
    expect(r).toMatchObject({ kind: 'done', items: [{ source: W('a.lha'), ok: true }, { source: W('Sub'), ok: true }] });
    if (r.kind !== 'done') return;
    expect(r.fetching).toMatchObject({ files: 2 });
    const rows = await gets();
    expect(rows.map((g) => [g.amigaPath, g.fetchId, g.status, g.target]).sort()).toEqual([
      ['Work:Sub/b.txt', r.fetching!.id, 'waiting', { dest: 'STASH:/In', rel: ['Sub', 'b.txt'], replace: false, library: null }],
      ['Work:a.lha', r.fetching!.id, 'waiting', { dest: 'STASH:/In', rel: ['a.lha'], replace: false, library: null }],
    ]);
    expect(await version()).toBe(v0 + 1);
  });

  // Final review ruling: a path through a labelled duplicate volume is fetched (and its listing remembered) by the
  // device's path, the one the pane's listing asked with.
  it('a drawer on a labelled volume is walked and fetched by its device path', async () => {
    await remember('DF1:', [ent('S', 0, true)]);
    await remember('DF1:S', [ent('Startup-Sequence', 99)]);
    const r = await copy(['NET:/b1/Empty (DF1:)/S'], 'STASH:');
    expect(r).toMatchObject({ kind: 'done', items: [{ ok: true }] });
    expect((await gets()).map((g) => [g.amigaPath, (g.target as { rel: string[] }).rel])).toEqual([['DF1:S/Startup-Sequence', ['S', 'Startup-Sequence']]]);
  });

  it('a drawer with no remembered listing is refused conflict; nothing is asked of the board', async () => {
    await getDb().delete(remoteRequests).where(eq(remoteRequests.amigaPath, 'Work:Sub'));
    const r = await copy([W('a.lha'), W('Sub')], 'STASH:/In');
    expect(r).toMatchObject({ kind: 'refused', refusal: { code: 'conflict', detail: 'List the drawer again and retry' } });
    expect(await gets()).toEqual([]);
  });

  it('over 64 files, over 16 MB, or a file over 4 MB is refused too_large; nothing is inserted', async () => {
    await getDb().delete(remoteRequests);
    await remember('Work:', [ent('Many', 0, true), ent('Big', 0, true), ent('huge.bin', 5 * MB)]);
    await remember('Work:Many', Array.from({ length: 65 }, (_, i) => ent(`f${i}`, 10)));
    await remember('Work:Big', Array.from({ length: 5 }, (_, i) => ent(`f${i}`, 3.5 * MB)));
    const many = await copy([W('Many')], 'STASH:');
    expect(many).toMatchObject({ kind: 'refused', refusal: { code: 'too_large' } });
    expect(many.kind === 'refused' && many.refusal.detail).toMatch(/64 files/);
    const big = await copy([W('Big')], 'STASH:');
    expect(big.kind === 'refused' && big.refusal.detail).toMatch(/16 MB/);
    const huge = await copy([W('huge.bin')], 'STASH:');
    expect(huge).toMatchObject({ kind: 'refused', refusal: { code: 'too_large' } });
    expect(huge.kind === 'refused' && huge.refusal.detail).toMatch(/huge\.bin/);
    expect(await gets()).toEqual([]);
  });

  it('Move out of a volume is refused read_only', async () => {
    expect(await copy([W('a.lha')], 'STASH:', 'keep-both', 'move'))
      .toMatchObject({ kind: 'refused', refusal: { code: 'read_only', detail: 'Read-only for now' } });
    expect(await gets()).toEqual([]);
  });

  it('a board that cannot be browsed refuses read_only with the pane\'s words', async () => {
    const r = await copy(['NET:/b2/Work/a.lha'], 'STASH:');
    expect(r).toMatchObject({ kind: 'refused', refusal: { code: 'read_only', detail: 'Switch on browsing in Transfer on A1200' } });
  });

  it('onto LIBRARY: a disk image is fetched into the STASH: root for the library; anything else is refused per item', async () => {
    const r = await copy([W('Games.adf'), W('a.lha')], 'LIBRARY:');
    expect(r).toMatchObject({ kind: 'done', items: [{ source: W('Games.adf'), ok: true },
      { source: W('a.lha'), ok: false, refusal: { code: 'not_a_disk_image' } }], fetching: { files: 1 } });
    const rows = await gets();
    expect(rows.map((g) => g.target)).toEqual([{ dest: 'STASH:', rel: ['Games.adf'], replace: false, library: { collectionId: null } }]);
  });
});

describe('startFetch: clashes, decided at the start (P4)', () => {
  beforeEach(async () => { await stash('In/a.lha'); });

  it('ask: the usual clashes; nothing is inserted', async () => {
    expect(await copy([W('a.lha'), W('Sub')], 'STASH:/In', 'ask'))
      .toEqual({ kind: 'clashes', clashes: [{ source: W('a.lha'), name: 'a.lha', dest: 'STASH:/In' }] });
    expect(await gets()).toEqual([]);
  });

  it('skip drops the clashing top; replace marks it', async () => {
    const s = await copy([W('a.lha'), W('Sub')], 'STASH:/In', 'skip');
    expect(s).toMatchObject({ kind: 'done', items: [{ source: W('a.lha'), ok: true, skipped: true }, { source: W('Sub'), ok: true }], fetching: { files: 1 } });
    expect((await gets()).map((g) => g.amigaPath)).toEqual(['Work:Sub/b.txt']);
    await getDb().delete(remoteRequests).where(eq(remoteRequests.kind, 'get'));
    await copy([W('a.lha'), W('Sub')], 'STASH:/In', 'replace');
    const rows = await gets();
    expect(rows.find((g) => g.amigaPath === 'Work:a.lha')!.target).toMatchObject({ replace: true });
    expect(rows.find((g) => g.amigaPath === 'Work:Sub/b.txt')!.target).toMatchObject({ replace: false });
  });
});

describe('placement as the upload closes', () => {
  const bytes = new TextEncoder().encode('lha!lha');

  it('the upload opened with the request lands at the target, as a copy; the get is done', async () => {
    const r = await copy([W('a.lha')], 'STASH:/In');
    const [g] = await gets();
    await takeWaiting(getDb(), 'b1');
    await answerPiece(getDb(), 'b1', g.id, { piece: 0, lines: [`GOT ${g.id} 7`], last: true });
    const o = await openUpload(getDb(), dev, { size: 7, date: '1.2.3', protection: 0, path: 'Work:a.lha', comment: '', request: g.id });
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    const u = await uploadRow(o.id);
    expect([u.path, u.source, u.deviceName]).toEqual(['In/a.lha', 'copy', null]);
    expect((await getRow(g.id)).uploadId).toBe(o.id);
    await storeChunk(getDb(), 'b1', o.id, 0, bytes);
    expect(await closeUpload(getDb(), 'b1', o.id, crc32(bytes) >>> 0)).toMatchObject({ ok: true });
    await placeFetched(getDb(), o.id);
    expect((await getRow(g.id)).status).toBe('done');
    expect((await listStash(getDb(), 'o1')).map((x) => x.path)).toContain('In/a.lha');
    expect(r.kind === 'done' && await fetchProgress(getDb(), 'o1', r.fetching!.id, new Date()))
      .toMatchObject({ total: 1, done: 1, failed: [], waiting: 0, board: 'A500', arrived: ['STASH:/In/a.lha'] });
  });

  it('an open with a request the board was not given is refused name', async () => {
    expect(await openUpload(getDb(), dev, { size: 7, date: '1.2.3', protection: 0, path: 'Work:a.lha', comment: '', request: 'nope' }))
      .toEqual({ ok: false, code: 'name' });
  });

  it('replace: the existing file is deleted and the arriving one holds its path', async () => {
    await stash('In/a.lha');
    const before = (await listStash(getDb(), 'o1')).find((x) => x.path === 'In/a.lha')!;
    await copy([W('a.lha')], 'STASH:/In', 'replace');
    const [g] = await gets();
    const id = await arrive(g.id, 'Work:a.lha', bytes);
    expect((await uploadRow(before.id)).status).toBe('deleted');
    expect((await uploadRow(id)).path).toBe('In/a.lha');
  });

  it('keep-both: the arriving file takes the keep-both name', async () => {
    await stash('In/a.lha');
    await copy([W('a.lha')], 'STASH:/In', 'keep-both');
    const [g] = await gets();
    const id = await arrive(g.id, 'Work:a.lha', bytes);
    expect((await uploadRow(id)).path).toBe('In/a_1.lha');
    expect((await listStash(getDb(), 'o1')).map((x) => x.path).sort()).toEqual(['In/a.lha', 'In/a_1.lha']);
  });

  it('a damaged copy fails its get', async () => {
    await copy([W('a.lha')], 'STASH:/In');
    const [g] = await gets();
    await takeWaiting(getDb(), 'b1');
    await answerPiece(getDb(), 'b1', g.id, { piece: 0, lines: [`GOT ${g.id} 7`], last: true });
    const o = await openUpload(getDb(), dev, { size: 7, date: '1.2.3', protection: 0, path: 'Work:a.lha', comment: '', request: g.id });
    if (!o.ok) throw new Error(o.code);
    await storeChunk(getDb(), 'b1', o.id, 0, bytes);
    expect(await closeUpload(getDb(), 'b1', o.id, 1)).toMatchObject({ ok: false, code: 'crc' });
    expect(await getRow(g.id)).toMatchObject({ status: 'failed', errorCode: 'crc', errorText: 'the copy arrived damaged' });
  });

  it('onto LIBRARY: the disk is added to the library; onto a collection, filed there', async () => {
    const adf = formatVolume({ filesystem: 'OFS', volumeName: 'Games' });
    await copy([W('Games.adf')], 'LIBRARY:');
    const [g] = await gets();
    const id = await arrive(g.id, 'Work:Games.adf', adf);
    expect((await getRow(g.id)).status).toBe('done');
    expect((await uploadRow(id)).libraryDiskId).toBeTruthy();

    await getDb().delete(remoteRequests).where(eq(remoteRequests.kind, 'get'));
    const made = await createCollection('o1', 'Fetched');
    if (made === 'name_exists') throw new Error(made);
    const adf2 = formatVolume({ filesystem: 'FFS', volumeName: 'Games2' });
    await copy([W('Games.adf')], `LIBRARY:/${made.id}`);
    const [g2] = await gets();
    expect(g2.target).toMatchObject({ dest: 'STASH:', library: { collectionId: made.id } });
    const id2 = await arrive(g2.id, 'Work:Games.adf', adf2);
    expect((await getRow(g2.id)).status).toBe('done');
    const u2 = await uploadRow(id2);
    expect(u2.path).toBe('Games_1.adf');
    const filed = await getDb().select().from(collectionGames).where(eq(collectionGames.collectionId, made.id));
    expect(filed).toHaveLength(1);
  });

  // Final review: any refused open of a get settles it with the reason, so the copy does not wait 10 minutes and
  // then say "stopped answering".
  it('an open refused for its size or its name fails that get with words that say why', async () => {
    await copy([W('a.lha')], 'STASH:/In');
    const [a] = await gets();
    await takeWaiting(getDb(), 'b1');
    await answerPiece(getDb(), 'b1', a.id, { piece: 0, lines: [`GOT ${a.id} 7`], last: true });
    expect(await openUpload(getDb(), dev, { size: 5 * MB, date: '1.2.3', protection: 0, path: 'Work:a.lha', comment: '', request: a.id }))
      .toEqual({ ok: false, code: 'size' });
    expect(await getRow(a.id)).toMatchObject({ status: 'failed', errorCode: 'toolarge', errorText: 'over 4 MB' });

    const [n] = await addGets(getDb(), { orgId: 'o1', deviceId: 'b1', fetchId: 'fn',
      files: [{ amigaPath: 'Work:x', target: { dest: 'STASH:', rel: [], replace: false, library: null } }] });
    await takeWaiting(getDb(), 'b1');
    expect(await openUpload(getDb(), dev, { size: 7, date: '1.2.3', protection: 0, path: 'Work:x', comment: '', request: n }))
      .toEqual({ ok: false, code: 'name' });
    expect(await getRow(n)).toMatchObject({ status: 'failed', errorCode: 'bad', errorText: 'the name could not be used' });
  });

  it('STASH: full: the open is refused and that get fails; the others wait on', async () => {
    await copy([W('a.lha'), W('Sub')], 'STASH:/In');
    const rows = await gets();
    const a = rows.find((x) => x.amigaPath === 'Work:a.lha')!;
    const b = rows.find((x) => x.amigaPath !== 'Work:a.lha')!;
    const later = new Date(Date.now() + 30 * 24 * 3600_000);
    await getDb().insert(amigaUploads).values(Array.from({ length: UPLOAD_AREA_MAX_FILES }, (_, i) => ({
      id: `full-${i}`, orgId: 'o1', path: `Full/f${i}`, sizeBytes: 1, amigaDate: '1.2.3', status: 'stored', expiresAt: later })));
    await takeWaiting(getDb(), 'b1');
    await answerPiece(getDb(), 'b1', a.id, { piece: 0, lines: [`GOT ${a.id} 7`], last: true });
    expect(await openUpload(getDb(), dev, { size: 7, date: '1.2.3', protection: 0, path: 'Work:a.lha', comment: '', request: a.id }))
      .toEqual({ ok: false, code: 'full' });
    expect(await getRow(a.id)).toMatchObject({ status: 'failed', errorCode: 'full', errorText: 'STASH: is full' });
    expect((await getRow(b.id)).status).toBe('sent');
  });
});

describe('fetchProgress', () => {
  it('counts done, failed (by name, with the reason), waiting, and the STASH: paths arrived; another org sees nothing', async () => {
    const r = await copy([W('a.lha'), W('Sub')], 'STASH:/In');
    if (r.kind !== 'done') throw new Error('refused');
    const rows = await gets();
    const a = rows.find((x) => x.amigaPath === 'Work:a.lha')!;
    const b = rows.find((x) => x.amigaPath !== 'Work:a.lha')!;
    await arrive(a.id, 'Work:a.lha', new TextEncoder().encode('lha!lha'));
    expect(await fetchProgress(getDb(), 'o1', r.fetching!.id, new Date()))
      .toEqual({ total: 2, done: 1, failed: [], waiting: 1, board: 'A500', arrived: ['STASH:/In/a.lha'] });
    await answerPiece(getDb(), 'b1', b.id, { piece: 0, lines: [`ERR ${b.id} notfound 0:`], last: true });
    expect(await fetchProgress(getDb(), 'o1', r.fetching!.id, new Date()))
      .toMatchObject({ total: 2, done: 1, failed: [{ name: 'b.txt', reason: 'Object not found' }], waiting: 0 });
    expect(await fetchProgress(getDb(), 'o2', r.fetching!.id, new Date())).toBeNull();
  });

  it('a get sent over 10 minutes ago fails: "<board> stopped answering"', async () => {
    const r = await copy([W('a.lha')], 'STASH:/In');
    if (r.kind !== 'done') throw new Error('refused');
    const now = new Date();
    await takeWaiting(getDb(), 'b1', new Date(now.getTime() - 601_000));
    expect(await fetchProgress(getDb(), 'o1', r.fetching!.id, now))
      .toMatchObject({ total: 1, done: 0, waiting: 0, failed: [{ name: 'a.lha', reason: 'A500 stopped answering' }] });
  });

  it('a fetching get with a chunk stored 30 s ago is not expired, though sent over 10 minutes ago', async () => {
    const r = await copy([W('a.lha')], 'STASH:/In');
    if (r.kind !== 'done') throw new Error('refused');
    const now = new Date();
    const back = (s: number) => new Date(now.getTime() - s * 1000);
    const [g] = await gets();
    await takeWaiting(getDb(), 'b1', back(631));
    await answerPiece(getDb(), 'b1', g.id, { piece: 0, lines: [`GOT ${g.id} 7`], last: true }, back(631));
    const o = await openUpload(getDb(), dev, { size: 16385, date: '1.2.3', protection: 0, path: 'Work:a.lha', comment: '', request: g.id }, back(630));
    if (!o.ok) throw new Error(o.code);
    expect((await storeChunk(getDb(), 'b1', o.id, 0, new Uint8Array(16384), back(30))).ok).toBe(true);
    expect(await fetchProgress(getDb(), 'o1', r.fetching!.id, now)).toMatchObject({ waiting: 1, failed: [] });
    expect(await fetchProgress(getDb(), 'o1', r.fetching!.id, new Date(now.getTime() + 571_000))).toMatchObject({ waiting: 0, failed: [{ name: 'a.lha' }] });
  });

  it('a get failed timeout whose file then arrives ends done and placed: STASH:', async () => {
    const r = await copy([W('a.lha')], 'STASH:/In');
    if (r.kind !== 'done') throw new Error('refused');
    const [g] = await gets();
    await takeWaiting(getDb(), 'b1', new Date(Date.now() - 700_000));
    expect(await fetchProgress(getDb(), 'o1', r.fetching!.id, new Date())).toMatchObject({ failed: [{ name: 'a.lha', reason: 'A500 stopped answering' }] });
    await arrive(g.id, 'Work:a.lha', new TextEncoder().encode('lha!lha'));
    expect(await getRow(g.id)).toMatchObject({ status: 'done', errorCode: null });
    expect(await fetchProgress(getDb(), 'o1', r.fetching!.id, new Date()))
      .toMatchObject({ done: 1, failed: [], waiting: 0, arrived: ['STASH:/In/a.lha'] });
  });

  it('a get failed timeout mid-upload whose upload then closes ends done and placed: LIBRARY:', async () => {
    const adf = formatVolume({ filesystem: 'OFS', volumeName: 'Late' });
    const r = await copy([W('Games.adf')], 'LIBRARY:');
    if (r.kind !== 'done') throw new Error('refused');
    const [g] = await gets();
    const old = new Date(Date.now() - 700_000);
    await takeWaiting(getDb(), 'b1', old);
    await answerPiece(getDb(), 'b1', g.id, { piece: 0, lines: [`GOT ${g.id} 7`], last: true }, old);
    const o = await openUpload(getDb(), dev, { size: adf.length, date: '1.2.3', protection: 0, path: 'Work:Games.adf', comment: '', request: g.id }, old);
    if (!o.ok) throw new Error(o.code);
    expect((await fetchProgress(getDb(), 'o1', r.fetching!.id, new Date()))!.failed).toHaveLength(1);
    for (let at = 0; at < adf.length; at += 16384) {
      expect((await storeChunk(getDb(), 'b1', o.id, at, adf.subarray(at, Math.min(at + 16384, adf.length)))).ok).toBe(true);
    }
    expect((await closeUpload(getDb(), 'b1', o.id, crc32(adf) >>> 0)).ok).toBe(true);
    await placeFetched(getDb(), o.id);
    expect((await getRow(g.id)).status).toBe('done');
    expect((await uploadRow(o.id)).libraryDiskId).toBeTruthy();
  });

  it('a get the board has not fetched yet (offline) is waiting, however old', async () => {
    const r = await copy([W('a.lha')], 'STASH:/In');
    if (r.kind !== 'done') throw new Error('refused');
    expect(await fetchProgress(getDb(), 'o1', r.fetching!.id, new Date(Date.now() + 3600_000)))
      .toMatchObject({ total: 1, waiting: 1, failed: [] });
  });
});
