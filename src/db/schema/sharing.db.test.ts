import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

// Library sharing schema (migration 0050): join rows cascade from both sides; remote columns on games and disks.
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_sharing_schema_test';
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
const { collections } = await import('@/db/schema/collections');
const { games, disks, blobs } = await import('@/db/schema/catalog');
const { libraryShares, libraryShareCollections, remoteLibraries } = await import('@/db/schema/sharing');

const ORG = 'org-share';
const SHA = '1'.padStart(64, '0');
const joins = (shareId: string) => getDb().select().from(libraryShareCollections).where(eq(libraryShareCollections.shareId, shareId));

describe('library sharing schema', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
  });
  afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

  it('join rows go with a deleted collection or a deleted share', async () => {
    const db = getDb();
    await db.insert(collections).values([{ id: 'c1', orgId: ORG, name: 'One' }, { id: 'c2', orgId: ORG, name: 'Two' }]);
    await db.insert(libraryShares).values({
      id: 's1', orgId: ORG, label: 'Rob', claimCodeHash: 'a'.repeat(64), claimExpiresAt: new Date(Date.now() + 864e5), createdBy: 'u1',
    });
    await db.insert(libraryShareCollections).values([{ shareId: 's1', collectionId: 'c1' }, { shareId: 's1', collectionId: 'c2' }]);
    expect(await joins('s1')).toHaveLength(2);

    await db.delete(collections).where(eq(collections.id, 'c1'));
    expect((await joins('s1')).map((r) => r.collectionId)).toEqual(['c2']);

    await db.delete(libraryShares).where(eq(libraryShares.id, 's1'));
    expect(await joins('s1')).toHaveLength(0);
    expect(await db.select().from(collections).where(eq(collections.id, 'c2'))).toHaveLength(1);
  });

  it('claim code and token hashes are unique, nulls are not', async () => {
    const db = getDb();
    const mk = (id: string, code: string | null) => ({
      id, orgId: ORG, label: id, claimCodeHash: code, claimExpiresAt: new Date(), createdBy: 'u1',
    });
    await db.insert(libraryShares).values([mk('u1', null), mk('u2', null), mk('u3', 'b'.repeat(64))]);
    await expect(db.insert(libraryShares).values(mk('u4', 'b'.repeat(64)))).rejects.toThrow();
  });

  it('a remote library can be pointed at by a game and a disk', async () => {
    const db = getDb();
    await db.insert(remoteLibraries).values({ id: 'r1', orgId: ORG, baseUrl: 'https://owner.example', tokenEnc: 'enc', name: "Rob's library", addedBy: 'u1' });
    const [r] = await db.select().from(remoteLibraries).where(eq(remoteLibraries.id, 'r1'));
    expect(r!.status).toBe('ok');
    await db.insert(blobs).values({ sha256: SHA, sizeBytes: 100, storageKey: SHA });
    await db.insert(games).values({ id: 'g1', orgId: ORG, title: 'Remote', sortTitle: 'remote', remoteLibraryId: 'r1', remoteTitleId: 'rt1' });
    await db.insert(disks).values({ id: 'd1', gameId: 'g1', orgId: ORG, diskNo: 1, sha256: SHA, sizeBytes: 100, remoteLibraryId: 'r1', remoteDiskId: 'rd1' });
    const [d] = await db.select().from(disks).where(eq(disks.id, 'd1'));
    expect(d).toMatchObject({ remoteLibraryId: 'r1', remoteDiskId: 'rd1' });
    // No cascade: the library cannot be deleted while hidden rows point at it.
    await expect(db.delete(remoteLibraries).where(eq(remoteLibraries.id, 'r1'))).rejects.toThrow();
    // Ordinary rows leave both columns null.
    await db.insert(games).values({ id: 'g2', orgId: ORG, title: 'Local', sortTitle: 'local' });
    const [g] = await db.select().from(games).where(eq(games.id, 'g2'));
    expect(g!.remoteLibraryId).toBeNull();
  });
});
