import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_share_scope_test';
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
const { collections, collectionGames } = await import('@/db/schema/collections');
const { games, disks, blobs } = await import('@/db/schema/catalog');
const { remoteLibraries } = await import('@/db/schema/sharing');
const store = await import('./store');
const scope = await import('./scope');

async function shareFor(orgId: string, input: { everything: boolean; collectionIds: string[] }) {
  const r = await store.createShare(orgId, 'u1', { label: 'Rob', ...input });
  if (!r.ok) throw new Error(r.reason);
  const c = await store.claimShare(r.code, { url: 'https://r.example', name: 'R' });
  if (!c.ok) throw new Error('claim');
  const auth = await store.authenticateShare(`Bearer ${c.token}`);
  if (!auth) throw new Error('auth');
  return auth;
}

describe('share scope', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    const db = getDb();
    await migrate(db, { migrationsFolder: 'drizzle' });
    await db.insert(collections).values([
      { id: 'cs', orgId: 'o1', name: 'Shared' },
      { id: 'cu', orgId: 'o1', name: 'Unshared' },
      { id: 'cz', orgId: 'o2', name: 'Other' },
    ]);
    await db.insert(remoteLibraries).values({ id: 'rl1', orgId: 'o1', baseUrl: 'https://x.example', tokenEnc: 'x', name: 'X', addedBy: 'u1' });
    const g = (id: string, orgId: string, extra: Record<string, unknown> = {}) =>
      ({ id, orgId, title: id, sortTitle: id, ...extra });
    await db.insert(games).values([
      g('gs', 'o1'), g('gu', 'o1'), g('gn', 'o1'), g('gr', 'o1', { remoteLibraryId: 'rl1', remoteTitleId: 't' }), g('go', 'o2'),
    ]);
    await db.insert(blobs).values(['s1', 's2', 's3', 's4', 's5'].map((sha) => ({ sha256: sha, sizeBytes: 901120, storageKey: sha })));
    const d = (id: string, gameId: string, orgId: string, sha: string, extra: Record<string, unknown> = {}) =>
      ({ id, gameId, orgId, diskNo: 1, sha256: sha, sizeBytes: 901120, ...extra });
    await db.insert(disks).values([
      d('ds', 'gs', 'o1', 's1'), d('du', 'gu', 'o1', 's2'), d('dn', 'gn', 'o1', 's3'),
      d('dr', 'gr', 'o1', 's4', { remoteLibraryId: 'rl1', remoteDiskId: 'x' }), d('do', 'go', 'o2', 's5'),
    ]);
    await db.insert(collectionGames).values([
      { collectionId: 'cs', gameId: 'gs' }, { collectionId: 'cu', gameId: 'gu' },
      { collectionId: 'cs', gameId: 'gr' }, { collectionId: 'cz', gameId: 'go' },
    ]);
  });
  afterAll(async () => {
    await closeDb();
    await admin(`drop database if exists ${DB} with (force)`);
  });

  it('title in a shared collection is in scope; unshared and uncategorised are not', async () => {
    const auth = await shareFor('o1', { everything: false, collectionIds: ['cs'] });
    expect(await scope.titleInScope(auth, 'gs')).toBe(true);
    expect(await scope.titleInScope(auth, 'gu')).toBe(false);
    expect(await scope.titleInScope(auth, 'gn')).toBe(false);
    expect(await scope.titleInScope(auth, 'missing')).toBe(false);
    expect(await scope.scopedCollectionIds(auth)).toEqual(['cs']);
    expect(await scope.diskInScope(auth, 'ds')).toEqual({ sha256: 's1', sizeBytes: 901120, gameId: 'gs' });
    expect(await scope.diskInScope(auth, 'du')).toBeNull();
  });

  it('removing a title from the collection takes it out of scope at once (Review Focus 1)', async () => {
    const auth = await shareFor('o1', { everything: false, collectionIds: ['cs'] });
    await getDb().insert(collectionGames).values({ collectionId: 'cs', gameId: 'gn' });
    await getDb().insert(disks).values({ id: 'dn2', gameId: 'gn', orgId: 'o1', diskNo: 2, sha256: 's3', sizeBytes: 901120 });
    expect(await scope.titleInScope(auth, 'gn')).toBe(true);
    expect(await scope.diskInScope(auth, 'dn2')).not.toBeNull();
    await getDb().delete(collectionGames).where(eq(collectionGames.gameId, 'gn'));
    expect(await scope.titleInScope(auth, 'gn')).toBe(false);
    expect(await scope.diskInScope(auth, 'dn2')).toBeNull();
  });

  it('everything covers all local titles and disks, all org collections', async () => {
    const auth = await shareFor('o1', { everything: true, collectionIds: [] });
    for (const g of ['gs', 'gu', 'gn']) expect(await scope.titleInScope(auth, g)).toBe(true);
    expect(await scope.diskInScope(auth, 'dn')).not.toBeNull();
    expect((await scope.scopedCollectionIds(auth)).sort()).toEqual(['cs', 'cu']);
  });

  it('a hidden remote title or disk is never in scope, even for everything or a shared collection', async () => {
    const all = await shareFor('o1', { everything: true, collectionIds: [] });
    expect(await scope.titleInScope(all, 'gr')).toBe(false);
    expect(await scope.diskInScope(all, 'dr')).toBeNull();
    const coll = await shareFor('o1', { everything: false, collectionIds: ['cs'] });
    expect(await scope.titleInScope(coll, 'gr')).toBe(false);
    expect(await scope.diskInScope(coll, 'dr')).toBeNull();
  });

  it('another org is never in scope', async () => {
    const all = await shareFor('o1', { everything: true, collectionIds: [] });
    expect(await scope.titleInScope(all, 'go')).toBe(false);
    expect(await scope.diskInScope(all, 'do')).toBeNull();
  });
});
