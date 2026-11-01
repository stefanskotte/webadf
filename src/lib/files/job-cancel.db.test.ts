// src/lib/files/job-cancel.db.test.ts
// Progress panel, Cancel the rest (spec 2026-11-01-progress-panel §6): per kind -- queue rows to the Amiga cancelled,
// gets withdrawn and an arriving file stopped, waiting writes withdrawn (a running drawer delete finishes), a move
// keeping every source not yet removed -- and never another org's job.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { Client } from 'pg';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_files_job_cancel_test';
const url = new URL(base); url.pathname = `/${DB}`; process.env.DATABASE_URL = url.toString();
process.env.STORAGE_DIR ??= (await import('node:fs')).mkdtempSync('/tmp/webadf-files-job-cancel-');
process.env.BLOB_READ_WRITE_TOKEN = '';
async function admin(stmt: string) { const c = new Client({ connectionString: base }); await c.connect(); try { await c.query(stmt); } finally { await c.end(); } }
vi.mock('next/server', () => ({ after: () => {} }));
vi.mock('@/lib/tosec-sweep', () => ({ sweep: async () => {} }));
// Fix round 1: Cancel landing between a get's claim (or its open's look-up) and what follows, run where the race is.
const hooks = vi.hoisted(() => ({ afterClaim: null as null | (() => Promise<void>), afterLookup: null as null | (() => Promise<void>) }));
vi.mock('@/lib/remote-requests', async (orig) => {
  const m = await orig<typeof import('@/lib/remote-requests')>();
  const once = async (k: 'afterClaim' | 'afterLookup') => { const h = hooks[k]; hooks[k] = null; if (h) await h(); };
  return { ...m,
    claimGet: async (...a: Parameters<typeof m.claimGet>) => { const g = await m.claimGet(...a); await once('afterClaim'); return g; },
    getForUpload: async (...a: Parameters<typeof m.getForUpload>) => { const g = await m.getForUpload(...a); await once('afterLookup'); return g; } };
});

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { and, eq, ne } = await import('drizzle-orm');
const { organization } = await import('@/db/schema/auth');
const { devices } = await import('@/db/schema/devices');
const { transfers } = await import('@/db/schema/transfers');
const { remoteRequests } = await import('@/db/schema/remote-requests');
const { amigaUploads, amigaUploadChunks } = await import('@/db/schema/amiga-uploads');
const { recordChunk } = await import('@/lib/transfers');
const { storeChunk, openUpload } = await import('@/lib/amiga-uploads');
const { settleMovesOfJob } = await import('./net-moves');
const { listJobs } = await import('./jobs');
const { cancelJob } = await import('./job-cancel');
const { fetchProgress } = await import('./net-fetch');
const { takeWaiting } = await import('@/lib/remote-requests');
const { CANCEL_KIND, JOB_SHOWN_MS } = await import('./job-view');
const { placeFetched, afterTransferDone } = await import('./net-fetch');
const { settleMove } = await import('./net-moves');
const { diskStore } = await import('@/lib/storage');
const { createHash } = await import('node:crypto');

const NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const later = new Date(NOW.getTime() + 24 * 3600_000);
type Tr = typeof transfers.$inferInsert;
const tr = (id: string, o: Partial<Tr>): Tr => ({ id, orgId: 'o1', deviceId: 'b1', createdByUserId: 'u1', path: id, sizeBytes: 1000, crc32: 0,
  blobSha256: 'a'.repeat(64), expiresAt: later, status: 'queued', createdAt: ago(10_000), ...o });
type Rq = typeof remoteRequests.$inferInsert;
const rq = (id: string, o: Partial<Rq>): Rq => ({ id, orgId: 'o1', deviceId: 'b1', kind: 'get', amigaPath: `Work:${id}`, status: 'waiting', createdAt: ago(10_000), ...o });
const target = (o: Record<string, unknown> = {}) => ({ dest: 'STASH:/In', rel: ['x'], replace: false, library: null, size: 10, ...o });
const rowStatus = async (job: string) => Object.fromEntries((await getDb().select().from(transfers).where(eq(transfers.jobId, job))).map((r) => [r.id, r.status]));
const reqOf = async (id: string) => (await getDb().select().from(remoteRequests).where(eq(remoteRequests.id, id)))[0];
const sendVersion = async (id: string) => (await getDb().select({ v: devices.sendVersion }).from(devices).where(eq(devices.id, id)))[0].v;
const markers = async (job: string) => getDb().select().from(remoteRequests).where(and(eq(remoteRequests.fetchId, job), eq(remoteRequests.kind, 'cancel')));
const jobOf = async (id: string) => (await listJobs(getDb(), 'o1', NOW)).find((j) => j.id === id);

beforeAll(async () => {
  await admin(`drop database if exists ${DB} with (force)`);
  await admin(`create database ${DB}`);
  await migrate(getDb(), { migrationsFolder: 'drizzle' });
  await getDb().insert(organization).values([{ id: 'o1', name: 'o1', slug: 'o1', createdAt: NOW }, { id: 'o2', name: 'o2', slug: 'o2', createdAt: NOW }]);
  await getDb().insert(devices).values([
    { id: 'b1', orgId: 'o1', name: 'A500', tokenHash: 'h1', lastSeenAt: NOW },
    { id: 'b2', orgId: 'o1', name: 'A1200', tokenHash: 'h2', lastSeenAt: NOW },
    { id: 'b3', orgId: 'o2', name: 'Other', tokenHash: 'h3', lastSeenAt: NOW },
  ]);
});
beforeEach(async () => {
  await getDb().delete(transfers);
  await getDb().delete(remoteRequests);
  await getDb().delete(amigaUploads);
});
afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

describe('cancelJob', () => {
  it('to the Amiga: waiting and sending rows cancelled, what arrived stays, the board told once', async () => {
    await getDb().insert(transfers).values([
      tr('r1', { jobId: 'j1', status: 'delivered', finishedAt: ago(5_000), amigaDest: 'Work:T/a' }),
      tr('r2', { jobId: 'j1', status: 'sending', sizeBytes: 40_000, bytesSent: 16_384, amigaDest: 'Work:T/b' }),
      tr('r3', { jobId: 'j1', amigaDest: 'Work:T/c' }),
    ]);
    const v0 = await sendVersion('b1');
    expect(await cancelJob(getDb(), 'o1', 'j1', NOW)).toEqual({ ok: true, cancelled: 2 });
    expect(await rowStatus('j1')).toEqual({ r1: 'delivered', r2: 'cancelled', r3: 'cancelled' });
    expect(await sendVersion('b1')).toBe(v0 + 1);
    // The board's next chunk of the row it was sending hears that it is over.
    expect(await recordChunk(getDb(), 'b1', 'r2', 32_768)).toEqual({ ok: false, status: 409 });
    expect(await jobOf('j1')).toMatchObject({ running: false, total: 3, done: 1, failed: [], cancelled: 2, cancel: { move: false, source: null } });
  });

  // Review Focus 4: a file arriving when Cancel hits.
  it('from the Amiga: waiting and taken gets withdrawn, the arriving file stopped', async () => {
    await getDb().insert(amigaUploads).values([{ id: 'u1', orgId: 'o1', deviceId: 'b1', path: 'In/x', sizeBytes: 40_000, receivedBytes: 16_384,
      amigaDate: '1.2.3', status: 'receiving', source: 'copy', expiresAt: later }]);
    await getDb().insert(amigaUploadChunks).values([{ uploadId: 'u1', offset: 0, data: new Uint8Array(16_384) }]);
    await getDb().insert(remoteRequests).values([
      rq('g1', { fetchId: 'j2', status: 'fetching', uploadId: 'u1', activeAt: ago(500), target: target({ size: 40_000 }) }),
      rq('g2', { fetchId: 'j2', status: 'sent', sentAt: ago(1_000), target: target({ rel: ['y'] }) }),
      rq('g3', { fetchId: 'j2', target: target({ rel: ['z'] }) }),
      rq('g4', { fetchId: 'j2', status: 'done', answeredAt: ago(2_000), target: target({ rel: ['w'] }) }),
    ]);
    expect(await cancelJob(getDb(), 'o1', 'j2', NOW)).toEqual({ ok: true, cancelled: 3 });
    for (const id of ['g1', 'g2', 'g3']) expect(await reqOf(id)).toMatchObject({ status: 'failed', errorCode: 'cancelled', errorText: 'cancelled' });
    expect((await reqOf('g4')).status).toBe('done');
    expect((await getDb().select().from(amigaUploads).where(eq(amigaUploads.id, 'u1')))[0].status).toBe('deleted');
    expect(await getDb().select().from(amigaUploadChunks).where(eq(amigaUploadChunks.uploadId, 'u1'))).toEqual([]);
    expect(await storeChunk(getDb(), 'b1', 'u1', 16_384, new Uint8Array(16_384))).toEqual({ ok: false, status: 404 });
    // The get the board took but had not opened: Transfer's open is refused, so nothing of it arrives.
    expect(await openUpload(getDb(), { deviceId: 'b1', orgId: 'o1' }, { size: 10, date: '1.2.3', protection: 0, path: 'y', comment: '', request: 'g2' }))
      .toEqual({ ok: false, code: 'name' });
    expect(await jobOf('j2')).toMatchObject({ running: false, done: 1, failed: [], cancelled: 3 });
  });

  it('writes: waiting ones withdrawn; a drawer delete Transfer runs finishes (spec §6 limit)', async () => {
    await getDb().insert(remoteRequests).values([
      rq('w1', { fetchId: 'j3', kind: 'delete', amigaPath: 'Work:Big', status: 'sent', sentAt: ago(1_000), activeAt: ago(1_000), target: { label: 'Work:Big' } }),
      rq('w2', { fetchId: 'j3', kind: 'delete', amigaPath: 'Work:Old', target: { label: 'Work:Old' }, createdAt: ago(9_000) }),
    ]);
    expect(await cancelJob(getDb(), 'o1', 'j3', NOW)).toEqual({ ok: true, cancelled: 1 });
    expect((await reqOf('w1')).status).toBe('sent');
    expect(await reqOf('w2')).toMatchObject({ status: 'failed', errorCode: 'cancelled' });
    expect(await jobOf('j3')).toMatchObject({ running: true, cancel: { move: false, source: null } });
  });

  it('a move onto a volume keeps every source not yet removed', async () => {
    await getDb().insert(transfers).values([
      tr('m1', { jobId: 'j4', status: 'delivered', finishedAt: ago(4_000), amigaDest: 'Work:T/Pack/a', moveSource: 'STASH:/Pack', moveItem: 'Pack/a' }),
      tr('m2', { jobId: 'j4', amigaDest: 'Work:T/Pack/b', moveSource: 'STASH:/Pack', moveItem: 'Pack/b' }),
      // Every file of this source arrived, its removal not yet begun: it stays too (the safe side).
      tr('m3', { jobId: 'j4', status: 'delivered', finishedAt: ago(4_000), amigaDest: 'Work:T/Two/c', moveSource: 'STASH:/Two', moveItem: 'Two/c' }),
    ]);
    expect(await cancelJob(getDb(), 'o1', 'j4', NOW)).toEqual({ ok: true, cancelled: 1 });
    expect((await getDb().select({ s: transfers.moveSource }).from(transfers).where(eq(transfers.jobId, 'j4'))).map((r) => r.s)).toEqual([null, null, null]);
    await settleMovesOfJob(getDb(), 'o1', 'j4');
    expect(await getDb().select().from(remoteRequests).where(and(eq(remoteRequests.fetchId, 'j4'), ne(remoteRequests.kind, 'cancel')))).toEqual([]);
    expect(await jobOf('j4')).toMatchObject({ kind: 'move', running: false, total: 3, done: 2, cancel: { move: true, source: 'STASH:' } });
  });

  it('a move off a volume: its waiting removals withdrawn, its markers gone', async () => {
    const mv = { moveSource: 'NET:/b1/Work/Pack', moveSeen: { size: 10, date: 'd' } };
    await getDb().insert(remoteRequests).values([
      rq('g1', { fetchId: 'j5', status: 'done', amigaPath: 'Work:Pack/a', answeredAt: ago(3_000), target: target({ rel: ['Pack', 'a'], ...mv }) }),
      rq('g2', { fetchId: 'j5', amigaPath: 'Work:Pack/b', target: target({ rel: ['Pack', 'b'], ...mv }) }),
      rq('d1', { fetchId: 'j5', kind: 'delete', amigaPath: 'Work:Pack/z', target: { label: 'Work:Pack/z', one: true }, createdAt: ago(1_000) }),
    ]);
    expect(await cancelJob(getDb(), 'o1', 'j5', NOW)).toEqual({ ok: true, cancelled: 2 });
    expect(await reqOf('d1')).toMatchObject({ status: 'failed', errorCode: 'cancelled' });
    for (const id of ['g1', 'g2']) expect((await reqOf(id)).target).not.toHaveProperty('moveSource');
    expect(await jobOf('j5')).toMatchObject({ kind: 'move', direction: 'from', running: false, cancel: { move: true, source: 'Work:Pack' } });
  });

  it('another org\'s job, or no such job: not found, and nothing changes', async () => {
    await getDb().insert(transfers).values([tr('r1', { jobId: 'j1', amigaDest: 'Work:a' })]);
    expect(await cancelJob(getDb(), 'o2', 'j1', NOW)).toEqual({ ok: false });
    expect(await cancelJob(getDb(), 'o1', 'nope', NOW)).toEqual({ ok: false });
    expect(await rowStatus('j1')).toEqual({ r1: 'queued' });
  });

  // Review Focus 3: Cancel racing the job's own end, or pressed twice.
  it('a job that finished on its own: nothing cancelled, no marker, no Cancelled words', async () => {
    await getDb().insert(transfers).values([tr('r1', { jobId: 'j1', status: 'delivered', finishedAt: ago(1_000), amigaDest: 'Work:a' })]);
    expect(await cancelJob(getDb(), 'o1', 'j1', NOW)).toEqual({ ok: true, cancelled: 0 });
    expect(await markers('j1')).toEqual([]);
    expect(await jobOf('j1')).toMatchObject({ cancel: null, cancelled: 0 });
  });
  it('pressed twice: the second cancels nothing and adds no second marker', async () => {
    await getDb().insert(transfers).values([tr('r1', { jobId: 'j1', amigaDest: 'Work:a' }), tr('r2', { jobId: 'j1', amigaDest: 'Work:b', createdAt: ago(9_000) })]);
    expect(await cancelJob(getDb(), 'o1', 'j1', NOW)).toEqual({ ok: true, cancelled: 2 });
    expect(await cancelJob(getDb(), 'o1', 'j1', NOW)).toEqual({ ok: true, cancelled: 0 });
    expect(await markers('j1')).toHaveLength(1);
  });

  // Review Focus 2: two jobs at once.
  it('one job cancelled leaves another running job alone', async () => {
    await getDb().insert(transfers).values([tr('r1', { jobId: 'j1', amigaDest: 'Work:a' }), tr('x1', { jobId: 'jx', amigaDest: 'Work:b' })]);
    await getDb().insert(remoteRequests).values([rq('gx', { fetchId: 'jx', target: target() })]);
    await cancelJob(getDb(), 'o1', 'j1', NOW);
    expect(await rowStatus('jx')).toEqual({ x1: 'queued' });
    expect((await reqOf('gx')).status).toBe('waiting');
    expect(await jobOf('jx')).toMatchObject({ running: true, cancel: null });
  });

  it('the Queue job: the board\'s job-less waiting and sending rows, nothing of a Files job', async () => {
    await getDb().insert(transfers).values([tr('q1', {}), tr('q2', { status: 'sending', createdAt: ago(9_000) }), tr('r1', { jobId: 'j1', amigaDest: 'Work:a' })]);
    const queue = (await listJobs(getDb(), 'o1', NOW)).find((j) => j.kind === 'send')!;
    expect(await cancelJob(getDb(), 'o2', queue.id, NOW)).toEqual({ ok: false });
    expect(await cancelJob(getDb(), 'o1', queue.id, NOW)).toEqual({ ok: true, cancelled: 2 });
    const all = Object.fromEntries((await getDb().select().from(transfers)).map((r) => [r.id, r.status]));
    expect(all).toEqual({ q1: 'cancelled', q2: 'cancelled', r1: 'queued' });
  });

  // Task 2 review, risk 1: the marker row is never handed to a board (remote-wire's requestLine has no 'cancel' line).
  it('the marker is never served to the board, even if it were ever left waiting', async () => {
    await getDb().insert(transfers).values([tr('r1', { jobId: 'j1', amigaDest: 'Work:a' })]);
    await cancelJob(getDb(), 'o1', 'j1', NOW);
    expect(await markers('j1')).toMatchObject([{ status: 'done', deviceId: 'b1' }]);
    await getDb().insert(remoteRequests).values([
      rq('gx', { fetchId: 'jx', target: target() }),
      // Belt and braces: a marker that somehow says waiting is still not the board's to take.
      rq('cx', { fetchId: 'jy', kind: CANCEL_KIND, amigaPath: '', target: { move: false, source: null } }),
    ]);
    expect((await takeWaiting(getDb(), 'b1', NOW)).map((r) => r.id)).toEqual(['gx']);
    expect((await reqOf('cx')).status).toBe('waiting');
  });

  // Task 2 review, risk 2: the marker is never "the job's request" -- not the board a job is about, not a part.
  it('the marker does not become the board a copy between boards is about', async () => {
    const relay = { deviceId: 'b2', dest: 'Work:T', onClash: 'keep' as const };
    await getDb().insert(remoteRequests).values([
      rq('g1', { fetchId: 'j6', target: target({ relay }) }),
      rq('g2', { fetchId: 'j6', target: target({ rel: ['y'], relay }) }),
    ]);
    const before = await fetchProgress(getDb(), 'o1', 'j6', NOW);
    expect(await cancelJob(getDb(), 'o1', 'j6', NOW)).toEqual({ ok: true, cancelled: 2 });
    const after = await fetchProgress(getDb(), 'o1', 'j6', NOW);
    expect(after).toMatchObject({ board: before!.board, total: 2, waiting: 0 });
    // A marker on another board (however it got there) still names nothing.
    await getDb().insert(remoteRequests).values([rq('g7', { fetchId: 'j7', target: target() }),
      rq('c7', { fetchId: 'j7', kind: CANCEL_KIND, deviceId: 'b2', amigaPath: '', status: 'done', answeredAt: NOW, target: { move: false, source: null } })]);
    expect(await fetchProgress(getDb(), 'o1', 'j7', NOW)).toMatchObject({ board: 'A500', total: 1, waiting: 1 });
  });
  it('the marker does not keep a cancelled job listed past its 2 minutes', async () => {
    await getDb().insert(transfers).values([tr('r1', { jobId: 'j1', amigaDest: 'Work:a' })]);
    await cancelJob(getDb(), 'o1', 'j1', NOW);
    expect(await jobOf('j1')).toMatchObject({ running: false, total: 1, cancelled: 1 });
    const gone = new Date(NOW.getTime() + JOB_SHOWN_MS + 1_000);
    expect((await listJobs(getDb(), 'o1', gone)).find((j) => j.id === 'j1')).toBeUndefined();
  });

  // Fix round 1 (review Important): a vol-to-vol move's get already claimed for placing when Cancel hits.
  it('a relayed move placed after Cancel queues its file without the move marker, and nothing is removed', async () => {
    const data = new TextEncoder().encode('hello relay');
    const sha = createHash('sha256').update(data).digest('hex');
    await diskStore.put(sha, data, { overwrite: true });
    await getDb().insert(amigaUploads).values([{ id: 'u8', orgId: 'o1', deviceId: 'b1', path: 'a', sizeBytes: data.length, receivedBytes: data.length,
      amigaDate: '1.2.3', status: 'stored', source: 'staging', blobSha256: sha, expiresAt: later }]);
    const relay = { deviceId: 'b2', dest: 'Work:T/a', onClash: 'keep' as const, moveSource: 'NET:/b1/Work/Pack' };
    await getDb().insert(remoteRequests).values([
      rq('g8', { fetchId: 'j8', status: 'fetching', uploadId: 'u8', amigaPath: 'Work:Pack/a', activeAt: ago(500),
        target: target({ rel: ['Pack', 'a'], userId: 'u1', relay, moveSeen: { size: data.length, date: 'd' } }) }),
      rq('g9', { fetchId: 'j8', amigaPath: 'Work:Pack/b', target: target({ rel: ['Pack', 'b'], userId: 'u1', relay, moveSeen: { size: 1, date: 'd' } }) }),
    ]);
    let cancelled: unknown = null;
    hooks.afterClaim = async () => { cancelled = await cancelJob(getDb(), 'o1', 'j8', NOW); };
    await placeFetched(getDb(), 'u8', NOW);
    expect(cancelled).toEqual({ ok: true, cancelled: 1 });
    expect((await reqOf('g8')).status).toBe('done');
    const [row] = await getDb().select().from(transfers).where(eq(transfers.jobId, 'j8'));
    expect(row).toMatchObject({ deviceId: 'b2', amigaDest: 'Work:T/a', status: 'queued', moveSource: null });
    await getDb().update(transfers).set({ status: 'delivered', finishedAt: NOW }).where(eq(transfers.id, row.id));
    await expect(afterTransferDone(getDb(), row.id)).resolves.toBeUndefined();
    expect(await getDb().select().from(remoteRequests).where(and(eq(remoteRequests.fetchId, 'j8'), eq(remoteRequests.kind, 'delete')))).toEqual([]);
    expect(await getDb().select().from(remoteRequests).where(and(eq(remoteRequests.fetchId, 'j8'), eq(remoteRequests.kind, 'dir')))).toEqual([]);
  });
  it('settleMove decides no removal for a job Cancel the rest marked', async () => {
    await getDb().insert(transfers).values([tr('m1', { jobId: 'j9', status: 'delivered', finishedAt: ago(1_000), amigaDest: 'Work:T/Pack/a', moveSource: 'STASH:/Pack', moveItem: 'Pack/a' })]);
    await getDb().insert(remoteRequests).values([rq('c9', { fetchId: 'j9', kind: CANCEL_KIND, amigaPath: '', status: 'done', answeredAt: NOW, target: { move: true, source: 'STASH:' } })]);
    expect(await settleMove(getDb(), 'o1', 'j9', 'STASH:/Pack')).toBe(false);
    expect((await getDb().select().from(remoteRequests).where(eq(remoteRequests.fetchId, 'j9'))).map((r) => r.id)).toEqual(['c9']);
    expect((await getDb().select({ s: transfers.moveSource }).from(transfers).where(eq(transfers.id, 'm1')))[0].s).toBeNull();
  });
  // Fix round 1 (Minor): a file opened just after Cancel withdrew its get is refused, and the get keeps saying cancelled.
  it('an open racing Cancel is refused and stores nothing', async () => {
    await getDb().insert(remoteRequests).values([rq('g5', { fetchId: 'j5', status: 'sent', sentAt: ago(1_000), target: target() })]);
    hooks.afterLookup = async () => { await cancelJob(getDb(), 'o1', 'j5', NOW); };
    expect(await openUpload(getDb(), { deviceId: 'b1', orgId: 'o1' }, { size: 10, date: '1.2.3', protection: 0, path: 'x', comment: '', request: 'g5' }))
      .toEqual({ ok: false, code: 'name' });
    expect(await reqOf('g5')).toMatchObject({ status: 'failed', errorCode: 'cancelled', uploadId: null });
    expect(await getDb().select().from(amigaUploads)).toEqual([]);
  });
});
