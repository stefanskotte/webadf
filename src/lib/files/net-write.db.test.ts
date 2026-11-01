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
const { asc, eq } = await import('drizzle-orm');
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
/** What each drawer on the Amiga holds now (as last remembered): what a fresh listing answers (answerFresh). */
const amigaNow = new Map<string, ReturnType<typeof ent>[]>();
/** A remembered (answered just now) listing of `amigaPath` on a board. */
async function remember(amigaPath: string, entries: ReturnType<typeof ent>[], deviceId = 'w1') {
  amigaNow.set(`${deviceId} ${amigaPath.toLowerCase()}`, entries);
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
  for (let at = 0; at < bytes.length; at += 16_384) {
    expect((await storeChunk(getDb(), deviceId, o.id, at, bytes.subarray(at, at + 16_384))).ok).toBe(true);
  }
  expect((await closeUpload(getDb(), deviceId, o.id, crc32(bytes) >>> 0)).ok).toBe(true);
  await placeFetched(getDb(), o.id);
  return o.id;
}
/**
 * The fresh listings a move off a volume asks before it removes anything (final review I-1), answered as the Amiga holds
 * them now (`changed` overrides a drawer), each answer then handed on as the req route does.
 */
async function answerFresh(deviceId = 'w1', changed: Record<string, ReturnType<typeof ent>[]> = {}) {
  const { afterRequestAnswered } = await import('./net-moves');
  const day = (iso: string) => `${Math.round((Date.parse(iso) - Date.UTC(1978, 0, 1)) / 86_400_000)}.0.0`;
  const asked = (await takeWaiting(getDb(), deviceId)).filter((r) => r.kind === 'dir');
  for (const r of asked) {
    const es = changed[r.amigaPath] ?? amigaNow.get(`${deviceId} ${r.amigaPath.toLowerCase()}`) ?? [];
    const lines = [...es.map((e) => `ENT ${r.id} ${e.dir ? 'd' : 'f'} ${e.size} 0 ${day(e.date)} ${e.name.length}:${e.name} 0:`), `DONE ${r.id} ${es.length}`];
    expect(await answerPiece(getDb(), deviceId, r.id, { piece: 0, lines, last: true })).toEqual({ ok: true });
    await afterRequestAnswered(getDb(), deviceId, r.id);
  }
  return asked.map((r) => r.amigaPath);
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
  const can = { firmwareVersion: '1.23.0+gabc', lastSeenAt: now, sendRx: 'c', sendRxAt: now, rxProto: 5, browseOn: true, writeOn: true };
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

  // Transfer 2.5 answers `bad` to any write on a volume's root: none is ever made for the volume itself.
  it('a volume itself is never deleted, protected or commented', async () => {
    expect(await op({ op: 'delete', sources: ['NET:/w1/Work'] })).toMatchObject({ kind: 'done', items: [{ ok: false, refusal: { code: 'not_found' } }] });
    for (const o of [{ op: 'protect' as const, sources: ['NET:/w1/Work'], protection: 0 },
      { op: 'comment' as const, source: 'NET:/w1/Work', comment: 'x' }]) {
      expect(await op(o)).toMatchObject({ kind: 'refused' });
    }
    expect(await writes()).toEqual([]);
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

  it('the board root and a volume say why they cannot be written to; a board that can write says nothing', async () => {
    for (const d of ['w1', 'w3']) {
      await getDb().insert(remoteRequests).values({ id: `vols-${d}`, orgId: 'o1', deviceId: d, kind: 'vols', amigaPath: '', status: 'done',
        answer: { volumes: [{ name: 'Work', device: 'DH1:', size: 1, free: 1, date: DATE }], entries: [] }, answeredAt: new Date() });
    }
    await remember('Work:', [], 'w3');
    expect((await netDriver.list(ctx, parsePath('NET:/w3')!))!.net).toMatchObject({ browse: null, write: OFF });
    expect((await netDriver.list(ctx, parsePath('NET:/w1')!))!.net).toMatchObject({ browse: null, write: null });
    expect(await netDriver.list(ctx, parsePath('NET:/w3/Work')!)).toMatchObject({ writable: false, readOnlyReason: OFF, net: { write: OFF } });
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
      { kind: 'delete', label: 'Work:old', to: null, status: 'failed', removed: 37, reason: 'In use on the Amiga', entry: 'Libs/foo.library', quiet: false, kept: false, restIn: null },
      { kind: 'delete', label: 'Work:old.info', to: null, status: 'done', removed: 1, reason: null, entry: null, quiet: false, kept: false, restIn: null },
    ]);
    expect(p).toMatchObject({ total: 0, board: 'A500', direction: 'from' });
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

  // A500 bench 2026-10-31: a STASH: drawer of 7 files copied onto a drawer showed "Nothing here." until a Refresh. The
  // drawer arriving is a row with the copy's progress, as its files are (spec §4.1, "as STASH: shows uploads").
  it('a drawer on its way is a row with its progress, in the drawer and in the one above', async () => {
    const { recordChunk } = await import('@/lib/transfers');
    await stash('Pack/one.txt', '1');
    await stash('Pack/Deep/two.txt', '22');
    await op({ op: 'copy', sources: ['STASH:/Pack'], dest: 'NET:/w1/Work/Tools', onClash: 'ask' });
    const pack = async (at = 'NET:/w1/Work/Tools') => (await netDriver.list(ctx, parsePath(at)!))!.entries.find((e) => e.name === 'Pack');
    expect(await pack()).toMatchObject({ kind: 'dir', path: 'NET:/w1/Work/Tools/Pack', marks: ['Waiting'] });
    const above = (await netDriver.list(ctx, parsePath('NET:/w1/Work')!))!.entries.find((e) => e.name === 'Tools');
    expect(above).toMatchObject({ kind: 'dir', path: 'NET:/w1/Work/Tools', marks: ['Waiting'] });
    const [one, two] = (await rows()).sort((a, b) => a.amigaDest!.localeCompare(b.amigaDest!));
    expect((await recordChunk(getDb(), 'w1', two.id, 0)).ok).toBe(true);
    expect(await pack()).toMatchObject({ marks: ['Sending 1 of 2'] });
    await deliver(two.id, { ok: true, savedAs: 'Work:Tools/Pack/Deep/two.txt' });
    expect(await pack()).toMatchObject({ marks: ['Sending 2 of 2'] });
    // A drawer of the same name already listed (a copy with Replace) carries the progress too.
    await remember('Work:Tools', [ent('a.lha', 3), ent('Pack', 0, true)]);
    expect(await pack()).toMatchObject({ kind: 'dir', marks: ['Sending 2 of 2'] });
    await deliver(one.id, { ok: true, savedAs: 'Work:Tools/Pack/one.txt' });
    await remember('Work:Tools', [ent('a.lha', 3), ent('Pack', 0, true)]);
    expect(await pack()).toMatchObject({ marks: [] });
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

  // Spec 2026-10-31 §9 (web ruling I-1 fixed): only what was copied leaves STASH:; the move says what it kept.
  it('§9: a STASH: drawer moved onto a volume leaves a file put into it meanwhile, and an empty drawer goes once made there', async () => {
    await stash('Pack/one.txt', '1'); await stash('Pack/In/two.txt', '2'); await stash('Pack/E', '', 'dir');
    const r = await op({ op: 'move', sources: ['STASH:/Pack'], dest: 'NET:/w1/Work/Tools', onClash: 'ask' });
    const job = (r as { job: { id: string } }).job.id;
    const queued = await rows();
    expect(queued.map((x) => [x.amigaDest, x.moveSource, x.moveItem])).toEqual([
      ['Work:Tools/Pack/one.txt', 'STASH:/Pack', 'Pack/one.txt'], ['Work:Tools/Pack/In/two.txt', 'STASH:/Pack', 'Pack/In/two.txt']]);
    const mks = await writes();
    expect(mks.map((m) => [m.kind, m.amigaPath, (m.target as { moveItem?: string }).moveItem])).toEqual([
      ['mkdir', 'Work:Tools/Pack', 'Pack'], ['mkdir', 'Work:Tools/Pack/E', 'Pack/E']]);
    await stash('Pack/In/new.txt', 'new');   // saved into the drawer while the move runs
    for (const x of queued) await deliver(x.id, { ok: true, savedAs: x.amigaDest! });
    const names = async () => (await listStash(getDb(), 'o1')).map((x) => x.path).sort();
    expect(await names()).toEqual(['Pack/E', 'Pack/In/new.txt', 'Pack/In/two.txt', 'Pack/one.txt']);   // the Makedir is not made yet
    await takeWaiting(getDb(), 'w1');
    for (const mk of mks) await answerPiece(getDb(), 'w1', mk.id, { piece: 0, lines: [`DONE ${mk.id} 1`], last: true });
    const p = (await fetchProgress(getDb(), 'o1', job, new Date()))!;
    expect(await names()).toEqual(['Pack/In/new.txt']);
    expect(p).toMatchObject({ waiting: 0, failed: [] });
    expect(p.writes.filter((w) => w.kept).map((w) => w.label)).toEqual(['STASH:/Pack']);
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
    expect(await writes()).toEqual([]);   // first the drawer is read afresh: is Work:x still the file copied?
    expect(await answerFresh()).toEqual(['Work:']);
    expect((await writes()).map((w) => [w.kind, w.amigaPath, w.target])).toEqual([['delete', 'Work:x', { label: 'Work:x', one: true }]]);
    // What arrived moves on again, onto a drawer of the volume.
    const back = await op({ op: 'move', sources: ['STASH:/x'], dest: 'NET:/w1/Work/Tools', onClash: 'ask' });
    expect(back).toMatchObject({ kind: 'done', items: [{ source: 'STASH:/x', ok: true }], job: { files: 1 } });
    // The DELETE is the move's own: its progress waits for it.
    const job = (r as { fetching: { id: string } }).fetching.id;
    expect((await writes())[0].fetchId).toBe(job);
    expect(await fetchProgress(getDb(), 'o1', job, new Date())).toMatchObject({ done: 1, waiting: 0, writes: [{ kind: 'delete', status: 'waiting' }] });
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
    expect(await fetchProgress(getDb(), 'o1', job, new Date())).toMatchObject({ total: 1, done: 0, waiting: 1, direction: 'to' });
    await deliver(row.id, { ok: true, savedAs: 'DF0:x' }, 'w2');
    await answerFresh();
    expect(await fetchProgress(getDb(), 'o1', job, new Date())).toMatchObject({ total: 1, done: 1, waiting: 0 });
    expect((await writes()).map((w) => `${w.kind} ${w.amigaPath}`)).toEqual(['delete Work:x']);
  });

  // Final review C1: a drawer moved between volumes arrives file by file; its source may go only once all of it has.
  it('final review C1: a drawer moved between volumes is deleted only once every file of it arrived', async () => {
    await remember('DF0:', [], 'w2');
    await remember('Work:Pair', [ent('a', 1), ent('b', 1)]);
    await remember('Work:', [ent('Pair', 0, true)]);
    const r = await op({ op: 'move', sources: [W('Pair')], dest: 'NET:/w2/DF0', onClash: 'ask' });
    const job = (r as { job: { id: string } }).job.id;
    const [ga, gb] = (await gets()).sort((x, y) => x.amigaPath.localeCompare(y.amigaPath));
    await arrive(ga.id, 'Work:Pair/a', new TextEncoder().encode('a'));
    const [ra] = await rows('w2');
    await deliver(ra.id, { ok: true, savedAs: 'DF0:Pair/a' }, 'w2');
    expect(await writes()).toEqual([]);   // b has not arrived: Work:Pair stays
    await arrive(gb.id, 'Work:Pair/b', new TextEncoder().encode('b'));
    const rb = (await rows('w2')).find((x) => x.id !== ra.id)!;
    await deliver(rb.id, { ok: true, savedAs: 'DF0:Pair/b' }, 'w2');
    await answerFresh();
    // Spec §9: what was copied, one object at a time, the drawer last (never the drawer as it is at the end).
    expect((await writes()).map((w) => `${w.kind} ${w.amigaPath} ${(w.target as { one?: boolean }).one}`))
      .toEqual(['delete Work:Pair/a true', 'delete Work:Pair/b true', 'delete Work:Pair true']);
    expect(await fetchProgress(getDb(), 'o1', job, new Date())).toMatchObject({ total: 2, done: 2, waiting: 0 });
  });

  it('final review C1/C2: one file of a moved drawer fails: the source stays, and the job finishes saying so', async () => {
    await remember('DF0:', [], 'w2');
    await remember('Work:Pair', [ent('a', 1), ent('b', 1)]);
    await remember('Work:', [ent('Pair', 0, true)]);
    const r = await op({ op: 'move', sources: [W('Pair')], dest: 'NET:/w2/DF0', onClash: 'ask' });
    const job = (r as { job: { id: string } }).job.id;
    const [ga, gb] = (await gets()).sort((x, y) => x.amigaPath.localeCompare(y.amigaPath));
    await arrive(ga.id, 'Work:Pair/a', new TextEncoder().encode('a'));
    const [ra] = await rows('w2');
    await deliver(ra.id, { ok: true, savedAs: 'DF0:Pair/a' }, 'w2');
    await answerPiece(getDb(), 'w1', gb.id, { piece: 0, lines: [`ERR ${gb.id} notfound 0:`], last: true });
    const p = (await fetchProgress(getDb(), 'o1', job, new Date()))!;
    expect(p).toMatchObject({ total: 2, done: 1, waiting: 0, failed: [{ name: 'b' }] });
    expect(await writes()).toEqual([]);
  });

  it('final review C2: a move onto a volume whose other file fails readonly (writing off) finishes; the source stays', async () => {
    await stash('Two/m.txt', 'm'); await stash('Two/k.txt', 'k');
    const r = await op({ op: 'move', sources: ['STASH:/Two'], dest: 'NET:/w1/Work/Tools', onClash: 'ask' });
    const job = (r as { job: { id: string } }).job.id;
    const [m] = await rows();
    await deliver(m.id, { ok: true, savedAs: 'Work:Tools/Two/x' });
    const { failWritesWhenOff } = await import('@/lib/transfers');
    await failWritesWhenOff(getDb(), 'w1');
    expect(await fetchProgress(getDb(), 'o1', job, new Date())).toMatchObject({ waiting: 0, failed: [{ reason: 'Writing is off in Transfer' }] });
    expect((await listStash(getDb(), 'o1')).map((x) => x.path).filter((x) => x.endsWith('.txt')).sort()).toEqual(['Two/k.txt', 'Two/m.txt']);
  });

  it('final review I-2: a move whose source cannot be removed says so in its job', async () => {
    const r = await op({ op: 'move', sources: [W('x')], dest: 'STASH:', onClash: 'keep-both' });
    const job = (r as { fetching: { id: string } }).fetching.id;
    const [g] = await gets();
    await getDb().update(devices).set({ writeOn: false }).where(eq(devices.id, 'w1'));
    await arrive(g.id, 'Work:x', new TextEncoder().encode('xx'));
    const p = (await fetchProgress(getDb(), 'o1', job, new Date()))!;
    expect(p).toMatchObject({ done: 1, waiting: 0 });
    expect(p.writes).toEqual([expect.objectContaining({ kind: 'delete', label: 'Work:x', status: 'failed',
      reason: 'Copied, but the original could not be removed — Writing is off in Transfer' })]);
  });
});

// Spec 2026-10-31 §9: a move removes only what it copied; a Move that copies off a volume needs Transfer 2.6.
describe('Transfer 2.6 delete words', () => {
  it('a drawer delete that stopped and could not rename the drawer back keeps where the rest is', async () => {
    const r = await op({ op: 'delete', sources: [W('old')] });
    const job = (r as { job: { id: string } }).job.id;
    const [d] = (await writes()).filter((x) => x.amigaPath === 'Work:old');
    await takeWaiting(getDb(), 'w1');
    const text = 'the rest is in .webadf-del-0a1b2c3d: Libs/foo.library: object in use';
    await answerPiece(getDb(), 'w1', d.id, { piece: 0, lines: [`DEL ${d.id} 37`, `ERR ${d.id} busy ${text.length}:${text}`], last: true });
    const w = (await fetchProgress(getDb(), 'o1', job, new Date()))!.writes.find((x) => x.label === 'Work:old')!;
    expect(w).toMatchObject({ status: 'failed', removed: 37, entry: 'Libs/foo.library', reason: 'In use on the Amiga', restIn: '.webadf-del-0a1b2c3d' });
  });
});

describe('safe moves off a volume (protocol 5)', () => {
  beforeEach(async () => {
    await getDb().delete(remoteRequests);
    await remember('Work:', [ent('Pair', 0, true), ent('Pair.info', 5), ent('x', 2), ent('g.adf', 901120)]);
    await remember('Work:Pair', [ent('a', 1), ent('E', 0, true), ent('b', 1)]);
    await remember('Work:Pair/E', []);
  });
  const oneLines = async (deviceId = 'w1') => (await writes(deviceId)).filter((w) => w.status !== 'failed').map((w) => `${w.kind} ${w.amigaPath}${(w.target as { one?: boolean }).one ? ' one' : ''}`);
  const answerAll = async (deviceId: string, answer: (rid: string, path: string) => string) => {
    for (const r of await takeWaiting(getDb(), deviceId)) {
      expect(await answerPiece(getDb(), deviceId, r.id, { piece: 0, lines: [answer(r.id, r.amigaPath)], last: true })).toEqual({ ok: true });
    }
  };

  it('into STASH:: one DELETE … one per copied file, then each drawer deepest first; a file added meanwhile keeps its drawer', async () => {
    const r = await op({ op: 'move', sources: [W('Pair')], dest: 'STASH:', onClash: 'ask' });
    const job = (r as { fetching: { id: string } }).fetching.id;
    expect(await oneLines()).toEqual([]);
    const [ga, gb] = (await gets()).sort((x, y) => x.amigaPath.localeCompare(y.amigaPath));
    await arrive(ga.id, 'Work:Pair/a', new TextEncoder().encode('a'));
    expect(await oneLines()).toEqual([]);   // b has not arrived: nothing goes
    await arrive(gb.id, 'Work:Pair/b', new TextEncoder().encode('b'));
    expect(await answerFresh()).toEqual(['Work:Pair']);
    // Never the drawer whole, never its icon (not copied), never the empty drawer STASH: did not get: what was copied.
    expect(await oneLines()).toEqual(['delete Work:Pair/a one', 'delete Work:Pair/b one', 'delete Work:Pair one']);
    // On the Amiga a file was saved into Work:Pair during the move: Transfer keeps the drawer (notempty).
    await answerAll('w1', (rid, path) => (path === 'Work:Pair' ? `ERR ${rid} notempty 19:Directory not empty` : `DONE ${rid} 1`));
    const p = (await fetchProgress(getDb(), 'o1', job, new Date()))!;
    expect(p).toMatchObject({ total: 2, done: 2, waiting: 0, failed: [] });
    expect(p.writes.find((w) => w.label === 'Work:Pair')).toMatchObject({ status: 'done', kept: true, reason: null });
    expect(p.writes.filter((w) => w.kept).length).toBe(1);
  });

  it('a labelled volume: DELETE names the device\'s path, the job the pane\'s words', async () => {
    await remember('Work:', [], 'w2');
    await remember('DF1:', [ent('y', 1)]);
    const src = 'NET:/w1/Empty (DF1:)/y';
    const r = await op({ op: 'move', sources: [src], dest: 'STASH:', onClash: 'ask' });
    expect(r).toMatchObject({ kind: 'done', fetching: { files: 1 } });
    const [g] = await gets();
    await arrive(g.id, 'DF1:y', new TextEncoder().encode('y'));
    await answerFresh();
    expect((await writes()).map((w) => [w.amigaPath, (w.target as { label: string }).label])).toEqual([['DF1:y', 'Empty (DF1:):y']]);
  });

  it('into LIBRARY:: a disk image moved is removed by one DELETE … one once the library has it', async () => {
    const { formatVolume } = await import('@/lib/adffs/format');
    const adf = formatVolume({ filesystem: 'OFS', volumeName: 'Moved' });
    const r = await op({ op: 'move', sources: [W('g.adf')], dest: 'LIBRARY:', onClash: 'ask' });
    expect(r).toMatchObject({ kind: 'done', fetching: { files: 1 } });
    const [g] = await gets();
    await arrive(g.id, 'Work:g.adf', adf);
    await answerFresh();
    expect(await oneLines()).toEqual(['delete Work:g.adf one']);
  });

  it('between volumes: the copied files, then the drawers; a drawer kept is said in the job', async () => {
    await remember('DF0:', [], 'w2');
    const r = await op({ op: 'move', sources: [W('Pair')], dest: 'NET:/w2/DF0', onClash: 'ask' });
    const job = (r as { job: { id: string } }).job.id;
    for (const g of (await gets()).sort((x, y) => x.amigaPath.localeCompare(y.amigaPath))) {
      await arrive(g.id, g.amigaPath, new TextEncoder().encode('z'));
    }
    // The empty drawer is made on the destination as a part of the move: until it is, nothing is removed.
    for (const row of await rows('w2')) await deliver(row.id, { ok: true, savedAs: row.amigaDest! }, 'w2');
    expect(await oneLines()).toEqual([]);
    await answerAll('w2', (rid) => `DONE ${rid} 1`);
    await fetchProgress(getDb(), 'o1', job, new Date());
    await answerFresh();
    expect(await oneLines()).toEqual(['delete Work:Pair/a one', 'delete Work:Pair/b one', 'delete Work:Pair/E one', 'delete Work:Pair one']);
  });

  it('protocol 4 (Transfer 2.5): a Move that copies off a volume is refused before anything is asked; Copy and a move within the volume work', async () => {
    await getDb().update(devices).set({ rxProto: 4 }).where(eq(devices.id, 'w1'));
    await remember('DF0:', [], 'w2');
    for (const dest of ['STASH:', 'NET:/w2/DF0', 'LIBRARY:']) {
      expect(await op({ op: 'move', sources: [W('x')], dest, onClash: 'ask' }), dest)
        .toMatchObject({ kind: 'refused', refusal: { code: 'unsupported', detail: 'Move needs Transfer 2.6 — use Copy' } });
    }
    expect(await gets()).toEqual([]);
    expect(await op({ op: 'copy', sources: [W('x')], dest: 'STASH:', onClash: 'ask' })).toMatchObject({ kind: 'done', fetching: { files: 1 } });
    await remember('Work:Sub', []);
    expect(await op({ op: 'move', sources: [W('x')], dest: 'NET:/w1/Work/Sub', onClash: 'ask' })).toMatchObject({ kind: 'done', job: { writes: 1 } });
  });

  // Final review I-1: a file saved again on the Amiga after it was fetched is not the one copied: it stays.
  it('a file changed on the Amiga after it was copied stays, and the job says so; the rest goes', async () => {
    const r = await op({ op: 'move', sources: [W('Pair')], dest: 'STASH:', onClash: 'ask' });
    const job = (r as { fetching: { id: string } }).fetching.id;
    for (const g of await gets()) await arrive(g.id, g.amigaPath, new TextEncoder().encode('z'));
    expect(await oneLines()).toEqual([]);
    await answerFresh('w1', { 'Work:Pair': [ent('a', 9), ent('E', 0, true), ent('b', 1)] });
    expect(await oneLines()).toEqual(['delete Work:Pair/b one', 'delete Work:Pair one']);
    const p = (await fetchProgress(getDb(), 'o1', job, new Date()))!;
    expect(p.writes.find((w) => w.label === 'Work:Pair/a')).toMatchObject({ status: 'failed',
      reason: 'Copied, but the original could not be removed — it changed on the Amiga' });
  });

  // Final review I-2: a move's last part answered with no pane watching still settles (the req route hands it on).
  it('a STASH: drawer of empty drawers moved onto a volume is removed once its Makedirs are answered', async () => {
    await remember('Work:Tools', []);
    await stash('Hollow/E', '', 'dir');
    const r = await op({ op: 'move', sources: ['STASH:/Hollow'], dest: 'NET:/w1/Work/Tools', onClash: 'ask' });
    expect(r).toMatchObject({ kind: 'done', job: { files: 0 } });
    const { afterRequestAnswered } = await import('./net-moves');
    for (const m of await takeWaiting(getDb(), 'w1')) {
      await answerPiece(getDb(), 'w1', m.id, { piece: 0, lines: [`DONE ${m.id} 1`], last: true });
      await afterRequestAnswered(getDb(), 'w1', m.id);
    }
    expect(await listStash(getDb(), 'o1')).toEqual([]);
  });

  it('Transfer went back to 2.5 before the move finished: nothing is sent, the job says why', async () => {
    const r = await op({ op: 'move', sources: [W('x')], dest: 'STASH:', onClash: 'ask' });
    const job = (r as { fetching: { id: string } }).fetching.id;
    const [g] = await gets();
    await getDb().update(devices).set({ rxProto: 4 }).where(eq(devices.id, 'w1'));
    await arrive(g.id, 'Work:x', new TextEncoder().encode('xx'));
    expect((await writes()).filter((w) => w.status === 'waiting')).toEqual([]);
    const p = (await fetchProgress(getDb(), 'o1', job, new Date()))!;
    expect(p.writes).toEqual([expect.objectContaining({ kind: 'delete', status: 'failed',
      reason: 'Copied, but the original could not be removed — Move needs Transfer 2.6 — use Copy' })]);
  });
});

describe('final review fixes: copies onto a volume', () => {
  beforeEach(async () => { await remember('Work:Tools', []); });

  it('I-3: an empty file inside a drawer is left out, the rest is copied', async () => {
    await stash('Box/full.txt', 'full');
    await stash('Box/empty.txt', '');
    const r = await op({ op: 'copy', sources: ['STASH:/Box'], dest: 'NET:/w1/Work/Tools', onClash: 'ask' });
    expect(r).toMatchObject({ kind: 'done', items: [{ source: 'STASH:/Box', ok: true }], job: { files: 1 } });
    expect((await rows()).map((x) => x.amigaDest)).toEqual(['Work:Tools/Box/full.txt']);
  });

  it('I-4: a copy the queue refuses makes no drawers on the Amiga', async () => {
    for (let i = 0; i < 33; i++) await stash(`Many2/f${i}`, `${i}`);
    await stash('Many2/Empty', '', 'dir');
    expect(await op({ op: 'copy', sources: ['STASH:/Many2'], dest: 'NET:/w1/Work/Tools', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', refusal: { code: 'queue_full' } });
    expect(await writes()).toEqual([]);
  });
});
