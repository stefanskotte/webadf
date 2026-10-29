// src/lib/files/stash-ops.db.test.ts
// STASH: writes, copies and moves between STASH: and disks, and Add to library as an op (increment 2, Task 5).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Client } from 'pg';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_files_stash_ops_test';
const url = new URL(base); url.pathname = `/${DB}`; process.env.DATABASE_URL = url.toString();
process.env.STORAGE_DIR ??= (await import('node:fs')).mkdtempSync('/tmp/webadf-files-stash-ops-');
process.env.BLOB_READ_WRITE_TOKEN = '';
async function admin(stmt: string) { const c = new Client({ connectionString: base }); await c.connect(); try { await c.query(stmt); } finally { await c.end(); } }

vi.mock('@/lib/stash-library', () => ({ addUploadToLibrary: vi.fn() }));

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { eq, max } = await import('drizzle-orm');
const { createHash } = await import('node:crypto');
const { readFileSync } = await import('node:fs');
const { games, disks, entitlements, blobs } = await import('@/db/schema/catalog');
const { organization } = await import('@/db/schema/auth');
const { devices } = await import('@/db/schema/devices');
const { amigaUploads } = await import('@/db/schema/amiga-uploads');
const { diskVersions } = await import('@/db/schema/disk-history');
const { diskStore } = await import('@/lib/storage');
const { formatVolume } = await import('@/lib/adffs/format');
const { addFile, makeDirectory } = await import('@/lib/adffs/write');
const { ROOT_BLOCK } = await import('@/lib/adffs/constants');
const { readVolume, readUsage, blocksForFile } = await import('@/lib/adffs');
const { parsePath } = await import('./path');
const { readLibraryFile } = await import('./library');
const { insertStash, listStash } = await import('@/lib/stash');
const { protectionString } = await import('@/lib/adffs/dir');
const { makeZip } = await import('@/lib/__fixtures__/make-zip');
const { addUploadToLibrary } = await import('@/lib/stash-library');
const { runOp } = await import('./ops');

const ctx = { orgId: 'o1', userId: null };
const must = (r: { ok: true; adf: Uint8Array } | { ok: false; reason: string }) => { if (!r.ok) throw new Error(r.reason); return r.adf; };
const P = (s: string) => parsePath(s)!;
const enc = (s: string) => new TextEncoder().encode(s);
const live = async () => (await listStash(getDb(), 'o1')).map((r) => r.path).sort();
const rowAt = async (path: string) => (await listStash(getDb(), 'o1')).find((r) => r.path === path);

async function put(bytes: Uint8Array) { const s = createHash('sha256').update(bytes).digest('hex'); await diskStore.put(s, bytes); return s; }
async function stash(path: string, bytes: Uint8Array, meta: { protection?: number; comment?: string; date?: Date } = {}) {
  const r = await insertStash(getDb(), 'o1', 'browser', [{ path, kind: 'file', sha256: await put(bytes), sizeBytes: bytes.length,
    date: meta.date ?? new Date(Date.UTC(2020, 0, 2)), protection: meta.protection ?? 0, comment: meta.comment ?? '' }]);
  if (!r.ok) throw new Error(r.code);
  return r.ids[0];
}

async function seedDisk(gameId: string, title: string, diskId: string, diskNo: number, adf: Uint8Array) {
  const s = createHash('sha256').update(adf).digest('hex');
  await diskStore.put(s, adf);
  const db = getDb();
  await db.insert(blobs).values({ sha256: s, sizeBytes: adf.length, storageKey: `adf/${s}` }).onConflictDoNothing();
  await db.insert(entitlements).values({ orgId: 'o1', sha256: s, sourceFilename: `${title}.adf` }).onConflictDoNothing();
  await db.insert(games).values({ id: gameId, orgId: 'o1', title, sortTitle: title.toLowerCase() }).onConflictDoNothing();
  await db.insert(disks).values({ id: diskId, gameId, orgId: 'o1', diskNo, sha256: s, sizeBytes: adf.length });
  return s;
}
async function versions(diskId: string) {
  const [r] = await getDb().select({ n: max(diskVersions.seq) }).from(diskVersions).where(eq(diskVersions.diskId, diskId));
  return r?.n ?? 0;
}
async function sha(diskId: string) {
  const [r] = await getDb().select({ sha256: disks.sha256 }).from(disks).where(eq(disks.id, diskId));
  return r.sha256;
}

beforeAll(async () => {
  await admin(`drop database if exists ${DB} with (force)`);
  await admin(`create database ${DB}`);
  await migrate(getDb(), { migrationsFolder: 'drizzle' });
  await getDb().insert(organization).values([{ id: 'o1', name: 'o1', slug: 'o1', createdAt: new Date() }, { id: 'o2', name: 'o2', slug: 'o2', createdAt: new Date() }]);
  await getDb().insert(devices).values({ id: 'dev1', orgId: 'o1', name: 'A500 bench', macAddress: 'AA:BB:CC:DD:EE:01', tokenHash: 'h1' });

  // Ruling 17: C/Assign carries the date and protection the assertions below expect.
  let adf = formatVolume({ filesystem: 'FFS', volumeName: 'SysInfo' });
  adf = must(makeDirectory(adf, ROOT_BLOCK, 'C'));
  const cBlock = (readVolume(adf) as { ok: true; root: { name: string; block: number }[] }).root.find((e) => e.name === 'C')!.block;
  adf = must(addFile(adf, cBlock, 'Assign', enc('assign!'), 0x05, { comment: 'cmd', date: new Date('1993-05-17T12:34:56Z') }));
  adf = must(addFile(adf, ROOT_BLOCK, 'ReadMe', enc('hello')));
  adf = must(makeDirectory(adf, ROOT_BLOCK, 'S'));
  await seedDisk('g1', 'SysInfo', 'd1', 1, adf);
  await seedDisk('g2', 'Turrican', 'd2', 1, formatVolume({ filesystem: 'OFS', volumeName: 'T1' }));
  let full = formatVolume({ filesystem: 'OFS', volumeName: 'Full' });
  const free = readUsage(full)!.freeBlocks;
  let size = (free - 2) * 488;
  while (blocksForFile(size, 'OFS') > free - 2) size -= 488;
  full = must(addFile(full, ROOT_BLOCK, 'Filler', new Uint8Array(size)));
  await seedDisk('g3', 'Full', 'd3', 1, full);
  await seedDisk('g4', 'Spare', 'd4', 1, formatVolume({ filesystem: 'FFS', volumeName: 'Spare' }));

  await stash('Notes.txt', enc('notes'), { protection: 0x02, comment: 'mine', date: new Date(Date.UTC(2020, 0, 2)) });
  await stash('Disk.adf', formatVolume({ filesystem: 'OFS', volumeName: 'Blank' }));
  await stash('t.zip', new Uint8Array(readFileSync('src/lib/archive/fixtures/t.zip')));
  await stash('Keep.txt', enc('keep me'));
  await stash('amiga.zip', new Uint8Array(makeZip([{ name: 'Tool', data: Buffer.from('tool'), amigaProtection: 0x42 }])));
});
afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

/** Wraps a diskStore method so a test can see how many calls were in flight at once (each held 10 ms). */
function inFlight(method: 'read' | 'stat') {
  const orig = diskStore[method].bind(diskStore) as (...a: unknown[]) => Promise<unknown>;
  let now = 0, max = 0;
  const spy = vi.spyOn(diskStore, method).mockImplementation((async (...a: unknown[]) => {
    now++; max = Math.max(max, now);
    try { await new Promise((r) => setTimeout(r, 10)); return await orig(...a); } finally { now--; }
  }) as never);
  return { max: () => max, restore: () => spy.mockRestore() };
}

describe('copies between STASH: and disks', () => {
  it('copies a disk folder into STASH:, keeping date, protection and comment', async () => {
    const r = await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/C'], dest: 'STASH:', onClash: 'ask' });
    expect(r).toMatchObject({ kind: 'done', items: [{ source: 'LIBRARY:/g1/d1/C', ok: true }], versions: [] });
    const a = (await rowAt('C/Assign'))!;
    expect([a.source, a.protection, a.comment, a.date?.toISOString()]).toEqual(['copy', 5, 'cmd', '1993-05-17T12:34:56.000Z']);
    // The bytes went to the store under their own sha-256.
    expect(new TextDecoder().decode(await diskStore.read(a.blobSha256!))).toBe('assign!');
  });
  it('copies a STASH: file onto a disk in one version, keeping its meta', async () => {
    const v = await versions('d2');
    expect((await runOp(ctx, { op: 'copy', sources: ['STASH:/Notes.txt'], dest: 'LIBRARY:/g2/d2', onClash: 'ask' })).kind).toBe('done');
    expect(await versions('d2')).toBe(v + 1);
    const f = (await readLibraryFile(ctx, P('LIBRARY:/g2/d2/Notes.txt')))!;
    expect([new TextDecoder().decode(f.bytes), f.comment, f.date?.toISOString(), f.protection])
      .toEqual(['notes', 'mine', '2020-01-02T00:00:00.000Z', protectionString(0x02)]);
    expect(await live()).toContain('Notes.txt');   // a copy leaves the original
  });
  it('copies out of an archive with the date it records', async () => {
    await runOp(ctx, { op: 'copy', sources: ['STASH:/t.zip/src/readme.txt'], dest: 'LIBRARY:/g2/d2', onClash: 'ask' });
    expect((await readLibraryFile(ctx, P('LIBRARY:/g2/d2/readme.txt')))!.date?.toISOString()).toBe('2026-09-11T14:47:48.000Z');
  });
  it('moves STASH: → disk (gone from STASH:) and disk → STASH: (one version on the source disk)', async () => {
    await runOp(ctx, { op: 'move', sources: ['STASH:/Notes.txt'], dest: 'LIBRARY:/g2/d2', onClash: 'replace' });   // d2 holds Notes.txt from the copy above
    expect(await live()).not.toContain('Notes.txt');
    const v = await versions('d1');
    await runOp(ctx, { op: 'move', sources: ['LIBRARY:/g1/d1/ReadMe'], dest: 'STASH:', onClash: 'ask' });
    expect([await versions('d1'), await readLibraryFile(ctx, P('LIBRARY:/g1/d1/ReadMe'))]).toEqual([v + 1, null]);
    expect(await live()).toContain('ReadMe');
  });
  it('a move with onClash skip leaves the source, both ways (ruling 1)', async () => {
    // STASH: → disk: d2 already holds Notes.txt.
    await stash('Notes.txt', enc('second notes'));
    const v = await versions('d2');
    const r = await runOp(ctx, { op: 'move', sources: ['STASH:/Notes.txt'], dest: 'LIBRARY:/g2/d2', onClash: 'skip' });
    expect(r).toMatchObject({ kind: 'done', items: [{ source: 'STASH:/Notes.txt', ok: true, skipped: true }] });
    expect(await live()).toContain('Notes.txt');
    expect(await versions('d2')).toBe(v);
    // disk → STASH:: STASH: already holds C.
    const v1 = await versions('d1');
    expect(await runOp(ctx, { op: 'move', sources: ['LIBRARY:/g1/d1/C'], dest: 'STASH:', onClash: 'skip' }))
      .toMatchObject({ kind: 'done', items: [{ source: 'LIBRARY:/g1/d1/C', ok: true, skipped: true }] });
    expect((await readLibraryFile(ctx, P('LIBRARY:/g1/d1/C/Assign')))).not.toBeNull();
    expect(await versions('d1')).toBe(v1);
  });
  it('a move is refused before anything is written when its source cannot be removed', async () => {
    // A held disk: nothing reaches STASH:, no version on the disk.
    await getDb().update(devices).set({ desiredSha256: await sha('d1') }).where(eq(devices.id, 'dev1'));
    const before = await live(); const v = await versions('d1');
    expect(await runOp(ctx, { op: 'move', sources: ['LIBRARY:/g1/d1/S'], dest: 'STASH:', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', status: 409, refusal: { code: 'read_only', detail: expect.stringMatching(/A500 bench/) } });
    expect([await live(), await versions('d1')]).toEqual([before, v]);
    await getDb().update(devices).set({ desiredSha256: null }).where(eq(devices.id, 'dev1'));
    // An archive member: the disk is not written.
    const s4 = await sha('d4');
    expect(await runOp(ctx, { op: 'move', sources: ['STASH:/t.zip/src/tiny.txt'], dest: 'LIBRARY:/g4/d4', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', status: 409, refusal: { code: 'read_only', detail: 'archive' } });
    expect(await sha('d4')).toBe(s4);
  });
  it('a move out of STASH: of a file still arriving, alone or in its folder, is refused before anything is written', async () => {
    await getDb().insert(amigaUploads).values({ id: 'arrX', orgId: 'o1', deviceId: 'dev1', deviceName: 'A500 bench', path: 'Incoming/part.mod',
      sizeBytes: 100, receivedBytes: 10, amigaDate: '17000.0.0', status: 'receiving', expiresAt: new Date(Date.now() + 3600_000) });
    try {
      const s4 = await sha('d4'); const v4 = await versions('d4'); const before = await live();
      for (const source of ['STASH:/Incoming/part.mod', 'STASH:/Incoming']) {
        expect(await runOp(ctx, { op: 'move', sources: [source], dest: 'LIBRARY:/g4/d4', onClash: 'replace' }), source)
          .toMatchObject({ kind: 'refused', status: 409, refusal: { code: 'unsupported', detail: 'still arriving from the Amiga' } });
      }
      expect([await sha('d4'), await versions('d4'), await live()]).toEqual([s4, v4, before]);
      expect((await rowAt('Incoming/part.mod'))!.status).toBe('receiving');
    } finally { await getDb().delete(amigaUploads).where(eq(amigaUploads.id, 'arrX')); }
  });
  it('an Amiga-made archive member keeps its protection in STASH:', async () => {
    await runOp(ctx, { op: 'copy', sources: ['STASH:/amiga.zip/Tool'], dest: 'STASH:', onClash: 'ask' });
    expect((await rowAt('Tool'))!.protection).toBe(0x42);
    await runOp(ctx, { op: 'delete', sources: ['STASH:/Tool'] });
  });
  it('a disk that does not fit refuses the whole copy from STASH:', async () => {
    const s = await sha('d3');
    expect(await runOp(ctx, { op: 'copy', sources: ['STASH:/Disk.adf'], dest: 'LIBRARY:/g3/d3', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', refusal: { code: 'disk_full' } });
    expect(await sha('d3')).toBe(s);
  });
  it('a STASH: name a disk cannot hold is refused per item, in words', async () => {
    await stash('A name far too long for any Amiga disk.txt', enc('long'));
    const r = await runOp(ctx, { op: 'copy', sources: ['STASH:/A name far too long for any Amiga disk.txt', 'STASH:/Keep.txt'], dest: 'LIBRARY:/g4/d4', onClash: 'ask' });
    expect(r).toMatchObject({ kind: 'done', items: [
      { source: 'STASH:/A name far too long for any Amiga disk.txt', ok: false, refusal: { code: 'bad_name', detail: 'too-long' } },
      { source: 'STASH:/Keep.txt', ok: true }] });
    expect(await readLibraryFile(ctx, P('LIBRARY:/g4/d4/Keep.txt'))).not.toBeNull();
  });
});

describe('inside STASH:', () => {
  it('asks on a clash and writes nothing; keep-both adds readme_1.txt', async () => {
    const before = await live();
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g2/d2/readme.txt'], dest: 'STASH:', onClash: 'ask' })).toMatchObject({ kind: 'done' });
    expect((await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g2/d2/readme.txt'], dest: 'STASH:', onClash: 'ask' })).kind).toBe('clashes');
    expect((await live()).length).toBe(before.length + 1);
    await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g2/d2/readme.txt'], dest: 'STASH:', onClash: 'keep-both' });
    expect(await live()).toContain('readme_1.txt');
  });
  it('skip says skipped, on a copy and on a move, and the move keeps its source', async () => {
    await runOp(ctx, { op: 'makedir', dest: 'STASH:', name: 'SkipDir' });
    expect(await runOp(ctx, { op: 'copy', sources: ['STASH:/readme.txt'], dest: 'STASH:/SkipDir', onClash: 'ask' })).toMatchObject({ kind: 'done' });
    const before = await live();
    expect(await runOp(ctx, { op: 'copy', sources: ['STASH:/readme.txt'], dest: 'STASH:/SkipDir', onClash: 'skip' }))
      .toMatchObject({ kind: 'done', items: [{ source: 'STASH:/readme.txt', ok: true, skipped: true }] });
    expect(await runOp(ctx, { op: 'move', sources: ['STASH:/readme.txt'], dest: 'STASH:/SkipDir', onClash: 'skip' }))
      .toMatchObject({ kind: 'done', items: [{ source: 'STASH:/readme.txt', ok: true, skipped: true }] });
    expect(await live()).toEqual(before);
    await runOp(ctx, { op: 'delete', sources: ['STASH:/SkipDir'] });
  });
  it('replace swaps the clashing entry in one go', async () => {
    const old = (await rowAt('Keep.txt'))!;
    await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g2/d2/readme.txt'], dest: 'STASH:/Keep.txt', onClash: 'ask' })
      .then((r) => expect(r).toMatchObject({ kind: 'refused', status: 404 }));   // a file is not a folder to write into
    const was = (await rowAt('readme.txt'))!.id;
    const r = await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g2/d2/readme.txt'], dest: 'STASH:', onClash: 'replace' });
    expect(r.kind).toBe('done');
    expect((await live()).filter((p) => p.toLowerCase() === 'readme.txt')).toHaveLength(1);
    expect((await rowAt('readme.txt'))!.id).not.toBe(was);
    expect((await rowAt('Keep.txt'))!.id).toBe(old.id);
  });
  it('replace refuses when the clashing entry is or holds the source, as LIBRARY: does', async () => {
    const before = await live();
    expect(await runOp(ctx, { op: 'copy', sources: ['STASH:/Keep.txt'], dest: 'STASH:', onClash: 'replace' }))
      .toMatchObject({ kind: 'done', items: [{ ok: false, refusal: { code: 'name_exists', detail: 'same file' } }] });
    await stash('Same/Same', enc('inner'));
    expect(await runOp(ctx, { op: 'copy', sources: ['STASH:/Same/Same'], dest: 'STASH:', onClash: 'replace' }))
      .toMatchObject({ kind: 'done', items: [{ ok: false, refusal: { code: 'cycle' } }] });
    expect(await runOp(ctx, { op: 'move', sources: ['STASH:/Same/Same'], dest: 'STASH:', onClash: 'replace' }))
      .toMatchObject({ kind: 'done', items: [{ ok: false, refusal: { code: 'cycle' } }] });
    expect(await live()).toEqual([...before, 'Same/Same'].sort());
    await runOp(ctx, { op: 'delete', sources: ['STASH:/Same'] });
  });
  it('replace never deletes a file still arriving from the Amiga', async () => {
    await getDb().insert(amigaUploads).values({ id: 'arr3', orgId: 'o1', deviceId: 'dev1', deviceName: 'A500 bench', path: 'S/late.mod',
      sizeBytes: 100, receivedBytes: 10, amigaDate: '17000.0.0', status: 'receiving', expiresAt: new Date(Date.now() + 3600_000) });
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/S'], dest: 'STASH:', onClash: 'replace' }))
      .toMatchObject({ kind: 'done', items: [{ ok: false, refusal: { code: 'unsupported', detail: 'still arriving from the Amiga' } }] });
    const [row] = await getDb().select().from(amigaUploads).where(eq(amigaUploads.id, 'arr3'));
    expect(row.status).toBe('receiving');
    await runOp(ctx, { op: 'delete', sources: ['STASH:/S'] });
  });
  it('a copy out of an archive stores its members side by side, all before any row', async () => {
    await runOp(ctx, { op: 'makedir', dest: 'STASH:', name: 'Par' });
    const stats = inFlight('stat');
    try {
      expect(await runOp(ctx, { op: 'copy', sources: ['STASH:/t.zip/src'], dest: 'STASH:/Par', onClash: 'ask' }))
        .toMatchObject({ kind: 'done', items: [{ ok: true }] });
      expect(stats.max()).toBeGreaterThan(1);
    } finally { stats.restore(); }
    expect((await live()).filter((p) => p.startsWith('Par/'))).toEqual(['Par/src', 'Par/src/noise.bin', 'Par/src/readme.txt', 'Par/src/sub', 'Par/src/sub/deep.txt', 'Par/src/tiny.txt']);
    await runOp(ctx, { op: 'delete', sources: ['STASH:/Par'] });
  });
  it('a copy inside STASH: reuses the blob, no new bytes', async () => {
    await runOp(ctx, { op: 'makedir', dest: 'STASH:', name: 'Dup' });
    await runOp(ctx, { op: 'copy', sources: ['STASH:/Keep.txt'], dest: 'STASH:/Dup', onClash: 'ask' });
    expect((await rowAt('Dup/Keep.txt'))!.blobSha256).toBe((await rowAt('Keep.txt'))!.blobSha256);
    await runOp(ctx, { op: 'delete', sources: ['STASH:/Dup'] });
  });
  it('makedir, rename a folder (its files follow), protect, comment, delete', async () => {
    await runOp(ctx, { op: 'makedir', dest: 'STASH:', name: 'Box' });
    expect(await runOp(ctx, { op: 'makedir', dest: 'STASH:', name: 'box' })).toMatchObject({ kind: 'refused', status: 409, refusal: { code: 'name_exists' } });
    await runOp(ctx, { op: 'move', sources: ['STASH:/readme_1.txt'], dest: 'STASH:/Box', onClash: 'ask' });
    await runOp(ctx, { op: 'rename', source: 'STASH:/Box', name: 'Crate' });
    expect(await live()).toEqual(expect.arrayContaining(['Crate', 'Crate/readme_1.txt']));
    expect(await live()).not.toContain('readme_1.txt');
    await runOp(ctx, { op: 'protect', sources: ['STASH:/Crate/readme_1.txt'], protection: 0x0f });
    await runOp(ctx, { op: 'comment', source: 'STASH:/Crate/readme_1.txt', comment: 'boxed' });
    const x = (await rowAt('Crate/readme_1.txt'))!;
    expect([x.protection, x.comment]).toEqual([0x0f, 'boxed']);
    await runOp(ctx, { op: 'delete', sources: ['STASH:/Crate'] });
    expect((await live()).filter((p) => p.startsWith('Crate'))).toEqual([]);
  });
  it('a comment on an implicit folder gives it a row of its own', async () => {
    await stash('Imp/x.txt', enc('x'));
    expect(await rowAt('Imp')).toBeUndefined();
    expect((await runOp(ctx, { op: 'comment', source: 'STASH:/imp', comment: 'held' })).kind).toBe('done');
    expect(await rowAt('Imp')).toMatchObject({ kind: 'dir', comment: 'held' });
    await runOp(ctx, { op: 'delete', sources: ['STASH:/Imp'] });
    expect((await live()).filter((p) => p.startsWith('Imp'))).toEqual([]);
  });
  it('a move onto its own folder changes nothing', async () => {
    const before = await listStash(getDb(), 'o1');
    expect(await runOp(ctx, { op: 'move', sources: ['STASH:/Keep.txt'], dest: 'STASH:', onClash: 'ask' }))
      .toMatchObject({ kind: 'done', items: [{ source: 'STASH:/Keep.txt', ok: true }] });
    expect(await listStash(getDb(), 'o1')).toEqual(before);
  });
  it('refuses a folder into itself, writes into an archive, and a bad name', async () => {
    await runOp(ctx, { op: 'makedir', dest: 'STASH:', name: 'Loop' });
    expect(await runOp(ctx, { op: 'move', sources: ['STASH:/Loop'], dest: 'STASH:/loop', onClash: 'ask' })).toMatchObject({ kind: 'refused', refusal: { code: 'cycle' } });
    expect(await runOp(ctx, { op: 'makedir', dest: 'STASH:/t.zip', name: 'x' })).toMatchObject({ kind: 'refused', status: 409, refusal: { code: 'read_only', detail: 'archive' } });
    expect(await runOp(ctx, { op: 'copy', sources: ['STASH:/Keep.txt'], dest: 'STASH:/t.zip/src', onClash: 'ask' })).toMatchObject({ kind: 'refused', status: 409, refusal: { code: 'read_only', detail: 'archive' } });
    expect(await runOp(ctx, { op: 'delete', sources: ['STASH:/t.zip/src/tiny.txt'] })).toMatchObject({ kind: 'refused', status: 409, refusal: { code: 'read_only', detail: 'archive' } });
    expect(await runOp(ctx, { op: 'rename', source: 'STASH:/Loop', name: 'a:b' })).toMatchObject({ kind: 'refused', refusal: { code: 'bad_name' } });
    expect(await runOp(ctx, { op: 'protect', sources: ['STASH:/Loop'], protection: 0x100 })).toMatchObject({ kind: 'refused', status: 400, refusal: { code: 'unsupported' } });
  });
  it('a folder with a file still arriving is not copied, renamed or moved (ruling 6)', async () => {
    await getDb().insert(amigaUploads).values({ id: 'arr2', orgId: 'o1', deviceId: 'dev1', deviceName: 'A500 bench', path: 'Loop/late.mod',
      sizeBytes: 100, receivedBytes: 10, amigaDate: '17000.0.0', status: 'receiving', expiresAt: new Date(Date.now() + 3600_000) });
    const busy = { kind: 'refused', refusal: { code: 'unsupported', detail: 'still arriving from the Amiga' } };
    expect(await runOp(ctx, { op: 'copy', sources: ['STASH:/Loop'], dest: 'LIBRARY:/g2/d2', onClash: 'ask' })).toMatchObject(busy);
    expect(await runOp(ctx, { op: 'rename', source: 'STASH:/Loop', name: 'Ring' })).toMatchObject(busy);
    await runOp(ctx, { op: 'makedir', dest: 'STASH:', name: 'Other' });
    expect(await runOp(ctx, { op: 'move', sources: ['STASH:/Loop'], dest: 'STASH:/Other', onClash: 'ask' })).toMatchObject(busy);
    expect(await live()).toEqual(expect.arrayContaining(['Loop', 'Loop/late.mod']));
  });
  it('delete takes an arriving file too', async () => {
    await runOp(ctx, { op: 'delete', sources: ['STASH:/Loop'] });
    const [row] = await getDb().select().from(amigaUploads).where(eq(amigaUploads.id, 'arr2'));
    expect(row.status).toBe('deleted');
  });
  it('over the org limit refuses the whole copy', async () => {
    const room = 500 - (await listStash(getDb(), 'o1')).length;
    await insertStash(getDb(), 'o1', 'copy', Array.from({ length: room - 2 }, (_, i) => ({ path: `Pad/p${i}`, kind: 'file' as const,
      sha256: 'b'.repeat(64), sizeBytes: 1, date: null, protection: 0, comment: '' })));
    const before = await live();
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/C', 'LIBRARY:/g1/d1/S'], dest: 'STASH:/Pad', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', status: 409, refusal: { code: 'stash_full', detail: 'STASH: holds 500 files / 256 MB; delete some first' } });
    expect(await live()).toEqual(before);
    await runOp(ctx, { op: 'delete', sources: ['STASH:/Pad'] });
  });
  it('a file over 20 MB is refused', async () => {
    const r = await runOp(ctx, { op: 'copy', sources: ['STASH:/Keep.txt'], dest: 'STASH:', onClash: 'keep-both' });
    expect(r.kind).toBe('done');
    // A 20 MB+ file only arrives from a disk image in tests through the store: fake its row's size.
    await getDb().update(amigaUploads).set({ sizeBytes: 21 * 1024 * 1024 }).where(eq(amigaUploads.path, 'Keep_1.txt'));
    expect(await runOp(ctx, { op: 'copy', sources: ['STASH:/Keep_1.txt'], dest: 'STASH:', onClash: 'keep-both' }))
      .toMatchObject({ kind: 'done', items: [{ ok: false, refusal: { code: 'too_large', detail: '20 MB per file' } }] });
    await runOp(ctx, { op: 'delete', sources: ['STASH:/Keep_1.txt'] });
  });
  it("another org's STASH: paths are not found", async () => {
    const o2 = { orgId: 'o2', userId: null };
    expect(await runOp(o2, { op: 'delete', sources: ['STASH:/C'] })).toMatchObject({ kind: 'refused', status: 404 });
    expect(await runOp(o2, { op: 'rename', source: 'STASH:/Keep.txt', name: 'Mine' })).toMatchObject({ kind: 'refused', status: 404 });
    expect(await runOp(o2, { op: 'copy', sources: ['STASH:/Keep.txt'], dest: 'STASH:', onClash: 'ask' })).toMatchObject({ kind: 'refused', status: 404 });
    expect(await runOp(o2, { op: 'add-to-library', sources: ['STASH:/Disk.adf'] }))
      .toMatchObject({ kind: 'done', items: [{ ok: false, refusal: { code: 'not_found' } }] });
    expect(await rowAt('Keep.txt')).toBeDefined();
  });
});

describe('Add to library', () => {
  it('adds a disk image and refuses a text file and an archive member, per item', async () => {
    vi.mocked(addUploadToLibrary).mockResolvedValueOnce({ ok: true, diskId: 'dX', gameId: 'gX' });
    const r = await runOp(ctx, { op: 'add-to-library', sources: ['STASH:/Disk.adf', 'STASH:/C/Assign', 'STASH:/t.zip/src/tiny.txt'] });
    expect(r).toMatchObject({ kind: 'done', added: [{ source: 'STASH:/Disk.adf', gameId: 'gX', diskId: 'dX' }], items: [
      { source: 'STASH:/Disk.adf', ok: true },
      { source: 'STASH:/C/Assign', ok: false, refusal: { code: 'not_a_disk_image' } },
      { source: 'STASH:/t.zip/src/tiny.txt', ok: false, refusal: { code: 'unsupported' } }] });
    expect(vi.mocked(addUploadToLibrary)).toHaveBeenCalledWith('o1', (await rowAt('Disk.adf'))!.id);
  });
  it('maps a refusal from the library to the item', async () => {
    vi.mocked(addUploadToLibrary).mockResolvedValueOnce({ ok: false, status: 422, error: 'refused', reason: 'already a duplicate' });
    expect(await runOp(ctx, { op: 'add-to-library', sources: ['STASH:/Disk.adf'] }))
      .toMatchObject({ kind: 'done', added: [], items: [{ ok: false, refusal: { code: 'not_a_disk_image', detail: 'already a duplicate' } }] });
  });
});
