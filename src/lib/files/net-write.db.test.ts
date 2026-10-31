// src/lib/files/net-write.db.test.ts
// NET: volumes phase 2 (spec 2026-10-31 §4.1-4.3, plan Tasks 5-6): Files operations that change the Amiga's own disks
// against a board that can write -- the requests and queue rows they make, the clash answers, the limits, moves in each
// direction and the job's progress -- and the same operations refused with the words on a board that cannot.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { Client } from 'pg';
import { crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_files_net_write_test';
const url = new URL(base); url.pathname = `/${DB}`; process.env.DATABASE_URL = url.toString();
process.env.STORAGE_DIR ??= (await import('node:fs')).mkdtempSync('/tmp/webadf-files-net-write-');
process.env.BLOB_READ_WRITE_TOKEN = '';
async function admin(stmt: string) { const c = new Client({ connectionString: base }); await c.connect(); try { await c.query(stmt); } finally { await c.end(); } }

vi.mock('next/server', () => ({ after: () => {} }));
vi.mock('@/lib/tosec-sweep', () => ({ sweep: async () => {} }));

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { and, asc, eq } = await import('drizzle-orm');
const { organization } = await import('@/db/schema/auth');
const { devices } = await import('@/db/schema/devices');
const { transfers } = await import('@/db/schema/transfers');
const { amigaUploads } = await import('@/db/schema/amiga-uploads');
const { remoteRequests } = await import('@/db/schema/remote-requests');
const { insertStash, listStash } = await import('@/lib/stash');
const { takeWaiting, answerPiece, latestFor } = await import('@/lib/remote-requests');
const { openUpload, storeChunk, closeUpload } = await import('@/lib/amiga-uploads');
const { finishTransfer, sendQueueText } = await import('@/lib/transfers');
const { diskStore } = await import('@/lib/storage');
const { runOp } = await import('./ops');
const { netDriver } = await import('./net-driver');
const { parsePath } = await import('./path');
const { fetchProgress, placeFetched, afterTransferDone } = await import('./net-fetch');

const ctx = { orgId: 'o1', userId: 'u1' };
const DATE = '2020-01-02T00:00:00.000Z';
const ent = (name: string, size: number, dir = false) => ({ name, dir, size, protection: 0, date: DATE, comment: '' });
const W = (p: string) => `NET:/w1/Work/${p}`;
const OFF = 'Writing is off in Transfer';
const writes = async (deviceId = 'w1') => (await getDb().select().from(remoteRequests).where(eq(remoteRequests.deviceId, deviceId))
  .orderBy(asc(remoteRequests.createdAt))).filter((r) => r.kind !== 'dir' && r.kind !== 'get');
const lines = async (deviceId = 'w1') => (await writes(deviceId)).map((r) => [r.kind, r.amigaPath, r.target]);
const rows = async (deviceId = 'w1') => getDb().select().from(transfers).where(eq(transfers.deviceId, deviceId)).orderBy(asc(transfers.createdAt));
const gets = async () => getDb().select().from(remoteRequests).where(eq(remoteRequests.kind, 'get'));
const op = (o: Parameters<typeof runOp>[1]) => runOp(ctx, o);

let n = 0;
/** A remembered (answered just now) listing of `amigaPath` on a board. */
async function remember(amigaPath: string, entries: ReturnType<typeof ent>[], deviceId = 'w1') {
  const now = new Date();
  await getDb().insert(remoteRequests).values({ id: `dir-${deviceId}-${++n}`, orgId: 'o1', deviceId, kind: 'dir', amigaPath,
    status: 'done', answer: { volumes: [], entries }, createdAt: now, sentAt: now, answeredAt: now });
}
async function stash(path: string, body: string | Uint8Array, kind: 'file' | 'dir' = 'file') {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const sha = createHash('sha256').update(bytes).digest('hex');
  await diskStore.put(sha, bytes, { overwrite: true });
  const r = await insertStash(getDb(), 'o1', 'browser', [kind === 'file'
    ? { path, kind, sha256: sha, sizeBytes: bytes.length, date: null, protection: 0, comment: '' }
    : { path, kind, sha256: null, sizeBytes: 0, date: null, protection: 0, comment: '' }]);
  if (!r.ok) throw new Error(r.code);
}
/** The board's side of one get, as in net-fetch.db.test.ts: GOT, the upload tied to it, the close; then the placement. */
async function arrive(rid: string, amigaPath: string, bytes: Uint8Array, deviceId = 'w1') {
  await takeWaiting(getDb(), deviceId);
  expect(await answerPiece(getDb(), deviceId, rid, { piece: 0, lines: [`GOT ${rid} 7`], last: true })).toEqual({ ok: true });
  const o = await openUpload(getDb(), { deviceId, orgId: 'o1' }, { size: bytes.length, date: '1.2.3', protection: 0, path: amigaPath, comment: '', request: rid });
  if (!o.ok) throw new Error(o.code);
  expect((await storeChunk(getDb(), deviceId, o.id, 0, bytes)).ok).toBe(true);
  expect((await closeUpload(getDb(), deviceId, o.id, crc32(bytes) >>> 0)).ok).toBe(true);
  await placeFetched(getDb(), o.id);
  return o.id;
}
/** The board takes its queue's NEXT row and reports how it went (as the done route would, then its settling). */
async function deliver(id: string, outcome: Parameters<typeof finishTransfer>[3], deviceId = 'w1') {
  expect(await finishTransfer(getDb(), deviceId, id, outcome)).toBe(true);
  await afterTransferDone(getDb(), id);
}

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
  const can = { firmwareVersion: '1.23.0+gabc', lastSeenAt: now, sendRx: 'c', sendRxAt: now, rxProto: 4, browseOn: true, writeOn: true };
  await db.insert(devices).values([
    { id: 'w1', orgId: 'o1', name: 'A500', tokenHash: 'h1', ...can },
    { id: 'w2', orgId: 'o1', name: 'A1200', tokenHash: 'h2', ...can },
    { id: 'w3', orgId: 'o1', name: 'A600', tokenHash: 'h3', ...can, writeOn: false },
  ]);
  await remember('Work:', [ent('a.txt', 3), ent('a.txt.info', 5), ent('Sub', 0, true), ent('old', 0, true), ent('old.info', 5), ent('x', 2)]);
});
afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

describe('one-line writes on a volume', () => {
  it('Makedir is one MKDIR, refused when the remembered drawer holds the name', async () => {
    const r = await op({ op: 'makedir', dest: 'NET:/w1/Work', name: 'New' });
    expect(r).toMatchObject({ kind: 'done', items: [{ source: W('New'), ok: true }], job: { files: 0, writes: 1 } });
    expect(await lines()).toEqual([['mkdir', 'Work:New', { label: 'Work:New' }]]);
    expect(await op({ op: 'makedir', dest: 'NET:/w1/Work', name: 'sub' })).toMatchObject({ kind: 'refused', refusal: { code: 'name_exists' } });
    expect(await op({ op: 'makedir', dest: 'NET:/w1/Work', name: 'a:b' })).toMatchObject({ kind: 'refused', refusal: { code: 'bad_name' } });
  });

  it('Rename is a RENAME, its icon along; with nothing remembered the icon goes as a maybe', async () => {
    expect(await op({ op: 'rename', source: W('a.txt'), name: 'b.txt' })).toMatchObject({ kind: 'done', job: { writes: 2 } });
    expect(await lines()).toEqual([
      ['rename', 'Work:a.txt', { to: 'Work:b.txt', label: 'Work:a.txt' }],
      ['rename', 'Work:a.txt.info', { to: 'Work:b.txt.info', label: 'Work:a.txt.info' }],
    ]);
    expect(await op({ op: 'rename', source: W('a.txt'), name: 'X' })).toMatchObject({ kind: 'refused', refusal: { code: 'name_exists' } });
    expect(await op({ op: 'rename', source: W('a.txt'), name: 'A.TXT' })).toMatchObject({ kind: 'done' });   // case only
    await getDb().delete(remoteRequests);
    expect(await op({ op: 'rename', source: 'NET:/w1/Work/Sub/y', name: 'z' })).toMatchObject({ kind: 'done' });
    expect(await lines()).toEqual([
      ['rename', 'Work:Sub/y', { to: 'Work:Sub/z', label: 'Work:Sub/y' }],
      ['rename', 'Work:Sub/y.info', { to: 'Work:Sub/z.info', label: 'Work:Sub/y.info', icon: true }],
    ]);
    expect(await op({ op: 'rename', source: 'NET:/w1/Work', name: 'Play' })).toMatchObject({ kind: 'refused', refusal: { code: 'unsupported' } });
  });

  it('Delete is a DELETE per source and its icon, unless the icon was picked too', async () => {
    const r = await op({ op: 'delete', sources: [W('old'), W('a.txt.info'), W('a.txt'), W('x')] });
    expect(r).toMatchObject({ kind: 'done', items: [W('old'), W('a.txt.info'), W('a.txt'), W('x')].map((source) => ({ source, ok: true })) });
    expect((await lines()).map(([k, p]) => `${k} ${p}`)).toEqual([
      'delete Work:old', 'delete Work:old.info', 'delete Work:a.txt.info', 'delete Work:a.txt', 'delete Work:x',
    ]);
  });

  it('Protect is a PROTECT per source; a comment one NOTE', async () => {
    await op({ op: 'protect', sources: [W('a.txt'), W('x')], protection: 0x4f });
    await op({ op: 'comment', source: W('x'), comment: 'hi' });
    expect(await lines()).toEqual([
      ['protect', 'Work:a.txt', { protection: 0x4f, label: 'Work:a.txt' }],
      ['protect', 'Work:x', { protection: 0x4f, label: 'Work:x' }],
      ['note', 'Work:x', { comment: 'hi', label: 'Work:x' }],
    ]);
    expect(await op({ op: 'comment', source: W('x'), comment: 'x'.repeat(80) })).toMatchObject({ kind: 'refused', refusal: { code: 'comment_too_long' } });
  });

  it('a board that cannot write refuses every write with the words, and makes nothing', async () => {
    await remember('Work:', [ent('a.txt', 3)], 'w3');
    for (const o of [
      { op: 'makedir' as const, dest: 'NET:/w3/Work', name: 'New' }, { op: 'rename' as const, source: 'NET:/w3/Work/a.txt', name: 'b' },
      { op: 'delete' as const, sources: ['NET:/w3/Work/a.txt'] }, { op: 'protect' as const, sources: ['NET:/w3/Work/a.txt'], protection: 0 },
      { op: 'comment' as const, source: 'NET:/w3/Work/a.txt', comment: '' },
    ]) expect(await op(o)).toMatchObject({ kind: 'refused', status: 409, refusal: { code: 'read_only', detail: OFF } });
    expect(await writes('w3')).toEqual([]);
  });

  it('the job says how its writes went: a delete counting up, then stopped half way', async () => {
    const r = await op({ op: 'delete', sources: [W('old')] });
    const job = (r as { job: { id: string } }).job.id;
    const [del, icon] = await writes();
    await takeWaiting(getDb(), 'w1');
    await answerPiece(getDb(), 'w1', del.id, { piece: 0, lines: [`DEL ${del.id} 37`], last: false });
    expect((await fetchProgress(getDb(), 'o1', job, new Date()))!.writes[0]).toMatchObject({ kind: 'delete', label: 'Work:old', status: 'running', removed: 37 });
    await answerPiece(getDb(), 'w1', del.id, { piece: 1, lines: [`ERR ${del.id} busy 31:Libs/foo.library: object in use`], last: true });
    await answerPiece(getDb(), 'w1', icon.id, { piece: 0, lines: [`DONE ${icon.id} 1`], last: true });
    const p = (await fetchProgress(getDb(), 'o1', job, new Date()))!;
    expect(p.writes).toEqual([
      { kind: 'delete', label: 'Work:old', status: 'failed', removed: 37, reason: 'In use on the Amiga', quiet: false },
      { kind: 'delete', label: 'Work:old.info', status: 'done', removed: 1, reason: null, quiet: false },
    ]);
    expect(p).toMatchObject({ total: 0, board: 'A500' });
  });
});

describe('copy onto a volume', () => {
  beforeEach(async () => { await remember('Work:Tools', [ent('a.lha', 3)]); });

  it('one queue row per file with the absolute path, the clash mode and the job; the board gets the extended NEXT', async () => {
    await stash('In/b.lha', 'bee');
    const r = await op({ op: 'copy', sources: ['STASH:/In/b.lha'], dest: 'NET:/w1/Work/Tools', onClash: 'ask' });
    expect(r).toMatchObject({ kind: 'done', items: [{ source: 'STASH:/In/b.lha', ok: true }], job: { files: 1, writes: 0 } });
    const [row] = await rows();
    expect(row).toMatchObject({ path: 'b.lha', amigaDest: 'Work:Tools/b.lha', onClash: 'keep', jobId: (r as { job: { id: string } }).job.id, moveSource: null });
    expect((await sendQueueText(getDb(), 'w1')).split('\n')[0]).toMatch(/^NEXT \S+ 3 [0-9a-f]+ 0 16:Work:Tools\/b\.lha 0: keep$/);
    // The destination shows it arriving, and is writable.
    const l = (await netDriver.list(ctx, parsePath('NET:/w1/Work/Tools')!))!;
    expect(l).toMatchObject({ writable: true, readOnlyReason: null, net: { write: null } });
    expect(l.entries.find((e) => e.name === 'b.lha')).toMatchObject({ kind: 'file', size: 3, marks: ['Waiting'] });
  });

  it('a clash: ask returns it, skip leaves it, replace replaces, keep both renames; nothing remembered is a conflict', async () => {
    await stash('In/a.lha', 'new');
    const copy = (onClash: 'ask' | 'skip' | 'replace' | 'keep-both', dest = 'NET:/w1/Work/Tools') => op({ op: 'copy', sources: ['STASH:/In/a.lha'], dest, onClash });
    expect(await copy('ask')).toEqual({ kind: 'clashes', clashes: [{ source: 'STASH:/In/a.lha', name: 'a.lha', dest: 'NET:/w1/Work/Tools' }] });
    expect(await copy('skip')).toMatchObject({ kind: 'done', items: [{ source: 'STASH:/In/a.lha', ok: true, skipped: true }] });
    expect(await rows()).toEqual([]);
    await copy('replace');
    await copy('keep-both');
    expect((await rows()).map((x) => [x.amigaDest, x.onClash])).toEqual([['Work:Tools/a.lha', 'replace'], ['Work:Tools/a_1.lha', 'keep']]);
    expect(await copy('ask', 'NET:/w1/Work/Nowhere')).toMatchObject({ kind: 'refused', refusal: { code: 'conflict', detail: 'List the drawer again and retry' } });
  });

  it('a drawer brings its files, and makes the drawers that hold none', async () => {
    await stash('Pack/one.txt', '1');
    await stash('Pack/Deep/two.txt', '22');
    await stash('Pack/Empty', '', 'dir');
    const r = await op({ op: 'copy', sources: ['STASH:/Pack'], dest: 'NET:/w1/Work/Tools', onClash: 'ask' });
    expect(r).toMatchObject({ kind: 'done', job: { files: 2, writes: 2 } });
    expect((await rows()).map((x) => x.amigaDest).sort()).toEqual(['Work:Tools/Pack/Deep/two.txt', 'Work:Tools/Pack/one.txt']);
    expect(await lines()).toEqual([
      ['mkdir', 'Work:Tools/Pack', { label: 'Work:Tools/Pack', ensure: true }],
      ['mkdir', 'Work:Tools/Pack/Empty', { label: 'Work:Tools/Pack/Empty', ensure: true }],
    ]);
    // A drawer the board made meanwhile is as good as made.
    const [mk] = await writes();
    await takeWaiting(getDb(), 'w1');
    await answerPiece(getDb(), 'w1', mk.id, { piece: 0, lines: [`ERR ${mk.id} exists 13:object exists`], last: true });
    expect((await writes())[0].status).toBe('done');
  });

  it('the limits: a file over 4 MB, and more than the board\'s queue holds', async () => {
    await stash('Big.bin', new Uint8Array(4 * 1024 * 1024 + 1));
    expect(await op({ op: 'copy', sources: ['STASH:/Big.bin'], dest: 'NET:/w1/Work/Tools', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', refusal: { code: 'too_large' } });
    for (let i = 0; i < 33; i++) await stash(`Many/f${i}`, `${i}`);
    expect(await op({ op: 'copy', sources: ['STASH:/Many'], dest: 'NET:/w1/Work/Tools', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', refusal: { code: 'queue_full' } });
    expect(await rows()).toEqual([]);
  });

  it('writing off: the copy is refused; one already queued fails readonly when the board says so', async () => {
    await remember('Work:', [], 'w3');
    await stash('In/c.txt', 'c');
    expect(await op({ op: 'copy', sources: ['STASH:/In/c.txt'], dest: 'NET:/w3/Work', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', refusal: { code: 'read_only', detail: OFF } });
  });

  it('a finished batch lets the destination\'s memory go; one still moving keeps it', async () => {
    await stash('In/p.txt', 'p'); await stash('In/q.txt', 'q');
    await op({ op: 'copy', sources: ['STASH:/In/p.txt', 'STASH:/In/q.txt'], dest: 'NET:/w1/Work/Tools', onClash: 'ask' });
    const [p, q] = await rows();
    await deliver(p.id, { ok: true, savedAs: 'Work:Tools/p.txt' });
    expect((await latestFor(getDb(), 'w1', 'dir', 'Work:Tools')).state).toBe('ready');
    await deliver(q.id, { ok: false, code: 'skipped', text: '' });
    expect((await latestFor(getDb(), 'w1', 'dir', 'Work:Tools')).state).toBe('none');
    expect((await latestFor(getDb(), 'w1', 'dir', 'Work:')).state).toBe('none');
  });
});

describe('moves', () => {
  beforeEach(async () => { await remember('Work:Tools', []); await remember('Work:Sub', [ent('a.txt', 1)]); });

  it('STASH: onto a volume: the source goes once every file of it is delivered, and stays when one is not', async () => {
    await stash('In/m.txt', 'm'); await stash('In/k.txt', 'k');
    const r = await op({ op: 'move', sources: ['STASH:/In/m.txt', 'STASH:/In/k.txt'], dest: 'NET:/w1/Work/Tools', onClash: 'ask' });
    expect(r).toMatchObject({ kind: 'done', items: [{ ok: true }, { ok: true }] });
    const names = async () => (await listStash(getDb(), 'o1')).map((x) => x.path).sort();
    expect(await names()).toEqual(['In/k.txt', 'In/m.txt']);
    const [m, k] = await rows();
    expect([m.moveSource, k.moveSource]).toEqual(['STASH:/In/m.txt', 'STASH:/In/k.txt']);
    await deliver(m.id, { ok: true, savedAs: 'Work:Tools/m.txt' });
    await deliver(k.id, { ok: false, code: 'skipped', text: '' });
    expect(await names()).toEqual(['In/k.txt']);
  });

  it('within one volume: a RENAME into the drawer; Replace deletes what is there first; a drawer never into itself', async () => {
    expect(await op({ op: 'move', sources: [W('x')], dest: 'NET:/w1/Work/Sub', onClash: 'ask' })).toMatchObject({ kind: 'done' });
    expect(await lines()).toEqual([['rename', 'Work:x', { to: 'Work:Sub/x', label: 'Work:x' }]]);
    await getDb().delete(remoteRequests).where(eq(remoteRequests.kind, 'rename'));
    expect(await op({ op: 'move', sources: [W('a.txt')], dest: 'NET:/w1/Work/Sub', onClash: 'ask' })).toMatchObject({ kind: 'clashes' });
    await op({ op: 'move', sources: [W('a.txt')], dest: 'NET:/w1/Work/Sub', onClash: 'replace' });
    expect((await lines()).map(([k, p, t]) => `${k} ${p} ${(t as { to?: string }).to ?? ''}`)).toEqual([
      'delete Work:Sub/a.txt ', 'rename Work:a.txt Work:Sub/a.txt', 'rename Work:a.txt.info Work:Sub/a.txt.info',
    ]);
    await remember('Work:Sub', []);
    expect(await op({ op: 'move', sources: [W('Sub')], dest: 'NET:/w1/Work/Sub', onClash: 'ask' })).toMatchObject({ kind: 'refused', refusal: { code: 'cycle' } });
  });

  it('out of a volume into STASH:: the source is deleted on the Amiga once its file is stored', async () => {
    const r = await op({ op: 'move', sources: [W('x')], dest: 'STASH:', onClash: 'keep-both' });
    expect(r).toMatchObject({ kind: 'done', fetching: { files: 1 } });
    const [g] = await gets();
    await arrive(g.id, 'Work:x', new TextEncoder().encode('xx'));
    expect((await writes()).map((w) => `${w.kind} ${w.amigaPath}`)).toEqual(['delete Work:x']);
  });

  it('between two boards\' volumes: fetched, handed to the other board\'s queue, out of STASH:; a move then deletes', async () => {
    await remember('DF0:', [], 'w2');
    const r = await op({ op: 'move', sources: [W('x')], dest: 'NET:/w2/DF0', onClash: 'ask' });
    expect(r).toMatchObject({ kind: 'done', job: { files: 1 } });
    const job = (r as { job: { id: string } }).job.id;
    const [g] = await gets();
    expect(g.deviceId).toBe('w1');
    await arrive(g.id, 'Work:x', new TextEncoder().encode('xx'));
    const [row] = await rows('w2');
    expect(row).toMatchObject({ amigaDest: 'DF0:x', onClash: 'keep', jobId: job, moveSource: W('x'), sizeBytes: 2 });
    expect(await listStash(getDb(), 'o1')).toEqual([]);
    expect(await fetchProgress(getDb(), 'o1', job, new Date())).toMatchObject({ total: 1, done: 0, waiting: 1 });
    await deliver(row.id, { ok: true, savedAs: 'DF0:x' }, 'w2');
    expect(await fetchProgress(getDb(), 'o1', job, new Date())).toMatchObject({ total: 1, done: 1, waiting: 0 });
    expect((await writes()).map((w) => `${w.kind} ${w.amigaPath}`)).toEqual(['delete Work:x']);
  });
});
