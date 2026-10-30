// src/lib/files/create-adf.db.test.ts
// Create ADF in Files (Files 2 §4): a blank image into a STASH: folder, or a new title into LIBRARY: or a collection.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_files_create_adf_test';
const url = new URL(base); url.pathname = `/${DB}`; process.env.DATABASE_URL = url.toString();
process.env.STORAGE_DIR ??= (await import('node:fs')).mkdtempSync('/tmp/webadf-files-create-adf-');
process.env.BLOB_READ_WRITE_TOKEN = '';
async function admin(stmt: string) { const c = new Client({ connectionString: base }); await c.connect(); try { await c.query(stmt); } finally { await c.end(); } }

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { eq, and } = await import('drizzle-orm');
const { games, disks } = await import('@/db/schema/catalog');
const { collections, collectionGames } = await import('@/db/schema/collections');
const { organization } = await import('@/db/schema/auth');
const { readVolume } = await import('@/lib/adffs');
const { insertStash, listStash } = await import('@/lib/stash');
const { parsePath } = await import('./path');
const { stashDriver } = await import('./stash-driver');
const { runOp } = await import('./ops');

const ctx = { orgId: 'o1', userId: null };
const P = (s: string) => parsePath(s)!;
const make = (dest: string, name: string, o: Partial<{ filesystem: 'OFS' | 'FFS'; density: 'dd' | 'hd'; onClash: 'ask' | 'replace' | 'skip' | 'keep-both' }> = {}) =>
  runOp(ctx, { op: 'create-adf', dest, name, filesystem: o.filesystem ?? 'FFS', density: o.density ?? 'dd', onClash: o.onClash ?? 'ask' });

beforeAll(async () => {
  await admin(`drop database if exists ${DB} with (force)`);
  await admin(`create database ${DB}`);
  await migrate(getDb(), { migrationsFolder: 'drizzle' });
  await getDb().insert(organization).values([{ id: 'o1', name: 'o1', slug: 'o1', createdAt: new Date() }, { id: 'o2', name: 'o2', slug: 'o2', createdAt: new Date() }]);
  await getDb().insert(collections).values([{ id: 'c1', orgId: 'o1', name: 'Demos', sortKey: 0 }, { id: 'c9', orgId: 'o2', name: 'Theirs', sortKey: 0 }]);
  await runOp(ctx, { op: 'makedir', dest: 'STASH:', name: 'Disks' });
});
afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

describe('Create ADF in STASH:', () => {
  it('writes <Name>.adf, a blank formatted image with that volume name, in the folder', async () => {
    const r = await make('STASH:/Disks', 'Work', { filesystem: 'OFS' });
    expect(r).toMatchObject({ kind: 'done', items: [{ source: 'STASH:/Disks/Work.adf', ok: true }] });
    const f = (await stashDriver.read(ctx, P('STASH:/Disks/Work.adf')))!;
    expect(f.bytes.length).toBe(901120);
    const v = readVolume(f.bytes);
    expect(v.ok && v.volume.name).toBe('Work');
    expect(v.ok && v.volume.filesystem).toBe('OFS');
    const row = (await listStash(getDb(), 'o1')).find((x) => x.path === 'Disks/Work.adf')!;
    expect(row.source).toBe('copy');   // R6: no "dropped" mark
  });
  it('a clash follows the setting: ask answers clashes, keep-both makes Work_1.adf, skip writes nothing', async () => {
    expect(await make('STASH:/Disks', 'Work')).toMatchObject({ kind: 'clashes', clashes: [{ name: 'Work.adf' }] });
    expect(await make('STASH:/Disks', 'Work', { onClash: 'keep-both' })).toMatchObject({ kind: 'done', items: [{ source: 'STASH:/Disks/Work_1.adf', ok: true }] });
    expect(await make('STASH:/Disks', 'Work', { onClash: 'skip' })).toMatchObject({ kind: 'done', items: [{ ok: true, skipped: true }] });
  });
  it('a bad volume name, an archive and NET: are refused', async () => {
    expect(await make('STASH:', 'a:b')).toMatchObject({ kind: 'refused', refusal: { code: 'bad_name' } });
    expect(await make('STASH:', 'x'.repeat(31))).toMatchObject({ kind: 'refused', refusal: { code: 'bad_name', detail: 'too-long' } });
    expect(await make('NET:', 'Work')).toMatchObject({ kind: 'refused', refusal: { code: 'unsupported', detail: 'Disks are made in STASH: or LIBRARY:' } });
  });
  it('Create ADF over the STASH: limit stores nothing', async () => {
    const room = 500 - (await listStash(getDb(), 'o1')).length;
    await insertStash(getDb(), 'o1', 'copy', Array.from({ length: room }, (_, i) => ({ path: `Pad/p${i}`, kind: 'file' as const,
      sha256: 'b'.repeat(64), sizeBytes: 1, date: null, protection: 0, comment: '' })));
    const before = (await listStash(getDb(), 'o1')).length;
    expect(await make('STASH:', 'Full')).toMatchObject({ kind: 'refused', status: 409, refusal: { code: 'stash_full' } });
    expect((await listStash(getDb(), 'o1')).length).toBe(before);
    await runOp(ctx, { op: 'delete', sources: ['STASH:/Pad'] });
  });
  it('over the 256 MB limit: refused with the limit named, nothing stored', async () => {
    const used = (await listStash(getDb(), 'o1')).filter((r) => r.status !== 'failed').reduce((a, r) => a + r.sizeBytes, 0);
    await insertStash(getDb(), 'o1', 'copy', [{ path: 'Big', kind: 'file', sha256: 'b'.repeat(64), sizeBytes: 256 * 1024 * 1024 - used - 1000,
      date: null, protection: 0, comment: '' }]);
    const before = (await listStash(getDb(), 'o1')).length;
    expect(await make('STASH:', 'Full')).toMatchObject({ kind: 'refused', status: 409,
      refusal: { code: 'stash_full', detail: 'STASH: holds 500 files / 256 MB; delete some first' } });
    expect((await listStash(getDb(), 'o1')).length).toBe(before);
    await runOp(ctx, { op: 'delete', sources: ['STASH:/Big'] });
  });
  it('the name is trimmed: " Trim " makes Trim.adf with the volume name Trim (Task 6 review)', async () => {
    expect(await make('STASH:/Disks', ' Trim ')).toMatchObject({ kind: 'done', items: [{ source: 'STASH:/Disks/Trim.adf', ok: true }] });
    const v = readVolume((await stashDriver.read(ctx, P('STASH:/Disks/Trim.adf')))!.bytes);
    expect(v.ok && v.volume.name).toBe('Trim');
    expect(await make('STASH:', '   ')).toMatchObject({ kind: 'refused', refusal: { code: 'bad_name', detail: 'empty' } });
  });
  it('inside an archive: refused read-only, nothing stored', async () => {
    await insertStash(getDb(), 'o1', 'copy', [{ path: 'Box.lha', kind: 'file', sha256: 'c'.repeat(64), sizeBytes: 10, date: null, protection: 0, comment: '' }]);
    const before = (await listStash(getDb(), 'o1')).length;
    expect(await make('STASH:/Box.lha', 'X')).toMatchObject({ kind: 'refused', refusal: { code: 'read_only', detail: 'archive' } });
    expect((await listStash(getDb(), 'o1')).length).toBe(before);
    await runOp(ctx, { op: 'delete', sources: ['STASH:/Box.lha'] });
  });
});

describe('Create ADF in LIBRARY:', () => {
  it('at the root: a new uncategorized title with one blank disk, named by the volume', async () => {
    const r = await make('LIBRARY:', 'Scratch', { density: 'hd' });
    expect(r.kind).toBe('done');
    const { added, items } = r as { added: { gameId: string; diskId: string }[]; items: { source: string }[] };
    expect(items[0].source).toBe(`LIBRARY:/${added[0].gameId}`);
    const [g] = await getDb().select().from(games).where(eq(games.id, added[0].gameId));
    expect(g).toMatchObject({ orgId: 'o1', title: 'Scratch', authored: true });
    const [d] = await getDb().select().from(disks).where(eq(disks.id, added[0].diskId));
    expect(d.sizeBytes).toBe(1802240);
    expect(await getDb().select().from(collectionGames).where(eq(collectionGames.gameId, g.id))).toEqual([]);
  });
  it('inside a collection: the same, filed there, its path under the collection', async () => {
    const r = await make('LIBRARY:/c1', 'Filed');
    const { added, items } = r as { added: { gameId: string }[]; items: { source: string }[] };
    expect(items[0].source).toBe(`LIBRARY:/c1/${added[0].gameId}`);
    expect(await getDb().select().from(collectionGames).where(and(eq(collectionGames.collectionId, 'c1'), eq(collectionGames.gameId, added[0].gameId)))).toHaveLength(1);
  });
  it('the title is named by the trimmed name', async () => {
    const r = await make('LIBRARY:', '  Work  ');
    const { added } = r as { added: { gameId: string }[] };
    const [g] = await getDb().select().from(games).where(eq(games.id, added[0].gameId));
    expect(g.title).toBe('Work');
  });
  it('a title, a disk, a foreign collection: refused, nothing made', async () => {
    const before = (await getDb().select().from(games)).length;
    const [g] = await getDb().select().from(games).limit(1);
    expect(await make(`LIBRARY:/${g.id}`, 'X')).toMatchObject({ kind: 'refused', refusal: { detail: 'Go up to the library or a collection' } });
    expect(await make('LIBRARY:/c9', 'X')).toMatchObject({ kind: 'refused', refusal: { code: 'not_found' } });
    expect((await getDb().select().from(games)).length).toBe(before);
  });
  it('a stale link: a title or disk that does not exist is not_found, not "go up"; a real one still says go up', async () => {
    const before = (await getDb().select().from(games)).length;
    const [g] = await getDb().select().from(games).limit(1);
    const [d] = await getDb().select().from(disks).where(eq(disks.gameId, g.id)).limit(1);
    expect(await make('LIBRARY:/gone-title/gone-disk', 'X')).toMatchObject({ kind: 'refused', refusal: { code: 'not_found' } });
    expect(await make(`LIBRARY:/${g.id}/gone-disk`, 'X')).toMatchObject({ kind: 'refused', refusal: { code: 'not_found' } });
    if (d) expect(await make(`LIBRARY:/${g.id}/${d.id}`, 'X')).toMatchObject({ kind: 'refused', refusal: { detail: 'Go up to the library or a collection' } });
    expect((await getDb().select().from(games)).length).toBe(before);
  });
});
