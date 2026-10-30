// src/lib/files/net-driver.db.test.ts
// NET: (increment 3, Task 1): boards and their queues (since NET: volumes, spec 2026-10-30, under NET:/<board>/Queue); a copy into NET:/<board> sends, all or nothing; Delete cancels a
// waiting row and clears a finished one; nothing is copied or moved out of NET:, and nothing is moved into it.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Client } from 'pg';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_files_net_test';
const url = new URL(base); url.pathname = `/${DB}`; process.env.DATABASE_URL = url.toString();
process.env.STORAGE_DIR ??= (await import('node:fs')).mkdtempSync('/tmp/webadf-files-net-');
process.env.BLOB_READ_WRITE_TOKEN = '';
async function admin(stmt: string) { const c = new Client({ connectionString: base }); await c.connect(); try { await c.query(stmt); } finally { await c.end(); } }

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { and, eq, inArray } = await import('drizzle-orm');
const { createHash } = await import('node:crypto');
const { crc32 } = await import('node:zlib');
const { games, disks, entitlements, blobs } = await import('@/db/schema/catalog');
const { organization } = await import('@/db/schema/auth');
const { devices } = await import('@/db/schema/devices');
const { transfers } = await import('@/db/schema/transfers');
const { diskStore } = await import('@/lib/storage');
const { formatVolume } = await import('@/lib/adffs/format');
const { addFile, makeDirectory } = await import('@/lib/adffs/write');
const { ROOT_BLOCK } = await import('@/lib/adffs/constants');
const { readVolume } = await import('@/lib/adffs');
const { protectionString } = await import('@/lib/adffs/dir');
const { parsePath } = await import('./path');
const { insertStash, listStash } = await import('@/lib/stash');
const { runOp } = await import('./ops');
const { netDriver } = await import('./net-driver');
const { Pending, Refused } = await import('./driver');
const { remoteRequests } = await import('@/db/schema/remote-requests');
const { takeWaiting, answerPiece } = await import('@/lib/remote-requests');

const ctx = { orgId: 'o1', userId: 'u1' };
const P = (s: string) => parsePath(s)!;
const enc = (s: string) => new TextEncoder().encode(s);
const must = (r: { ok: true; adf: Uint8Array } | { ok: false; reason: string }) => { if (!r.ok) throw new Error(r.reason); return r.adf; };
const queued = async (deviceId = 'b1') => getDb().select().from(transfers).where(eq(transfers.deviceId, deviceId));
const waiting = async () => (await queued()).filter((x) => x.status === 'queued');
const version = async (id: string) => (await getDb().select({ v: devices.sendVersion }).from(devices).where(eq(devices.id, id)))[0].v;
const MB = 1024 * 1024;

async function put(bytes: Uint8Array) { const s = createHash('sha256').update(bytes).digest('hex'); await diskStore.put(s, bytes); return s; }
async function stash(path: string, bytes: Uint8Array) {
  const r = await insertStash(getDb(), 'o1', 'browser', [{ path, kind: 'file', sha256: await put(bytes), sizeBytes: bytes.length,
    date: new Date(Date.UTC(2020, 0, 2)), protection: 0, comment: '' }]);
  if (!r.ok) throw new Error(r.code);
}
/** Empties b1's queue between tests that count it. */
async function emptyQueue() { await getDb().delete(transfers).where(eq(transfers.deviceId, 'b1')); }

beforeAll(async () => {
  await admin(`drop database if exists ${DB} with (force)`);
  await admin(`create database ${DB}`);
  await migrate(getDb(), { migrationsFolder: 'drizzle' });
  const db = getDb();
  await db.insert(organization).values([{ id: 'o1', name: 'o1', slug: 'o1', createdAt: new Date() }, { id: 'o2', name: 'o2', slug: 'o2', createdAt: new Date() }]);
  const now = new Date();
  await db.insert(devices).values([
    // b1 can be browsed (spec 2026-10-30 §4.4): firmware 1.22, Transfer running on protocol 3 with browsing on.
    { id: 'b1', orgId: 'o1', name: 'A500 bench', tokenHash: 'h1', firmwareVersion: '1.22.0+gabc', lastSeenAt: now, upKey: 'ab12',
      sendRx: 'c', sendRxAt: now, rxProto: 3, browseOn: true },
    { id: 'b2', orgId: 'o1', name: 'Zed', tokenHash: 'h2', firmwareVersion: '1.16.0+gdef', lastSeenAt: new Date(now.getTime() - 3 * 3600_000) },
    { id: 'b0', orgId: 'o1', name: 'Old', tokenHash: 'h0', firmwareVersion: '1.14.0+g000', lastSeenAt: now },
    { id: 'bx', orgId: 'o2', name: 'Theirs', tokenHash: 'hx', firmwareVersion: '1.15.0+g111', lastSeenAt: now },
  ]);

  let adf = formatVolume({ filesystem: 'FFS', volumeName: 'SysInfo' });
  adf = must(makeDirectory(adf, ROOT_BLOCK, 'C'));
  const cBlock = (readVolume(adf) as { ok: true; root: { name: string; block: number }[] }).root.find((e) => e.name === 'C')!.block;
  adf = must(addFile(adf, cBlock, 'Assign', enc('assign!'), 0x05, { comment: 'cmd', date: new Date('1993-05-17T12:34:56Z') }));
  adf = must(makeDirectory(adf, ROOT_BLOCK, 'S'));
  const sIdx = (readVolume(adf) as { ok: true; root: { name: string; block: number }[] }).root.find((e) => e.name === 'S')!.block;
  adf = must(addFile(adf, sIdx, 'Startup-Sequence', enc('echo hi'), 0));
  const s = await put(adf);
  await db.insert(blobs).values({ sha256: s, sizeBytes: adf.length, storageKey: `adf/${s}` });
  await db.insert(entitlements).values({ orgId: 'o1', sha256: s, sourceFilename: 'SysInfo.adf' });
  await db.insert(games).values({ id: 'g1', orgId: 'o1', title: 'SysInfo', sortTitle: 'sysinfo' });
  await db.insert(disks).values({ id: 'd1', gameId: 'g1', orgId: 'o1', diskNo: 1, sha256: s, sizeBytes: adf.length });

  // d2: a disk whose Lots folder holds 40 files, more than any board's queue takes; Few holds 3.
  let lots = formatVolume({ filesystem: 'FFS', volumeName: 'Lots' });
  for (const dir of ['Lots', 'Few']) lots = must(makeDirectory(lots, ROOT_BLOCK, dir));
  const blockOf = (name: string) => (readVolume(lots) as { ok: true; root: { name: string; block: number }[] }).root.find((e) => e.name === name)!.block;
  for (let i = 0; i < 40; i++) lots = must(addFile(lots, blockOf('Lots'), `L${i}`, enc(`lots ${i}`), 0));
  for (let i = 0; i < 3; i++) lots = must(addFile(lots, blockOf('Few'), `F${i}`, enc(`few ${i}`), 0));
  const s2 = await put(lots);
  await db.insert(blobs).values({ sha256: s2, sizeBytes: lots.length, storageKey: `adf/${s2}` });
  await db.insert(entitlements).values({ orgId: 'o1', sha256: s2, sourceFilename: 'Lots.adf' });
  await db.insert(disks).values({ id: 'd2', gameId: 'g1', orgId: 'o1', diskNo: 2, sha256: s2, sizeBytes: lots.length });

  const big = new Uint8Array(4 * MB + 1); big[0] = 1;
  await stash('Big.bin', big);
  for (let i = 0; i < 33; i++) await stash(`Many/f${i}.txt`, enc(String.fromCharCode(65 + (i % 26)) + i));
  await stash('Two/a.txt', enc('aaa'));
  await stash('Two/Sub/b.txt', enc('bb'));
  await stash('Empty.txt', new Uint8Array(0));
});
afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

describe('NET: listing', () => {
  it('lists the boards that can receive, online first, with their marks; it takes no copies itself', async () => {
    const l = (await netDriver.list(ctx, P('NET:')))!;
    expect(l.entries.map((e) => [e.kind, e.name, e.path])).toEqual([['board', 'A500 bench', 'NET:/b1'], ['board', 'Zed', 'NET:/b2']]);
    expect(l.entries[0].marks).toEqual(['online', 'Transfer running', 'key AB12']);
    expect(l.entries[1].marks).toEqual(['offline 3 h']);
    expect(l.writable).toBe(false);
    expect(l.readOnlyReason).toBe('Open a board to send files to it');
    expect(l.meta).toBe('2 boards');
    expect(l.crumbs).toEqual([{ label: 'NET:', path: 'NET:' }]);
  });
  it('a board below 1.15.0 is not listed and not found; another org\'s board is not found; nor is a path below a queue row', async () => {
    expect(await netDriver.list(ctx, P('NET:/b0'))).toBeNull();
    expect(await netDriver.list(ctx, P('NET:/bx'))).toBeNull();
    expect(await netDriver.list(ctx, P('NET:/nope'))).toBeNull();
    expect(await netDriver.list(ctx, P('NET:/b1/Queue/x'))).toBeNull();
    expect(await netDriver.list(ctx, P('NET:/bx/Queue'))).toBeNull();
    expect(await netDriver.list(ctx, P('NET:/bx/Work'))).toBeNull();
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/C'], dest: 'NET:/b0', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', status: 404, refusal: { code: 'not_found' } });
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/C'], dest: 'NET:/bx', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', status: 404 });
    expect(await queued('b0')).toEqual([]);
    expect(await queued('bx')).toEqual([]);
  });
  it('an empty board queue says so', async () => {
    const l = (await netDriver.list(ctx, P('NET:/b2/Queue')))!;
    expect(l).toMatchObject({ path: 'NET:/b2/Queue', entries: [], writable: true, readOnlyReason: null, disk: null,
      queue: { deviceId: 'b2', files: 0, bytes: 0 }, meta: '0 waiting · 0.0 of 16 MB' });
    expect(l.crumbs).toEqual([{ label: 'NET:', path: 'NET:' }, { label: 'Zed', path: 'NET:/b2' }, { label: 'Queue', path: 'NET:/b2/Queue' }]);
  });
});

describe('copy into NET:', () => {
  it('queues a disk folder with paths, protection and comment, says how many it queued, and lists it with its state', async () => {
    const v = await version('b1');
    const r = await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/C'], dest: 'NET:/b1/Queue', onClash: 'ask' });
    expect(r).toMatchObject({ kind: 'done', items: [{ source: 'LIBRARY:/g1/d1/C', ok: true }], queued: 1 });
    const rows = await queued();
    expect(rows.map((x) => [x.path, x.protection, x.comment, x.status, x.sizeBytes, x.createdByUserId])).toEqual([['C/Assign', 5, 'cmd', 'queued', 7, 'u1']]);
    expect(rows[0].crc32).toBe(crc32(enc('assign!')) >>> 0);
    expect(await version('b1')).toBe(v + 1);
    const l = (await netDriver.list(ctx, P('NET:/b1/Queue')))!;
    expect(l.entries[0]).toMatchObject({ name: 'C/Assign', kind: 'file', path: `NET:/b1/Queue/${rows[0].id}`, size: 7, comment: 'cmd',
      protection: protectionString(5), date: rows[0].createdAt.toISOString(), marks: ['Waiting'] });
    expect(l.queue).toEqual({ deviceId: 'b1', files: 1, bytes: 7 });
    expect(l.meta).toBe('1 waiting · 0.0 of 16 MB');
    expect((await netDriver.list(ctx, P('NET:')))!.entries[0].marks).toEqual(['online', 'Transfer running', '1 waiting', 'key AB12']);
  });
  it('queues STASH: folders as relative paths, every file of every source in one go, and bumps the cursor once', async () => {
    await emptyQueue();
    const v = await version('b1');
    const r = await runOp(ctx, { op: 'copy', sources: ['STASH:/Two', 'LIBRARY:/g1/d1/S'], dest: 'NET:/b1', onClash: 'ask' });
    expect(r).toMatchObject({ kind: 'done', items: [{ source: 'STASH:/Two', ok: true }, { source: 'LIBRARY:/g1/d1/S', ok: true }], queued: 3 });
    expect((await queued()).map((x) => x.path).sort()).toEqual(['S/Startup-Sequence', 'Two/Sub/b.txt', 'Two/a.txt']);
    expect(await version('b1')).toBe(v + 1);
    // The board takes them in the order the copy named them (oldest first): listTransfers shows that newest first.
    // (The copy above went to the old NET:/<board> form, which still queues.)
    expect((await netDriver.list(ctx, P('NET:/b1/Queue')))!.entries.map((e) => e.name)).toEqual(['S/Startup-Sequence', 'Two/Sub/b.txt', 'Two/a.txt']);
  });
  it('a folder over the queue limit queues nothing', async () => {
    const before = (await queued()).length;
    const v = await version('b1');
    expect(await runOp(ctx, { op: 'copy', sources: ['STASH:/Many'], dest: 'NET:/b1', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', status: 409, refusal: { code: 'queue_full' } });
    expect((await queued()).length).toBe(before);
    expect(await version('b1')).toBe(v);
  });
  it('a disk folder of 40 files is refused before a single byte is stored', async () => {
    const before = (await queued()).length;
    const spy = vi.spyOn(diskStore, 'put');
    try {
      expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d2/Lots'], dest: 'NET:/b1', onClash: 'ask' }))
        .toMatchObject({ kind: 'refused', status: 409, refusal: { code: 'queue_full' } });
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
    expect((await queued()).length).toBe(before);
  });
  it("a copy that fits alone but not beside what the board already holds is refused before a byte is stored", async () => {
    const before = (await queued()).filter((x) => x.status === 'queued').length;
    const fill = Array.from({ length: 30 - before }, (_, i) => ({ id: `fill${i}`, orgId: 'o1', deviceId: 'b1', createdByUserId: 'u1', path: `fill${i}`,
      sizeBytes: 1, crc32: 0, protection: 0, comment: '', blobSha256: 'f'.repeat(64), expiresAt: new Date(Date.now() + 3600_000) }));
    await getDb().insert(transfers).values(fill);
    const spy = vi.spyOn(diskStore, 'put');
    try {
      expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d2/Few'], dest: 'NET:/b1', onClash: 'ask' }))
        .toMatchObject({ kind: 'refused', status: 409, refusal: { code: 'queue_full' } });
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); await getDb().delete(transfers).where(inArray(transfers.id, fill.map((f) => f.id))); }
  });
  it('a file over 4 MB refuses the whole copy, naming it', async () => {
    const before = (await queued()).length;
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/S', 'STASH:/Big.bin'], dest: 'NET:/b1', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', status: 413, refusal: { code: 'too_large', detail: 'Big.bin is over 4 MB' } });
    expect((await queued()).length).toBe(before);
  });
  it('an empty file refuses the whole copy, naming it (P7)', async () => {
    const before = (await queued()).length;
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/S', 'STASH:/Empty.txt'], dest: 'NET:/b1', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', status: 400, refusal: { code: 'unsupported', detail: 'Empty.txt is empty' } });
    expect((await queued()).length).toBe(before);
  });
  it('a board offline still takes a copy (it queues)', async () => {
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/C/Assign'], dest: 'NET:/b2', onClash: 'ask' }))
      .toMatchObject({ kind: 'done', queued: 1 });
    expect((await queued('b2')).map((x) => x.path)).toEqual(['Assign']);
  });
  it('refuses a folder inside the queue, a volume, a signed-out copy, and copying or moving out of NET:', async () => {
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/C'], dest: 'NET:/b1/Queue/x', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', status: 400, refusal: { code: 'unsupported' } });
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/C'], dest: 'NET:/b1/Work', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', status: 409, refusal: { code: 'read_only', detail: 'Read-only for now' } });
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/C'], dest: 'NET:', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', status: 400, refusal: { code: 'unsupported' } });
    expect(await runOp({ orgId: 'o1', userId: null }, { op: 'copy', sources: ['LIBRARY:/g1/d1/C'], dest: 'NET:/b1', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', status: 400, refusal: { code: 'unsupported' } });
    const [row] = await queued();
    const out = { code: 'unsupported', detail: 'Files waiting for the Amiga cannot be copied out' };
    expect(await runOp(ctx, { op: 'copy', sources: [`NET:/b1/${row.id}`], dest: 'STASH:', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', status: 400, refusal: out });
    expect(await runOp(ctx, { op: 'move', sources: [`NET:/b1/${row.id}`], dest: 'STASH:', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', status: 400, refusal: out });
    expect(await runOp(ctx, { op: 'copy', sources: [`NET:/b1/${row.id}`], dest: 'NET:/b2', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', status: 400, refusal: out });
    expect(await netDriver.read(ctx, P(`NET:/b1/${row.id}`))).toBeNull();
    await expect(netDriver.mustRemove!(ctx, [`NET:/b1/${row.id}`])).rejects.toMatchObject({ refusal: out });
  });
  it('C16: a move into NET: is refused with words, and leaves the source and the queue as they were', async () => {
    const before = (await queued()).length;
    expect(await runOp(ctx, { op: 'move', sources: ['STASH:/Two/a.txt'], dest: 'NET:/b1', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', status: 400, refusal: { code: 'unsupported', detail: 'Files sent to the Amiga stay where they are — use Copy' } });
    expect((await queued()).length).toBe(before);
    expect((await listStash(getDb(), 'o1')).some((x) => x.path === 'Two/a.txt')).toBe(true);
  });
});

describe('delete in NET:', () => {
  it('cancels a waiting row', async () => {
    const [row] = await waiting();
    const v = await version('b1');
    expect(await runOp(ctx, { op: 'delete', sources: [`NET:/b1/Queue/${row.id}`] })).toMatchObject({ kind: 'done', items: [{ ok: true }] });
    expect((await queued()).find((x) => x.id === row.id)!.status).toBe('cancelled');
    expect(await version('b1')).toBe(v + 1);
  });
  it('clears a finished row, by the old NET:/<board>/<id> path an open tab may still hold', async () => {
    const [row] = (await queued()).filter((x) => x.status === 'cancelled');
    expect(await runOp(ctx, { op: 'delete', sources: [`NET:/b1/${row.id}`] })).toMatchObject({ kind: 'done', items: [{ ok: true }] });
    expect((await queued()).find((x) => x.id === row.id)).toBeUndefined();
  });
  it('delete on a row that finished meanwhile clears it', async () => {
    await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/C/Assign'], dest: 'NET:/b1', onClash: 'ask' });
    const row = (await waiting()).find((x) => x.path === 'Assign')!;
    await getDb().update(transfers).set({ status: 'delivered', savedAs: 'Assign', finishedAt: new Date() }).where(eq(transfers.id, row.id));
    expect(await runOp(ctx, { op: 'delete', sources: [`NET:/b1/${row.id}`] })).toMatchObject({ kind: 'done', items: [{ ok: true }] });
    expect((await queued()).find((x) => x.id === row.id)).toBeUndefined();
  });
  it('a waiting row past its expiry reads expired and is cleared, not cancelled (R4)', async () => {
    const [row] = await waiting();
    await getDb().update(transfers).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(transfers.id, row.id));
    const l = (await netDriver.list(ctx, P('NET:/b1/Queue')))!;
    expect(l.entries.find((e) => e.path.endsWith(row.id))!.marks).toEqual(['Expired · the Amiga did not take it within 24 h']);
    expect(await runOp(ctx, { op: 'delete', sources: [`NET:/b1/${row.id}`] })).toMatchObject({ kind: 'done', items: [{ ok: true }] });
    expect((await queued()).find((x) => x.id === row.id)).toBeUndefined();
  });
  it('a row that is not there, or is another board\'s, is not found per item (C5)', async () => {
    const [mine] = await waiting();
    const [b2row] = await queued('b2');
    const r = await runOp(ctx, { op: 'delete', sources: [`NET:/b1/Queue/${mine.id}`, 'NET:/b1/Queue/no-such-row', `NET:/b1/Queue/${b2row.id}`] });
    expect(r).toMatchObject({ kind: 'done', items: [
      { source: `NET:/b1/Queue/${mine.id}`, ok: true },
      { source: 'NET:/b1/Queue/no-such-row', ok: false, refusal: { code: 'not_found' } },
      { source: `NET:/b1/Queue/${b2row.id}`, ok: false, refusal: { code: 'not_found' } },
    ] });
    expect((await queued('b2')).find((x) => x.id === b2row.id)!.status).toBe('queued');
  });
  it('a board itself, its Queue folder and a volume are not deleted', async () => {
    expect(await runOp(ctx, { op: 'delete', sources: ['NET:/b1', 'NET:/b1/Queue', 'NET:/b1/Work/x'] }))
      .toMatchObject({ kind: 'done', items: [
        { source: 'NET:/b1', ok: false, refusal: { code: 'not_found' } },
        { source: 'NET:/b1/Queue', ok: false, refusal: { code: 'not_found' } },
        { source: 'NET:/b1/Work/x', ok: false, refusal: { code: 'not_found' } },
      ] });
  });
  it("another org's row is not found", async () => {
    await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/C/Assign'], dest: 'NET:/b1', onClash: 'ask' });
    const [row] = await waiting();
    expect(await runOp({ orgId: 'o2', userId: 'u2' }, { op: 'delete', sources: [`NET:/b1/Queue/${row.id}`] })).toMatchObject({ kind: 'refused', status: 404 });
    const [still] = await getDb().select().from(transfers).where(and(eq(transfers.id, row.id), eq(transfers.status, 'queued')));
    expect(still).toBeDefined();
  });
});

// NET: volumes (spec 2026-10-30 §4.3-4.6, §5): NET:/<board> lists the Amiga's volumes then Queue; a volume or drawer is
// read through a remote request the board answers (simulated here with takeWaiting + answerPiece).
describe('NET: volumes', () => {
  const NAME = 'A500 bench';
  const FREE = 40 * MB;
  /** The label of the Pending a listing throws, or null when it lists. */
  async function pendingOf(p: string, opts?: { fresh?: boolean }): Promise<string | null> {
    try { await netDriver.list(ctx, P(p), opts); } catch (e) { if (e instanceof Pending) return e.label; throw e; }
    return null;
  }
  /** The board takes what waits and answers the one request with `lines` (the rid filled in). */
  async function answer(lines: (rid: string) => string[]) {
    const [row] = await takeWaiting(getDb(), 'b1');
    expect(await answerPiece(getDb(), 'b1', row.id, { piece: 0, lines: lines(row.id), last: true })).toEqual({ ok: true });
    return row;
  }
  const rows = async (kind: string, amigaPath: string) => getDb().select().from(remoteRequests)
    .where(and(eq(remoteRequests.deviceId, 'b1'), eq(remoteRequests.kind, kind), eq(remoteRequests.amigaPath, amigaPath)));
  const refusalOf = async (p: string) => {
    try { await netDriver.list(ctx, P(p)); } catch (e) { if (e instanceof Refused) return { ...e.refusal, status: e.status }; throw e; }
    return null;
  };

  it('a board lists its volumes, in Transfer\'s order, then Queue; a volume named Queue carries its device', async () => {
    expect(await pendingOf('NET:/b1')).toBe(`Reading volumes from ${NAME}…`);
    expect((await rows('vols', '')).map((r) => r.status)).toEqual(['waiting']);
    await answer((rid) => [`VOL ${rid} 4:Work 4:DH1: ${200 * MB} ${FREE} 9000.0.0`, `VOL ${rid} 5:Queue 4:DH2: ${100 * MB} ${MB} 9001.0.0`, `DONE ${rid} 2`]);
    const l = (await netDriver.list(ctx, P('NET:/b1')))!;
    expect(l.entries.map((e) => [e.name, e.kind, e.path])).toEqual([
      ['Work', 'volume', 'NET:/b1/Work'], ['Queue (DH2:)', 'volume', 'NET:/b1/Queue (DH2:)'], ['Queue', 'dir', 'NET:/b1/Queue']]);
    expect(l.entries[0]).toMatchObject({ sizeText: 'DH1: · 40.0 MB free', size: null, date: new Date(Date.UTC(1978, 0, 1) + 9000 * 86_400_000).toISOString() });
    expect(l.entries[2].marks[0]).toMatch(/^\d+ waiting$/);
    expect(l).toMatchObject({ path: 'NET:/b1', writable: false, readOnlyReason: 'Open a volume or Queue', meta: '2 volumes',
      net: { board: 'b1', boardName: NAME, volume: null, amigaPath: null, cut: false, browse: null } });
    expect(typeof l.net!.readAt).toBe('number');
    expect(l.crumbs).toEqual([{ label: 'NET:', path: 'NET:' }, { label: NAME, path: 'NET:/b1' }]);
  });

  it('browsing off: no request, only Queue, and the words why', async () => {
    await getDb().update(devices).set({ browseOn: false }).where(eq(devices.id, 'b1'));
    try {
      const before = (await getDb().select().from(remoteRequests)).length;
      const l = (await netDriver.list(ctx, P('NET:/b1')))!;
      expect(l.entries.map((e) => e.name)).toEqual(['Queue']);
      expect(l.net!.browse).toBe(`Switch on browsing in Transfer on ${NAME}`);
      expect(l.meta).toBe(`Switch on browsing in Transfer on ${NAME}`);
      expect((await getDb().select().from(remoteRequests)).length).toBe(before);
      expect(await refusalOf('NET:/b1/Work')).toEqual({ code: 'read_only', detail: `Switch on browsing in Transfer on ${NAME}`, status: 409 });
    } finally { await getDb().update(devices).set({ browseOn: true }).where(eq(devices.id, 'b1')); }
  });

  it('a drawer lists through a request: drawers and files, read-only, crumbs, the volume\'s free space', async () => {
    expect(await pendingOf('NET:/b1/Work/Programs')).toBe(`Reading Work:Programs from ${NAME}…`);
    await answer((rid) => [`ENT ${rid} f 1234 5 9100.60.0 6:ReadMe 5:hello`, `ENT ${rid} d 0 0 9100.0.0 3:Sub 0:`, `DONE ${rid} 2`]);
    const l = (await netDriver.list(ctx, P('NET:/b1/Work/Programs')))!;
    expect(l.entries.find((e) => e.name === 'Sub')).toMatchObject({ kind: 'dir', path: 'NET:/b1/Work/Programs/Sub', size: null, comment: null });
    expect(l.entries.find((e) => e.name === 'ReadMe')).toMatchObject({ kind: 'file', path: 'NET:/b1/Work/Programs/ReadMe', size: 1234,
      protection: protectionString(5), comment: 'hello', date: new Date(Date.UTC(1978, 0, 1) + 9100 * 86_400_000 + 3_600_000).toISOString() });
    expect(l).toMatchObject({ path: 'NET:/b1/Work/Programs', writable: false, readOnlyReason: 'Read-only for now', disk: null, meta: '40.0 MB free',
      net: { board: 'b1', boardName: NAME, volume: 'Work', amigaPath: 'Work:Programs', cut: false, browse: null } });
    expect(typeof l.net!.readAt).toBe('number');
    expect(l.crumbs).toEqual([{ label: 'NET:', path: 'NET:' }, { label: NAME, path: 'NET:/b1' }, { label: 'Work:', path: 'NET:/b1/Work' },
      { label: 'Programs', path: 'NET:/b1/Work/Programs' }]);
    // The volumes answer no longer remembered: no free space to show.
    await getDb().update(remoteRequests).set({ answeredAt: new Date(Date.now() - 180_000) })
      .where(and(eq(remoteRequests.deviceId, 'b1'), eq(remoteRequests.kind, 'vols')));
    expect((await netDriver.list(ctx, P('NET:/b1/Work/Programs')))!.meta).toBe('');
  });

  it('a cut answer says so', async () => {
    expect(await pendingOf('NET:/b1/Work/Big')).not.toBeNull();
    await answer((rid) => [`ENT ${rid} f 1 0 9100.0.0 1:a 0:`, `DONE ${rid} 1000 cut`]);
    expect((await netDriver.list(ctx, P('NET:/b1/Work/Big')))!.net!.cut).toBe(true);
  });

  it('an error answer refuses with the pane\'s words', async () => {
    await pendingOf('NET:/b1/Work/Gone');
    await answer((rid) => [`ERR ${rid} notfound 0:`]);
    expect(await refusalOf('NET:/b1/Work/Gone')).toEqual({ code: 'not_found', detail: 'Object not found', status: 404 });
    await pendingOf('NET:/b1/Work/Off');
    await answer((rid) => [`ERR ${rid} off 0:`]);
    expect(await refusalOf('NET:/b1/Work/Off')).toEqual({ code: 'read_only', detail: `Switch on browsing in Transfer on ${NAME}`, status: 409 });
  });

  it('Refresh (fresh) asks again though the listing is remembered', async () => {
    expect(await pendingOf('NET:/b1/Work/Programs')).toBeNull();
    expect(await pendingOf('NET:/b1/Work/Programs', { fresh: true })).toBe(`Reading Work:Programs from ${NAME}…`);
    expect((await rows('dir', 'Work:Programs')).length).toBe(2);
  });

  // Final review ruling: Transfer sends plain names; the server labels duplicates, and a path through a label goes to
  // Transfer as the device's path. The pane still shows the label.
  it('two volumes with one name: labelled by device, and a drawer on one is asked for by its device path', async () => {
    await takeWaiting(getDb(), 'b1');   // what earlier cases left asked, so the answer below is the volumes'
    await pendingOf('NET:/b1', { fresh: true });
    await answer((rid) => [`VOL ${rid} 5:Empty 4:DF0: ${MB} ${MB} 9000.0.0`, `VOL ${rid} 5:Empty 4:DF1: ${MB} ${2 * MB} 9000.0.0`, `DONE ${rid} 2`]);
    expect((await netDriver.list(ctx, P('NET:/b1')))!.entries.map((e) => e.name)).toEqual(['Empty (DF0:)', 'Empty (DF1:)', 'Queue']);
    expect(await pendingOf('NET:/b1/Empty (DF1:)/c')).toBe(`Reading Empty (DF1:):c from ${NAME}…`);
    expect((await rows('dir', 'DF1:c')).map((r) => r.status)).toEqual(['waiting']);
    await answer((rid) => [`ENT ${rid} f 10 0 9100.0.0 3:Dir 0:`, `DONE ${rid} 1`]);
    const l = (await netDriver.list(ctx, P('NET:/b1/Empty (DF1:)/c')))!;
    expect(l.entries.map((e) => e.path)).toEqual(['NET:/b1/Empty (DF1:)/c/Dir']);
    expect(l).toMatchObject({ meta: '2.0 MB free', net: { volume: 'Empty (DF1:)', amigaPath: 'Empty (DF1:):c' } });
    expect(l.crumbs.slice(2)).toEqual([{ label: 'Empty (DF1:):', path: 'NET:/b1/Empty (DF1:)' }, { label: 'c', path: 'NET:/b1/Empty (DF1:)/c' }]);
  });

  it('a name the Amiga cannot hold is not found; another org\'s board is not found', async () => {
    expect(await netDriver.list(ctx, { device: 'NET', segments: ['b1', 'Work', 'a:b'] })).toBeNull();
    expect(await netDriver.list({ orgId: 'o2', userId: 'u2' }, P('NET:/b1'))).toBeNull();
    expect(await netDriver.list({ orgId: 'o2', userId: 'u2' }, P('NET:/b1/Work/Programs'))).toBeNull();
  });
});
