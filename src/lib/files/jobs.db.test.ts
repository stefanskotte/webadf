// src/lib/files/jobs.db.test.ts
// Progress panel (spec 2026-11-01-progress-panel §4): GET /api/files/jobs's listing -- the org's Files jobs from both
// tables in both directions with their bytes, the 2-minute window, one job per board for plain Queue sends, and
// never another org's.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { Client } from 'pg';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_files_jobs_test';
const url = new URL(base); url.pathname = `/${DB}`; process.env.DATABASE_URL = url.toString();
process.env.STORAGE_DIR ??= (await import('node:fs')).mkdtempSync('/tmp/webadf-files-jobs-');
process.env.BLOB_READ_WRITE_TOKEN = '';
async function admin(stmt: string) { const c = new Client({ connectionString: base }); await c.connect(); try { await c.query(stmt); } finally { await c.end(); } }
vi.mock('next/server', () => ({ after: () => {} }));
vi.mock('@/lib/tosec-sweep', () => ({ sweep: async () => {} }));

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { eq, getTableName } = await import('drizzle-orm');
const { organization } = await import('@/db/schema/auth');
const { devices } = await import('@/db/schema/devices');
const { transfers } = await import('@/db/schema/transfers');
const { remoteRequests } = await import('@/db/schema/remote-requests');
const { amigaUploads } = await import('@/db/schema/amiga-uploads');
const { jobView, listJobs } = await import('./jobs');
const { jobLine, jobTitle } = await import('./job-view');
const { fetchProgress } = await import('./net-fetch');
const { latestFor } = await import('@/lib/remote-requests');

const NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const later = new Date(NOW.getTime() + 24 * 3600_000);
type Tr = typeof transfers.$inferInsert;
const tr = (id: string, o: Partial<Tr>): Tr => ({ id, orgId: 'o1', deviceId: 'b1', createdByUserId: 'u1', path: id, sizeBytes: 1000, crc32: 0,
  blobSha256: 'a'.repeat(64), expiresAt: later, status: 'queued', createdAt: ago(10_000), ...o });
type Rq = typeof remoteRequests.$inferInsert;
const rq = (id: string, o: Partial<Rq>): Rq => ({ id, orgId: 'o1', deviceId: 'b1', kind: 'get', amigaPath: `Work:${id}`, status: 'waiting', createdAt: ago(10_000), ...o });
const target = (o: Record<string, unknown> = {}) => ({ dest: 'STASH:/In', rel: ['x'], replace: false, library: null, ...o });
const up = (id: string, size: number, received: number, status = 'receiving', source = 'copy') => ({ id, orgId: 'o1', deviceId: 'b1', path: id,
  sizeBytes: size, receivedBytes: received, amigaDate: '1.2.3', status, source, expiresAt: later });
const jobs = () => listJobs(getDb(), 'o1', NOW);

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
  await getDb().update(devices).set({ lastSeenAt: NOW });
});
afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

describe('listJobs: Files jobs', () => {
  it('a copy onto a volume: its bytes, the drawer it goes into, the file moving now', async () => {
    await getDb().insert(transfers).values([
      tr('r1', { jobId: 'j1', status: 'delivered', finishedAt: ago(5_000), amigaDest: 'Work:Tools/Pack/a' }),
      tr('r2', { jobId: 'j1', status: 'sending', sizeBytes: 3000, bytesSent: 1000, amigaDest: 'Work:Tools/Pack/b', createdAt: ago(9_999) }),
      tr('r3', { jobId: 'j1', sizeBytes: 2000, amigaDest: 'Work:Tools/Pack/c', createdAt: ago(9_998) }),
    ]);
    expect(await jobs()).toEqual([expect.objectContaining({ id: 'j1', kind: 'copy', direction: 'to', board: 'A500', from: null, place: 'Work:Tools/Pack',
      total: 3, done: 1, waiting: 2, failed: [], cancelled: 0, cancel: null, bytes: { total: 6000, done: 2000 }, current: 'Work:Tools/Pack/b',
      running: true, startedAt: ago(10_000).toISOString(), finishedAt: null, offline: null })]);
  });

  it('a move onto a volume is a move', async () => {
    await getDb().insert(transfers).values([tr('r1', { jobId: 'j1', amigaDest: 'Work:a', moveSource: 'STASH:/a', moveItem: 'a' })]);
    expect((await jobs())[0]).toMatchObject({ kind: 'move' });
  });

  it('a copy off a volume: bytes from each get\'s size and the arriving upload', async () => {
    await getDb().insert(amigaUploads).values([up('u1', 500, 500, 'stored'), up('u2', 800, 200)]);
    await getDb().insert(remoteRequests).values([
      rq('g1', { fetchId: 'j2', status: 'done', uploadId: 'u1', answeredAt: ago(3_000), target: target({ rel: ['a'], size: 500 }) }),
      rq('g2', { fetchId: 'j2', status: 'fetching', uploadId: 'u2', amigaPath: 'Work:b', target: target({ rel: ['b'], size: 800 }) }),
      rq('g3', { fetchId: 'j2', target: target({ rel: ['c'], size: 100 }) }),
    ]);
    expect((await jobs())[0]).toMatchObject({ id: 'j2', kind: 'copy', direction: 'from', board: 'A500', place: 'STASH:/In', total: 3, done: 1,
      waiting: 2, bytes: { total: 1400, done: 700 }, current: 'Work:b', running: true });
  });

  it('a copy onto LIBRARY: says LIBRARY:', async () => {
    await getDb().insert(remoteRequests).values([rq('g1', { fetchId: 'j2', target: target({ dest: 'STASH:', library: { collectionId: null }, size: 9 }) })]);
    expect((await jobs())[0]).toMatchObject({ direction: 'from', place: 'LIBRARY:' });
  });

  it('between volumes: the destination board, the source board, each file once (half up, half down)', async () => {
    await getDb().insert(amigaUploads).values([up('u3', 1000, 600, 'receiving', 'staging')]);
    const relay = (dest: string) => ({ deviceId: 'b2', dest, onClash: 'keep' });
    await getDb().insert(remoteRequests).values([
      rq('gA', { fetchId: 'j3', status: 'done', amigaPath: 'Work:Pack/x', answeredAt: ago(4_000), target: target({ dest: 'STASH:', size: 1000, relay: relay('Data:Pack/x') }) }),
      rq('gB', { fetchId: 'j3', status: 'fetching', amigaPath: 'Work:Pack/y', uploadId: 'u3', target: target({ dest: 'STASH:', size: 1000, relay: relay('Data:Pack/y') }) }),
    ]);
    await getDb().insert(transfers).values([tr('rA', { jobId: 'j3', deviceId: 'b2', status: 'sending', bytesSent: 400, amigaDest: 'Data:Pack/x' })]);
    expect((await jobs())[0]).toMatchObject({ id: 'j3', kind: 'copy', direction: 'to', board: 'A1200', from: 'A500', place: 'Data:Pack',
      bytes: { total: 2000, done: 1000 }, current: 'Data:Pack/x', running: true });
  });

  it('a drawer delete is a write job: by items, its kind named', async () => {
    await getDb().insert(remoteRequests).values([
      rq('w1', { fetchId: 'j4', kind: 'delete', amigaPath: 'Work:Old', target: { label: 'Work:Old' } }),
      rq('w2', { fetchId: 'j4', kind: 'delete', amigaPath: 'Work:Old.info', target: { label: 'Work:Old.info', icon: true }, createdAt: ago(9_999) }),
    ]);
    const [j] = await jobs();
    expect(j).toMatchObject({ id: 'j4', kind: 'write', writeKind: 'delete', place: null, bytes: null, total: 0, running: true });
    expect(j.writes.map((w) => [w.label, w.status, w.quiet])).toEqual([['Work:Old', 'waiting', false], ['Work:Old.info', 'waiting', true]]);
  });

  it('M-3: a copy of nothing but drawers says where they go, and counts them', async () => {
    await getDb().insert(remoteRequests).values([
      rq('e1', { fetchId: 'j9', kind: 'mkdir', amigaPath: 'Work:Monkey/Disk 1', target: { label: 'Work:Monkey/Disk 1', ensure: true } }),
      rq('e2', { fetchId: 'j9', kind: 'mkdir', amigaPath: 'Work:Monkey/Disk 1/Empty', target: { label: 'Work:Monkey/Disk 1/Empty', ensure: true }, status: 'done', answeredAt: ago(1000), createdAt: ago(9_999) }),
      rq('e3', { fetchId: 'j9', kind: 'mkdir', amigaPath: 'Work:Monkey/Disk 2', target: { label: 'Work:Monkey/Disk 2', ensure: true }, createdAt: ago(9_998) }),
    ]);
    const [j] = await jobs();
    expect(j).toMatchObject({ id: 'j9', kind: 'write', place: 'Work:Monkey', total: 0, running: true });
    expect(jobTitle(j)).toBe('Changing the disks of A500 · Work:Monkey');
    expect(jobLine(j, null)).toBe('1 of 3 items');
  });

  it('M-3: a Makedir of the person\'s own names itself, with no place beside it', async () => {
    await getDb().insert(remoteRequests).values([rq('e1', { fetchId: 'j9', kind: 'mkdir', amigaPath: 'Work:New', target: { label: 'Work:New' } })]);
    const [j] = await jobs();
    expect(j).toMatchObject({ place: null });
    expect(jobTitle(j)).toBe('Making Work:New on A500');
  });

  it('M-4: a failed file of several drawers is said by its path below the job\'s place', async () => {
    const failed = { jobId: 'j8', status: 'failed', errorCode: 'full', finishedAt: ago(1000) };
    await getDb().insert(transfers).values([
      tr('r1', { ...failed, path: 'Disk.info', amigaDest: 'Work:Monkey/Disk 1/Disk.info' }),
      tr('r2', { ...failed, path: 'Disk.info', amigaDest: 'Work:Monkey/Disk 2/Disk.info' }),
      tr('r3', { ...failed, path: 'x', amigaDest: 'WORK:monkey/Disk 2/C/x' }),
    ]);
    const [j] = await jobs();
    expect(j.place).toBe('Work:Monkey');
    expect(j.failed.map((f) => f.name)).toEqual(['Disk 1/Disk.info', 'Disk 2/Disk.info', 'Disk 2/C/x']);
  });

  it('M-4: one failed file keeps its own name, in a drawer or at a volume\'s root; a plain send too', async () => {
    const failed = { jobId: 'j8', status: 'failed', errorCode: 'full', finishedAt: ago(1000) };
    await getDb().insert(transfers).values([tr('r1', { ...failed, path: 'a.txt', amigaDest: 'Work:Tools/Deep/a.txt' })]);
    expect((await jobs())[0].failed.map((f) => f.name)).toEqual(['a.txt']);
    await getDb().delete(transfers);
    await getDb().insert(transfers).values([tr('r2', { ...failed, path: 'b.txt', amigaDest: 'Work:b.txt' })]);
    expect((await jobs())[0].failed.map((f) => f.name)).toEqual(['b.txt']);
    await getDb().delete(transfers);
    await getDb().insert(transfers).values([tr('r3', { ...failed, path: 'dir/c.txt', amigaDest: null })]);
    expect((await jobs())[0].failed.map((f) => f.name)).toEqual(['dir/c.txt']);
  });

  it('finished within 2 minutes stays, with its finish time; older is gone', async () => {
    await getDb().insert(transfers).values([
      tr('r5', { jobId: 'j5', status: 'delivered', finishedAt: ago(90_000), amigaDest: 'Work:a', createdAt: ago(100_000) }),
      tr('r6', { jobId: 'j6', status: 'delivered', finishedAt: ago(150_000), amigaDest: 'Work:b', createdAt: ago(160_000) }),
    ]);
    const list = await jobs();
    expect(list.map((j) => j.id)).toEqual(['j5']);
    expect(list[0]).toMatchObject({ running: false, done: 1, finishedAt: ago(90_000).toISOString(), current: null });
  });

  it('jobView: a copy off a volume finished long ago, which the list let go, with what arrived', async () => {
    await getDb().insert(amigaUploads).values([up('u1', 500, 500, 'stored')]);
    await getDb().insert(remoteRequests).values([
      rq('g1', { fetchId: 'j7', status: 'done', uploadId: 'u1', answeredAt: ago(600_000), createdAt: ago(610_000), target: target({ rel: ['a'], size: 500 }) }),
    ]);
    expect((await jobs()).map((j) => j.id)).toEqual([]);
    expect(await jobView(getDb(), 'o1', 'j7', NOW)).toMatchObject({ id: 'j7', running: false, done: 1, direction: 'from', arrived: ['STASH:/u1'] });
    expect(await jobView(getDb(), 'o2', 'j7', NOW)).toBeNull();
  });

  it('a job whose card cannot be worked out is left out; the others still show', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await getDb().insert(transfers).values([tr('r1', { jobId: 'j1', amigaDest: 'Work:a' })]);
    // A get with no target: fetchProgress cannot read it (it throws).
    await getDb().insert(remoteRequests).values([rq('g1', { fetchId: 'jbad', status: 'sent', target: null })]);
    expect((await jobs()).map((j) => j.id)).toEqual(['j1']);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('a part cancelled is counted apart from the failures', async () => {
    await getDb().insert(transfers).values([
      tr('r1', { jobId: 'j1', status: 'delivered', finishedAt: ago(5_000), amigaDest: 'Work:a' }),
      tr('r2', { jobId: 'j1', status: 'cancelled', finishedAt: ago(4_000), amigaDest: 'Work:b' }),
      tr('r3', { jobId: 'j1', status: 'failed', errorCode: 'space', finishedAt: ago(4_000), amigaDest: 'Work:c' }),
    ]);
    const [j] = await jobs();
    expect(j).toMatchObject({ cancelled: 1, running: false });
    expect(j.failed.map((f) => f.name)).toEqual(['c']);   // by its destination below the job's place (M-4)
  });

  it('a board it waits on that is offline is named', async () => {
    await getDb().update(devices).set({ lastSeenAt: ago(5 * 60_000) }).where(eq(devices.id, 'b2'));
    await getDb().insert(transfers).values([tr('r8', { jobId: 'j8', deviceId: 'b2', amigaDest: 'Data:a' })]);
    expect((await jobs())[0]).toMatchObject({ id: 'j8', offline: 'A1200', running: true });
  });

  it('I-1: rows past 24 h: not running, said as expired, finished when they lapsed, and no board named offline', async () => {
    await getDb().update(devices).set({ lastSeenAt: ago(3600_000) }).where(eq(devices.id, 'b1'));
    await getDb().insert(transfers).values([
      tr('l1', { jobId: 'jl', amigaDest: 'Work:Pack/a', expiresAt: ago(30_000), createdAt: ago(90_000) }),
      tr('l2', { jobId: 'jl', amigaDest: 'Work:Pack/b', status: 'sending', bytesSent: 200, expiresAt: ago(20_000), createdAt: ago(89_000) }),
    ]);
    const [j] = await jobs();
    expect(j).toMatchObject({ id: 'jl', running: false, waiting: 0, total: 2, current: null, offline: null,
      finishedAt: ago(20_000).toISOString(), bytes: { total: 2000, done: 2000 } });
    expect(j.failed.map((f) => f.reason)).toEqual(['A500 did not take it within 24 h', 'A500 did not take it within 24 h']);
    // The same through the job's own route (fetchProgress).
    expect(await fetchProgress(getDb(), 'o1', 'jl', NOW)).toMatchObject({ waiting: 0, offline: null, failed: [{ name: 'a' }, { name: 'b' }] });
  });
  it('I-1: a row not past its expiry still runs; lapsed more than 2 minutes ago it is off the list', async () => {
    await getDb().insert(transfers).values([
      tr('r1', { jobId: 'live', amigaDest: 'Work:a', expiresAt: new Date(NOW.getTime() + 1000) }),
      tr('r2', { jobId: 'gone', amigaDest: 'Work:b', expiresAt: ago(150_000), createdAt: ago(200_000) }),
    ]);
    expect((await jobs()).map((j) => [j.id, j.running])).toEqual([['live', true]]);
  });
  it('I-1: a move with one row lapsed ends too: its delivered rows wait for no removal the lapsed row holds up', async () => {
    await getDb().insert(transfers).values([
      tr('m1', { jobId: 'jm', amigaDest: 'Work:a', status: 'delivered', moveSource: 'STASH:/Pack', moveItem: 'Pack/a', finishedAt: ago(60_000) }),
      tr('m2', { jobId: 'jm', amigaDest: 'Work:b', moveSource: 'STASH:/Pack', moveItem: 'Pack/b', expiresAt: ago(30_000) }),
    ]);
    const [j] = await jobs();
    expect(j).toMatchObject({ id: 'jm', running: false, waiting: 0, done: 1, finishedAt: ago(30_000).toISOString() });
    expect(j.failed).toHaveLength(1);
  });
  it('I-2: one look reads each table\'s rows of the job once, by named columns (the other reads are the move settle\'s, one value each)', async () => {
    await getDb().insert(transfers).values(tr('c1', { jobId: 'jc', amigaDest: 'Work:a' }));
    await getDb().insert(remoteRequests).values(rq('c2', { fetchId: 'jc', target: target() }));
    const db = getDb();
    const reads: { table: string; named: boolean }[] = [];
    const select = db.select.bind(db) as (f?: unknown) => { from(t: unknown): unknown };
    const spy = vi.spyOn(db, 'select').mockImplementation(((fields?: unknown) => {
      const b = select(fields);
      const from = b.from.bind(b);
      b.from = (t: unknown) => { reads.push({ table: getTableName(t as typeof transfers), named: fields !== undefined }); return from(t); };
      return b;
    }) as never);
    try { expect(await jobView(db, 'o1', 'jc', NOW)).toMatchObject({ id: 'jc' }); } finally { spy.mockRestore(); }
    const of = (table: string) => reads.filter((r) => r.table === table);
    expect(of('transfers')).toHaveLength(2);         // settleMovesOfJob's markers, then the job's rows
    expect(of('remote_requests')).toHaveLength(2);
    expect(reads.filter((r) => !r.named)).toEqual([]);
  });
  it('M-2: with no job, no expiry runs; a stale listing is expired by the pane that looks (latestFor)', async () => {
    await getDb().insert(remoteRequests).values(rq('s1', { kind: 'dir', status: 'sent', sentAt: ago(120_000), createdAt: ago(120_000), amigaPath: 'Work:' }));
    expect(await jobs()).toEqual([]);
    const status = async () => (await getDb().select({ s: remoteRequests.status }).from(remoteRequests).where(eq(remoteRequests.id, 's1')))[0].s;
    expect(await status()).toBe('sent');
    await latestFor(getDb(), 'b1', 'dir', 'Work:', NOW);
    expect(await status()).toBe('failed');
  });
  it('M-2: a job that only needs expiry still gets it from the listing', async () => {
    await getDb().insert(remoteRequests).values(rq('s2', { fetchId: 'js', status: 'fetching', target: target({ rel: ['a.lha'] }), activeAt: ago(700_000), sentAt: ago(700_000), createdAt: ago(700_000) }));
    const [j] = await jobs();
    expect(j).toMatchObject({ id: 'js', running: false, failed: [{ name: 'a.lha', reason: 'A500 stopped answering' }] });
  });

  it('newest first', async () => {
    await getDb().insert(transfers).values([
      tr('r9', { jobId: 'j9', amigaDest: 'Work:a', createdAt: ago(5_000) }),
      tr('r10', { jobId: 'j10', amigaDest: 'Work:b', createdAt: ago(8_000) }),
    ]);
    expect((await jobs()).map((j) => j.id)).toEqual(['j9', 'j10']);
  });

  it('another org\'s jobs never show', async () => {
    await getDb().insert(transfers).values([tr('r7', { jobId: 'j7', orgId: 'o2', deviceId: 'b3', amigaDest: 'Work:a' }), tr('q1', { orgId: 'o2', deviceId: 'b3' })]);
    expect(await jobs()).toEqual([]);
    expect((await listJobs(getDb(), 'o2', NOW)).map((j) => j.kind).sort()).toEqual(['copy', 'send']);
  });
});

describe('listJobs: plain Queue sends', () => {
  it('one job per board: what waits or moves and what finished since it began', async () => {
    await getDb().insert(transfers).values([
      tr('q-old', { status: 'delivered', createdAt: ago(900_000), finishedAt: ago(600_000) }),
      tr('q-a', { status: 'delivered', createdAt: ago(20_000), finishedAt: ago(5_000) }),
      tr('q-b', { status: 'sending', bytesSent: 400, createdAt: ago(19_999) }),
      tr('q-c', { createdAt: ago(19_998) }),
    ]);
    expect(await jobs()).toEqual([expect.objectContaining({ id: `queue:b1:${ago(19_998).getTime()}`, kind: 'send', direction: 'to', board: 'A500',
      place: null, total: 3, done: 1, waiting: 2, bytes: { total: 3000, done: 1400 }, current: 'q-b', running: true,
      startedAt: ago(20_000).toISOString() })]);
  });

  it('once through it stays 2 minutes with its failures', async () => {
    await getDb().insert(transfers).values([
      tr('q-a', { status: 'delivered', createdAt: ago(20_000), finishedAt: ago(10_000) }),
      tr('q-b', { status: 'failed', errorCode: 'norx', createdAt: ago(19_999), finishedAt: ago(5_000) }),
    ]);
    const [j] = await jobs();
    expect(j).toMatchObject({ kind: 'send', running: false, total: 2, done: 1, finishedAt: ago(5_000).toISOString() });
    expect(j.failed).toHaveLength(1);
    expect(j.failed[0].name).toBe('q-b');
  });
});
