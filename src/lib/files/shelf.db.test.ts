// src/lib/files/shelf.db.test.ts
// LIBRARY: above the disks (Files 2 §3.2): collection makedir/rename/delete, filing titles by Copy and Move, disk images
// from STASH: into the library and a collection. Membership only, org-scoped.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Client } from 'pg';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_files_shelf_test';
const url = new URL(base); url.pathname = `/${DB}`; process.env.DATABASE_URL = url.toString();
process.env.STORAGE_DIR ??= (await import('node:fs')).mkdtempSync('/tmp/webadf-files-shelf-');
process.env.BLOB_READ_WRITE_TOKEN = '';
async function admin(stmt: string) { const c = new Client({ connectionString: base }); await c.connect(); try { await c.query(stmt); } finally { await c.end(); } }

vi.mock('@/lib/stash-library', () => ({ addUploadToLibrary: vi.fn() }));

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { eq } = await import('drizzle-orm');
const { createHash } = await import('node:crypto');
const { games } = await import('@/db/schema/catalog');
const { collections, collectionGames } = await import('@/db/schema/collections');
const { organization } = await import('@/db/schema/auth');
const { diskStore } = await import('@/lib/storage');
const { formatVolume } = await import('@/lib/adffs/format');
const { insertStash, listStash } = await import('@/lib/stash');
const { addUploadToLibrary } = await import('@/lib/stash-library');
const { runOp } = await import('./ops');
const { ADDED_UNFILED } = await import('./shelf-rules');
const { refusalWords } = await import('./words');

const ctx = { orgId: 'o1', userId: null };
const members = async (c: string) => (await getDb().select({ g: collectionGames.gameId }).from(collectionGames)
  .where(eq(collectionGames.collectionId, c))).map((r) => r.g).sort();
const names = async () => (await getDb().select({ n: collections.name }).from(collections).where(eq(collections.orgId, 'o1'))).map((r) => r.n).sort();

beforeAll(async () => {
  await admin(`drop database if exists ${DB} with (force)`);
  await admin(`create database ${DB}`);
  await migrate(getDb(), { migrationsFolder: 'drizzle' });
  await getDb().insert(organization).values([{ id: 'o1', name: 'o1', slug: 'o1', createdAt: new Date() }, { id: 'o2', name: 'o2', slug: 'o2', createdAt: new Date() }]);
});
beforeEach(async () => {
  const db = getDb();
  await db.delete(collectionGames);
  await db.delete(collections);
  await db.delete(games);
  await db.insert(games).values(['g1', 'g2', 'g3'].map((id) => ({ id, orgId: 'o1', title: id.toUpperCase(), sortTitle: id })));
  await db.insert(games).values({ id: 'gx', orgId: 'o2', title: 'Theirs', sortTitle: 'theirs' });
  await db.insert(collections).values([
    { id: 'c1', orgId: 'o1', name: 'Demos', sortKey: 0 }, { id: 'c2', orgId: 'o1', name: 'Games', sortKey: 1 },
    { id: 'c9', orgId: 'o2', name: 'Theirs', sortKey: 0 },
  ]);
  await db.insert(collectionGames).values([{ collectionId: 'c1', gameId: 'g1', sortKey: 0 }, { collectionId: 'c2', gameId: 'g2', sortKey: 0 }]);
});
afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

describe('collections as folders', () => {
  it('Makedir on LIBRARY: makes a collection at the end of the list', async () => {
    const r = await runOp(ctx, { op: 'makedir', dest: 'LIBRARY:', name: '  Utilities ' });
    expect(r).toMatchObject({ kind: 'done', items: [{ ok: true }] });
    expect(await names()).toEqual(['Demos', 'Games', 'Utilities']);
    const [made] = await getDb().select().from(collections).where(eq(collections.name, 'Utilities'));
    expect(made.sortKey).toBe(2);
    expect((r as { items: { source: string }[] }).items[0].source).toBe(`LIBRARY:/${made.id}`);
  });
  it('a name clash (any case), an empty name and a collection inside a collection are refused', async () => {
    expect(await runOp(ctx, { op: 'makedir', dest: 'LIBRARY:', name: 'demos' })).toMatchObject({ kind: 'refused', refusal: { code: 'name_exists' } });
    expect(await runOp(ctx, { op: 'makedir', dest: 'LIBRARY:', name: ' ' })).toMatchObject({ kind: 'refused', refusal: { code: 'bad_name', detail: 'empty' } });
    expect(await runOp(ctx, { op: 'makedir', dest: 'LIBRARY:/c1', name: 'Sub' }))
      .toMatchObject({ kind: 'refused', refusal: { code: 'unsupported', detail: 'Collections hold titles, not folders' } });
    expect(await runOp(ctx, { op: 'makedir', dest: 'LIBRARY:/g3', name: 'Sub' }))
      .toMatchObject({ kind: 'refused', refusal: { code: 'unsupported', detail: 'Open a disk or STASH: to make a folder in it' } });
    expect(await names()).toEqual(['Demos', 'Games']);
  });
  it('Rename to its own name in another case is allowed (R3)', async () => {
    expect(await runOp(ctx, { op: 'rename', source: 'LIBRARY:/c1', name: 'DEMOS' })).toMatchObject({ kind: 'done' });
    expect(await names()).toEqual(['DEMOS', 'Games']);
  });
  it('Rename renames a collection; a clash with another is refused; a title is not renamed here', async () => {
    expect(await runOp(ctx, { op: 'rename', source: 'LIBRARY:/c1', name: 'Old demos' })).toMatchObject({ kind: 'done' });
    expect(await runOp(ctx, { op: 'rename', source: 'LIBRARY:/c1', name: 'GAMES' })).toMatchObject({ kind: 'refused', refusal: { code: 'name_exists' } });
    expect(await runOp(ctx, { op: 'rename', source: 'LIBRARY:/c1/g1', name: 'X' }))
      .toMatchObject({ kind: 'refused', refusal: { code: 'unsupported', detail: 'Rename or delete titles on the Library page' } });
    expect(await names()).toEqual(['Games', 'Old demos']);
  });
  it('Delete removes the collection and keeps its titles; a title is not deleted here', async () => {
    const r = await runOp(ctx, { op: 'delete', sources: ['LIBRARY:/c1', 'LIBRARY:/g3'] });
    expect(r).toMatchObject({ kind: 'done', items: [{ ok: true }, { ok: false, refusal: { detail: 'Rename or delete titles on the Library page' } }] });
    expect(await names()).toEqual(['Games']);
    expect((await getDb().select().from(games).where(eq(games.orgId, 'o1'))).map((g) => g.id).sort()).toEqual(['g1', 'g2', 'g3']);
  });
});

describe('filing titles by Move and Copy (D4)', () => {
  it('Move from a collection to another leaves the first; Copy files it in both', async () => {
    expect(await runOp(ctx, { op: 'move', sources: ['LIBRARY:/c1/g1'], dest: 'LIBRARY:/c2', onClash: 'ask' })).toMatchObject({ kind: 'done', items: [{ ok: true }] });
    expect(await members('c1')).toEqual([]);
    expect(await members('c2')).toEqual(['g1', 'g2']);
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/c2/g2'], dest: 'LIBRARY:/c1', onClash: 'ask' })).toMatchObject({ kind: 'done' });
    expect(await members('c1')).toEqual(['g2']);
    expect(await members('c2')).toEqual(['g1', 'g2']);
  });
  it('Move from the root files it and takes it out of nothing', async () => {
    expect(await runOp(ctx, { op: 'move', sources: ['LIBRARY:/g3'], dest: 'LIBRARY:/c1', onClash: 'ask' })).toMatchObject({ kind: 'done' });
    expect(await members('c1')).toEqual(['g1', 'g3']);
  });
  it('a move onto the collection they are listed in skips them and keeps them', async () => {
    const r = await runOp(ctx, { op: 'move', sources: ['LIBRARY:/c1/g1'], dest: 'LIBRARY:/c1', onClash: 'ask' });
    expect(r).toMatchObject({ kind: 'done', items: [{ source: 'LIBRARY:/c1/g1', ok: true, skipped: true }] });
    expect(await members('c1')).toEqual(['g1']);
  });
  it('a title already in the target is skipped; the others are filed', async () => {
    await getDb().insert(collectionGames).values({ collectionId: 'c2', gameId: 'g1', sortKey: 5 });
    const r = await runOp(ctx, { op: 'move', sources: ['LIBRARY:/c1/g1', 'LIBRARY:/g3'], dest: 'LIBRARY:/c2', onClash: 'ask' });
    expect(r).toMatchObject({ kind: 'done', items: [{ ok: true, skipped: true }, { ok: true }] });
    expect(await members('c1')).toEqual(['g1']);   // skipped: it stays where it was
    expect(await members('c2')).toEqual(['g1', 'g2', 'g3']);
  });
  it('Move to the root takes it out of that collection only; Copy to the root is refused', async () => {
    await getDb().insert(collectionGames).values({ collectionId: 'c2', gameId: 'g1', sortKey: 5 });
    expect(await runOp(ctx, { op: 'move', sources: ['LIBRARY:/c1/g1'], dest: 'LIBRARY:', onClash: 'ask' })).toMatchObject({ kind: 'done', items: [{ ok: true }] });
    expect(await members('c1')).toEqual([]);
    expect(await members('c2')).toEqual(['g1', 'g2']);
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/c2/g2'], dest: 'LIBRARY:', onClash: 'ask' }))
      .toMatchObject({ kind: 'done', items: [{ ok: false, refusal: { code: 'unsupported', detail: 'It is in the library already' } }] });
  });
  it('a collection, a disk and a title page are no filing sources or targets', async () => {
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/c1'], dest: 'LIBRARY:/c2', onClash: 'ask' }))
      .toMatchObject({ kind: 'done', items: [{ ok: false, refusal: { detail: 'A collection cannot go inside another' } }] });
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g3'], dest: 'LIBRARY:/c1/g1', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', refusal: { code: 'unsupported', detail: 'Open LIBRARY: or a collection to file titles' } });
  });
  it('filing into a foreign or deleted collection is not found and changes nothing', async () => {
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g3'], dest: 'LIBRARY:/c9', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', refusal: { code: 'not_found' } });
    await getDb().delete(collections).where(eq(collections.id, 'c2'));
    expect(await runOp(ctx, { op: 'move', sources: ['LIBRARY:/c1/g1'], dest: 'LIBRARY:/c2', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', refusal: { code: 'not_found' } });
    expect(await members('c1')).toEqual(['g1']);
    expect(await getDb().select().from(collectionGames).where(eq(collectionGames.collectionId, 'c9'))).toEqual([]);
    // Another org's title is not filed either.
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/gx'], dest: 'LIBRARY:/c1', onClash: 'ask' }))
      .toMatchObject({ kind: 'done', items: [{ ok: false, refusal: { code: 'not_found' } }] });
    expect(await members('c1')).toEqual(['g1']);
  });
});

describe('disk images from STASH: into the library (R4)', () => {
  async function stashImage(path: string) {
    const bytes = formatVolume({ filesystem: 'FFS', volumeName: 'Img' });
    const sha = createHash('sha256').update(bytes).digest('hex');
    await diskStore.put(sha, bytes);
    const r = await insertStash(getDb(), 'o1', 'browser', [{ path, kind: 'file', sha256: sha, sizeBytes: bytes.length, date: null, protection: 0, comment: '' }]);
    if (!r.ok) throw new Error(r.code);
  }
  it('Copy onto a collection adds the disk and files its title there; the STASH: file stays', async () => {
    await stashImage('Img.adf');
    vi.mocked(addUploadToLibrary).mockResolvedValueOnce({ ok: true, gameId: 'g3', diskId: 'd3' });
    const r = await runOp(ctx, { op: 'copy', sources: ['STASH:/Img.adf'], dest: 'LIBRARY:/c1', onClash: 'ask' });
    expect(r).toMatchObject({ kind: 'done', items: [{ ok: true }], added: [{ source: 'STASH:/Img.adf', gameId: 'g3', diskId: 'd3' }] });
    expect(await members('c1')).toEqual(['g1', 'g3']);
    expect((await listStash(getDb(), 'o1')).some((x) => x.path === 'Img.adf')).toBe(true);
  });
  it('Move onto the root adds it and deletes the STASH: file', async () => {
    await stashImage('Mv.adf');
    vi.mocked(addUploadToLibrary).mockResolvedValueOnce({ ok: true, gameId: 'g3', diskId: 'd3' });
    expect(await runOp(ctx, { op: 'move', sources: ['STASH:/Mv.adf'], dest: 'LIBRARY:', onClash: 'ask' })).toMatchObject({ kind: 'done', items: [{ ok: true }] });
    expect((await listStash(getDb(), 'o1')).some((x) => x.path === 'Mv.adf')).toBe(false);
  });
  it('a collection deleted meanwhile: not found, not counted as added, the STASH: file kept; the disk stays in the library unfiled', async () => {
    await stashImage('Gone.adf');
    vi.mocked(addUploadToLibrary).mockImplementationOnce(async () => {
      await getDb().delete(collections).where(eq(collections.id, 'c1'));   // another tab deletes it while the disk goes in
      return { ok: true, gameId: 'g3', diskId: 'd3' };
    });
    const r = await runOp(ctx, { op: 'move', sources: ['STASH:/Gone.adf'], dest: 'LIBRARY:/c1', onClash: 'ask' });
    expect(r).toMatchObject({ kind: 'done', items: [{ ok: false, refusal: { code: 'not_found', detail: ADDED_UNFILED } }] });
    expect(r).not.toHaveProperty('added');
    expect((await listStash(getDb(), 'o1')).some((x) => x.path === 'Gone.adf')).toBe(true);
    expect(refusalWords('not_found', ADDED_UNFILED)).toBe('The collection is gone; the disk was added to the library, in no collection.');
  });
  it('an image the library already had, whose title is already in the target: skipped, not added, the STASH: file kept', async () => {
    await stashImage('Again.adf');
    vi.mocked(addUploadToLibrary).mockResolvedValueOnce({ ok: true, gameId: 'g1', diskId: 'd1', existed: true });
    const r = await runOp(ctx, { op: 'move', sources: ['STASH:/Again.adf'], dest: 'LIBRARY:/c1', onClash: 'ask' });
    expect(r).toMatchObject({ kind: 'done', items: [{ ok: true, skipped: true }] });
    expect(r).not.toHaveProperty('added');
    expect(await members('c1')).toEqual(['g1']);
    expect((await listStash(getDb(), 'o1')).some((x) => x.path === 'Again.adf')).toBe(true);
  });
  it('an image the library already had, whose title is elsewhere: filed and reported as added', async () => {
    await stashImage('Known.adf');
    vi.mocked(addUploadToLibrary).mockResolvedValueOnce({ ok: true, gameId: 'g2', diskId: 'd2', existed: true });
    const r = await runOp(ctx, { op: 'copy', sources: ['STASH:/Known.adf'], dest: 'LIBRARY:/c1', onClash: 'ask' });
    expect(r).toMatchObject({ kind: 'done', items: [{ ok: true }], added: [{ source: 'STASH:/Known.adf', gameId: 'g2' }] });
    expect((r as { items: { skipped?: true }[] }).items[0].skipped).toBeUndefined();
    expect(await members('c1')).toEqual(['g1', 'g2']);
  });
});
