import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_share_listing_test';
const url = new URL(base);
url.pathname = `/${DB}`;
process.env.DATABASE_URL = url.toString();

async function admin(stmt: string) {
  const c = new Client({ connectionString: base });
  await c.connect();
  try { await c.query(stmt); } finally { await c.end(); }
}

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { eq } = await import('drizzle-orm');
const { organization } = await import('@/db/schema/auth');
const { collections, collectionGames } = await import('@/db/schema/collections');
const { games, disks, blobs } = await import('@/db/schema/catalog');
const { remoteLibraries } = await import('@/db/schema/sharing');
const store = await import('./store');
const listing = await import('./listing');

async function shareFor(orgId: string, input: { everything: boolean; collectionIds: string[] }) {
  const r = await store.createShare(orgId, 'u1', { label: 'Rob', ...input });
  if (!r.ok) throw new Error(r.reason);
  const c = await store.claimShare(r.code, { url: 'https://r.example', name: 'R' });
  if (!c.ok) throw new Error('claim');
  const auth = await store.authenticateShare(`Bearer ${c.token}`);
  if (!auth) throw new Error('auth');
  return auth;
}

const COVER = 'c'.repeat(64);

describe('share listing', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    const db = getDb();
    await migrate(db, { migrationsFolder: 'drizzle' });
    await db.insert(organization).values({ id: 'o1', name: "Stefan's floppies", slug: 'o1', createdAt: new Date() });
    await db.insert(collections).values([
      { id: 'cs', orgId: 'o1', name: 'Shared', sortKey: 1 },
      { id: 'c2', orgId: 'o1', name: 'Second', sortKey: 2 },
      { id: 'cu', orgId: 'o1', name: 'Unshared', sortKey: 3 },
      { id: 'cz', orgId: 'o2', name: 'Other' },
    ]);
    await db.insert(remoteLibraries).values({ id: 'rl1', orgId: 'o1', baseUrl: 'https://x.example', tokenEnc: 'x', name: 'X', addedBy: 'u1' });
    const g = (id: string, title: string, orgId = 'o1', extra: Record<string, unknown> = {}) =>
      ({ id, orgId, title, sortTitle: title.toLowerCase(), ...extra });
    await db.insert(games).values([
      g('g1', 'Alpha'), g('g2', 'Beta'), g('g3', 'Gamma 100%'), g('g4', 'Delta_x'), g('g5', 'Epsilon', 'o1', { year: 1990, publisher: 'Psygnosis', coverOverrideSha256: COVER }),
      g('gu', 'Unshared'), g('gr', 'Remote', 'o1', { remoteLibraryId: 'rl1', remoteTitleId: 't' }), g('go', 'Foreign', 'o2'),
    ]);
    const shas = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'au', 'ar', 'ao'];
    await db.insert(blobs).values(shas.map((sha) => ({ sha256: sha, sizeBytes: 901120, storageKey: sha })));
    const d = (id: string, gameId: string, sha: string, diskNo = 1, orgId = 'o1', extra: Record<string, unknown> = {}) =>
      ({ id, gameId, orgId, diskNo, sha256: sha, sizeBytes: 901120, ...extra });
    await db.insert(disks).values([
      d('d1', 'g1', 'a1'), d('d2', 'g2', 'a2'), d('d3', 'g3', 'a3'), d('d4', 'g4', 'a4'),
      d('d5a', 'g5', 'a5', 1, 'o1', { label: 'Epsilon Disk 1' }),
      d('d5b', 'g5', 'a6', 2, 'o1', { imageFormat: 'hfe', extractable: false, extractReason: 'track 3' }),
      d('du', 'gu', 'au'), d('dr', 'gr', 'ar', 1, 'o1', { remoteLibraryId: 'rl1', remoteDiskId: 'x' }), d('do', 'go', 'ao', 1, 'o2'),
    ]);
    await db.insert(collectionGames).values([
      { collectionId: 'cs', gameId: 'g1' }, { collectionId: 'cs', gameId: 'g2' }, { collectionId: 'cs', gameId: 'g3' },
      { collectionId: 'cs', gameId: 'g4' }, { collectionId: 'cs', gameId: 'g5' }, { collectionId: 'c2', gameId: 'g5' },
      { collectionId: 'cs', gameId: 'gr' }, { collectionId: 'cu', gameId: 'gu' }, { collectionId: 'cz', gameId: 'go' },
    ]);
  });
  afterAll(async () => {
    await closeDb();
    await admin(`drop database if exists ${DB} with (force)`);
  });

  it('library name comes from the organization, with a fallback', async () => {
    expect(await listing.libraryName('o1')).toBe("Stefan's floppies");
    expect(await listing.libraryName('nobody')).toBe('WebFloppy library');
  });

  it('overview lists only scoped collections, and counts without remote copies', async () => {
    const auth = await shareFor('o1', { everything: false, collectionIds: ['cs', 'c2'] });
    const lib = await listing.libraryOverview(auth);
    expect(lib.name).toBe("Stefan's floppies");
    expect(lib.collections).toEqual([
      { id: 'cs', name: 'Shared', titles: 5 },
      { id: 'c2', name: 'Second', titles: 1 },
    ]);
    expect(lib.titles).toBe(5);
    expect(lib.disks).toBe(6);
  });

  it('everything: all org collections, all local titles', async () => {
    const auth = await shareFor('o1', { everything: true, collectionIds: [] });
    const lib = await listing.libraryOverview(auth);
    expect(lib.collections.map((c) => c.id)).toEqual(['cs', 'c2', 'cu']);
    expect(lib.titles).toBe(6);
    expect(lib.disks).toBe(7);
  });

  it('titles page in sort-title order with a stable cursor', async () => {
    const auth = await shareFor('o1', { everything: false, collectionIds: ['cs'] });
    const p1 = await listing.listScopedTitles(auth, { limit: 2 });
    expect(p1).not.toBeNull();
    expect(p1!.titles.map((t) => t.id)).toEqual(['g1', 'g2']);
    expect(p1!.nextCursor).not.toBeNull();
    const p2 = await listing.listScopedTitles(auth, { limit: 2, cursor: p1!.nextCursor! });
    expect(p2!.titles.map((t) => t.id)).toEqual(['g4', 'g5']);
    const p3 = await listing.listScopedTitles(auth, { limit: 2, cursor: p2!.nextCursor! });
    expect(p3!.titles.map((t) => t.id)).toEqual(['g3']);
    expect(p3!.nextCursor).toBeNull();
  });

  it('a title carries its kind, disk count, cover flag and only shared collection ids', async () => {
    const auth = await shareFor('o1', { everything: false, collectionIds: ['cs'] });
    const p = await listing.listScopedTitles(auth, { limit: 48 });
    const eps = p!.titles.find((t) => t.id === 'g5')!;
    expect(eps).toEqual({
      id: 'g5', title: 'Epsilon', year: 1990, publisher: 'Psygnosis', kind: null,
      diskCount: 2, hasCover: true, coverDigest: COVER, collectionIds: ['cs'],
    });
    expect(p!.titles.find((t) => t.id === 'g1')!.hasCover).toBe(false);
    expect(p!.titles.map((t) => t.id)).not.toContain('gr');
  });

  it('q filters by title and treats % and _ literally', async () => {
    const auth = await shareFor('o1', { everything: true, collectionIds: [] });
    expect((await listing.listScopedTitles(auth, { q: 'ALP', limit: 48 }))!.titles.map((t) => t.id)).toEqual(['g1']);
    expect((await listing.listScopedTitles(auth, { q: '%', limit: 48 }))!.titles.map((t) => t.id)).toEqual(['g3']);
    expect((await listing.listScopedTitles(auth, { q: '_', limit: 48 }))!.titles.map((t) => t.id)).toEqual(['g4']);
    expect((await listing.listScopedTitles(auth, { q: 'Remote', limit: 48 }))!.titles).toEqual([]);
  });

  it('collection filter: in scope narrows, out of scope is null', async () => {
    const auth = await shareFor('o1', { everything: false, collectionIds: ['cs', 'c2'] });
    expect((await listing.listScopedTitles(auth, { collectionId: 'c2', limit: 48 }))!.titles.map((t) => t.id)).toEqual(['g5']);
    expect(await listing.listScopedTitles(auth, { collectionId: 'cu', limit: 48 })).toBeNull();
    expect(await listing.listScopedTitles(auth, { collectionId: 'cz', limit: 48 })).toBeNull();
  });

  it('a malformed cursor is rejected', async () => {
    expect(listing.decodeCursor('not-a-cursor')).toBeNull();
    expect(listing.decodeCursor(listing.encodeCursor({ sortTitle: 'a', id: 'b' }))).toEqual({ sortTitle: 'a', id: 'b' });
  });

  it('one title with its disks; out of scope is null', async () => {
    const auth = await shareFor('o1', { everything: false, collectionIds: ['cs'] });
    const t = await listing.scopedTitle(auth, 'g5');
    expect(t!.title.id).toBe('g5');
    expect(t!.disks.map((d) => [d.id, d.name, d.diskNo, d.imageFormat, d.extractable])).toEqual([
      ['d5a', 'Epsilon Disk 1', 1, 'adf', true],
      ['d5b', 'Disk 2', 2, 'hfe', false],
    ]);
    expect(t!.disks[0].sha256).toBe('a5');
    expect(new Date(t!.disks[0].updatedAt).toISOString()).toBe(t!.disks[0].updatedAt);
    expect(await listing.scopedTitle(auth, 'gu')).toBeNull();
    expect(await listing.scopedTitle(auth, 'gr')).toBeNull();
    expect(await listing.scopedTitle(auth, 'go')).toBeNull();
  });

  it('cover source: override sha for an in-scope title, null otherwise', async () => {
    const auth = await shareFor('o1', { everything: true, collectionIds: [] });
    expect(await listing.scopedCoverSource(auth, 'g5')).toEqual({ store: 'cover', digest: COVER });
    expect(await listing.scopedCoverSource(auth, 'g1')).toBeNull();
    expect(await listing.scopedCoverSource(auth, 'go')).toBeNull();
  });

  it('scoped disk: format details in scope, null after the title leaves the collection', async () => {
    const auth = await shareFor('o1', { everything: false, collectionIds: ['c2'] });
    expect(await listing.scopedDisk(auth, 'd5b')).toEqual({
      id: 'd5b', sha256: 'a6', sizeBytes: 901120, imageFormat: 'hfe', extractable: false, extractReason: 'track 3',
    });
    await getDb().delete(collectionGames).where(eq(collectionGames.collectionId, 'c2'));
    expect(await listing.scopedDisk(auth, 'd5b')).toBeNull();
  });
});
