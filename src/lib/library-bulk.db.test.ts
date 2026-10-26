import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from 'pg';

// Library multi-select (spec 2026-10-26 §3, §8 DB): the bulk move and the bulk delete against real Postgres, in a
// database of their own (the shared one is the live one).
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_library_bulk_test';
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
const { eq, sql } = await import('drizzle-orm');
const { games, disks, blobs, entitlements } = await import('@/db/schema/catalog');
const { collections, collectionGames } = await import('@/db/schema/collections');
const { devices } = await import('@/db/schema/devices');
const { diskVersions, diskWriteSessions } = await import('@/db/schema/disk-history');
const { moveGamesToCollection } = await import('./collections');
const { deleteGames } = await import('./disk-delete');

const ORG = 'org-bulk';
const OTHER = 'org-bulk-other';
const NOW = Date.UTC(2026, 9, 26, 12);
const sha = (n: number) => String(n).padStart(64, '0');

/** A title with one disk per entry of `shas` (disk ids `<id>-d1`, `<id>-d2`, …), its blobs and its entitlements. */
async function seedTitle(id: string, org: string, shas: number[]) {
  const db = getDb();
  await db.insert(games).values({ id, orgId: org, title: `T ${id}`, sortTitle: `t ${id}`, year: 1990 });
  for (const [i, n] of shas.entries()) {
    await db.insert(blobs).values({ sha256: sha(n), sizeBytes: 100, storageKey: sha(n) }).onConflictDoNothing();
    await db.insert(disks).values({ id: `${id}-d${i + 1}`, gameId: id, orgId: org, diskNo: i + 1, sha256: sha(n), sizeBytes: 100 });
    await db.insert(entitlements).values({ orgId: org, sha256: sha(n), sourceFilename: `${id}.adf` }).onConflictDoNothing();
  }
}
async function coll(id: string, org: string, members: string[] = []) {
  await getDb().insert(collections).values({ id, orgId: org, name: `C ${id}` });
  if (members.length > 0) {
    await getDb().insert(collectionGames).values(members.map((gameId, i) => ({ collectionId: id, gameId, sortKey: i })));
  }
}
async function members(id: string) {
  const rows = await getDb().select({ gameId: collectionGames.gameId, sortKey: collectionGames.sortKey })
    .from(collectionGames).where(eq(collectionGames.collectionId, id))
    .orderBy(collectionGames.sortKey, collectionGames.gameId);
  return rows.map((r) => r.gameId);
}
async function sortKeys(id: string) {
  const rows = await getDb().select({ gameId: collectionGames.gameId, sortKey: collectionGames.sortKey })
    .from(collectionGames).where(eq(collectionGames.collectionId, id));
  return Object.fromEntries(rows.map((r) => [r.gameId, r.sortKey]));
}
async function board(id: string, o: Partial<typeof devices.$inferInsert> = {}) {
  await getDb().insert(devices).values({ id, orgId: ORG, name: `Board ${id}`, tokenHash: `h-${id}`, lastSeenAt: new Date(NOW), ...o });
}
const gameIds = async (org: string) =>
  (await getDb().select({ id: games.id }).from(games).where(eq(games.orgId, org)).orderBy(games.id)).map((r) => r.id);
const entitled = async (org: string) =>
  (await getDb().select({ s: entitlements.sha256 }).from(entitlements).where(eq(entitlements.orgId, org))).map((r) => r.s).sort();
const blobCount = async () => (await getDb().select({ n: sql<number>`count(*)::int` }).from(blobs))[0].n;

describe('library bulk operations (db)', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
  });
  afterAll(async () => {
    await closeDb();
    await admin(`drop database if exists ${DB} with (force)`);
  });
  beforeEach(async () => {
    await getDb().execute(sql.raw('truncate table collection_games, collections, disk_write_sessions, disk_versions, '
      + 'devices, entitlements, disks, games, blobs cascade'));
  });

  describe('moveGamesToCollection', () => {
    it('from All titles or Uncategorized: adds to the target and takes the titles out of none', async () => {
      await seedTitle('g1', ORG, [1]); await seedTitle('g2', ORG, [2]);
      await coll('cA', ORG, ['g1']); await coll('cB', ORG);
      expect(await moveGamesToCollection(ORG, ['g1', 'g2'], 'cB')).toEqual({ added: 2, alreadyThere: 0, removedFrom: 0, missing: [] });
      expect(await members('cB')).toEqual(['g1', 'g2']);
      expect(await members('cA')).toEqual(['g1']);
    });

    it('inside a collection: added to the target and removed from the one you are in', async () => {
      await seedTitle('g1', ORG, [1]); await seedTitle('g2', ORG, [2]); await seedTitle('g3', ORG, [3]);
      await coll('cA', ORG, ['g1', 'g2', 'g3']); await coll('cB', ORG);
      expect(await moveGamesToCollection(ORG, ['g1', 'g3'], 'cB', 'cA')).toEqual({ added: 2, alreadyThere: 0, removedFrom: 2, missing: [] });
      expect(await members('cA')).toEqual(['g2']);
      expect(await members('cB')).toEqual(['g1', 'g3']);
    });

    it('a title already in the target is counted, and the new ones append in request order', async () => {
      for (const id of ['g1', 'g2', 'g3', 'g9']) await seedTitle(id, ORG, [Number(id.slice(1))]);
      await coll('cB', ORG, ['g9', 'g1']);   // g9 sortKey 0, g1 sortKey 1
      expect(await moveGamesToCollection(ORG, ['g3', 'g1', 'g2'], 'cB')).toEqual({ added: 2, alreadyThere: 1, removedFrom: 0, missing: [] });
      // max(sort_key) was 1: g3 is 1 + 1 + 0, g2 is 1 + 1 + 2 (spec §3.2 step 1).
      expect(await sortKeys('cB')).toEqual({ g9: 0, g1: 1, g3: 2, g2: 4 });
    });

    it("another org's game id is reported missing and never inserted", async () => {
      await seedTitle('g1', ORG, [1]); await seedTitle('x1', OTHER, [50]);
      await coll('cB', ORG);
      expect(await moveGamesToCollection(ORG, ['x1', 'g1'], 'cB')).toEqual({ added: 1, alreadyThere: 0, removedFrom: 0, missing: ['x1'] });
      expect(await members('cB')).toEqual(['g1']);
    });

    it("another org's target or source is null, with nothing written", async () => {
      await seedTitle('g1', ORG, [1]);
      await coll('cA', ORG, ['g1']); await coll('cX', OTHER);
      expect(await moveGamesToCollection(ORG, ['g1'], 'cX')).toBeNull();
      expect(await moveGamesToCollection(ORG, ['g1'], 'cA', 'cX')).toBeNull();
      expect(await moveGamesToCollection(ORG, ['g1'], 'nope')).toBeNull();
      expect(await members('cX')).toEqual([]);
      expect(await members('cA')).toEqual(['g1']);
    });

    it('running it twice ends in the same state (Ruling 15)', async () => {
      await seedTitle('g1', ORG, [1]); await seedTitle('g2', ORG, [2]);
      await coll('cA', ORG, ['g1', 'g2']); await coll('cB', ORG);
      await moveGamesToCollection(ORG, ['g1', 'g2'], 'cB', 'cA');
      const again = await moveGamesToCollection(ORG, ['g1', 'g2'], 'cB', 'cA');
      expect(again).toEqual({ added: 0, alreadyThere: 2, removedFrom: 0, missing: [] });
      expect(await members('cA')).toEqual([]);
      expect(await members('cB')).toEqual(['g1', 'g2']);
    });

    it('a failure inside the transaction writes nothing: the add is rolled back with the remove', async () => {
      await seedTitle('g1', ORG, [1]); await seedTitle('g-boom', ORG, [2]);
      await coll('cA', ORG, ['g1', 'g-boom']); await coll('cB', ORG);
      // A trigger in THIS throwaway database only: a delete of g-boom's membership raises.
      await getDb().execute(sql.raw("create or replace function bulk_test_boom() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$"));
      await getDb().execute(sql.raw("create trigger bulk_test_boom before delete on collection_games for each row when (old.game_id = 'g-boom') execute function bulk_test_boom()"));
      try {
        await expect(moveGamesToCollection(ORG, ['g1', 'g-boom'], 'cB', 'cA')).rejects.toThrow();
        expect(await members('cB')).toEqual([]);
        expect(await members('cA')).toEqual(['g1', 'g-boom']);
      } finally {
        await getDb().execute(sql.raw('drop trigger if exists bulk_test_boom on collection_games'));
      }
    });
  });

  describe('deleteGames', () => {
    it('deletes the titles, their disks, history and memberships, and releases their entitlements', async () => {
      await seedTitle('g1', ORG, [1]); await seedTitle('g2', ORG, [2, 3]); await seedTitle('g8', ORG, [8]);
      await coll('cA', ORG, ['g1', 'g8']);
      await getDb().insert(diskVersions).values({ id: 'v1', diskId: 'g1-d1', orgId: ORG, seq: 1, kind: 'snapshot',
        blobSha256: sha(1), imageSha256: sha(1), source: 'original', sectorCount: 1760 });
      const r = await deleteGames(ORG, ['g1', 'g2'], { now: NOW });
      expect(r).toMatchObject({ deleted: ['g1', 'g2'], kept: [], missing: [], ejected: [] });
      expect(r.diskIds.sort()).toEqual(['g1-d1', 'g2-d1', 'g2-d2']);
      expect(r.releasedSha256.sort()).toEqual([sha(1), sha(2), sha(3)]);
      expect(await gameIds(ORG)).toEqual(['g8']);
      expect(await members('cA')).toEqual(['g8']);
      expect(await getDb().select().from(diskVersions)).toEqual([]);
      expect(await entitled(ORG)).toEqual([sha(8)]);
    });

    it("another org's id is untouched and reported missing, like an id that does not exist", async () => {
      await seedTitle('g1', ORG, [1]); await seedTitle('x1', OTHER, [50]);
      const r = await deleteGames(ORG, ['x1', 'g1', 'nope'], { now: NOW });
      expect(r.deleted).toEqual(['g1']);
      expect(r.missing).toEqual(['x1', 'nope']);
      expect(await gameIds(OTHER)).toEqual(['x1']);
      expect(await entitled(OTHER)).toEqual([sha(50)]);
    });

    it('a sha shared by two deleted titles is released once', async () => {
      await seedTitle('g1', ORG, [5]); await seedTitle('g2', ORG, [5]);
      const r = await deleteGames(ORG, ['g1', 'g2'], { now: NOW });
      expect(r.releasedSha256).toEqual([sha(5)]);
      expect(await entitled(ORG)).toEqual([]);
    });

    it('a sha shared with a surviving disk keeps its entitlement', async () => {
      await seedTitle('g1', ORG, [5]); await seedTitle('g9', ORG, [5]);
      const r = await deleteGames(ORG, ['g1'], { now: NOW });
      expect(r.releasedSha256).toEqual([]);
      expect(await entitled(ORG)).toEqual([sha(5)]);
    });

    it("a sha named only by a surviving disk's history keeps its entitlement", async () => {
      await seedTitle('g1', ORG, [5]); await seedTitle('g9', ORG, [9]);
      await getDb().insert(diskVersions).values({ id: 'v9', diskId: 'g9-d1', orgId: ORG, seq: 1, kind: 'snapshot',
        blobSha256: sha(5), imageSha256: sha(5), source: 'original', sectorCount: 1760 });
      await deleteGames(ORG, ['g1'], { now: NOW });
      expect(await entitled(ORG)).toEqual([sha(5), sha(9)]);
    });

    it('titles a board holds are kept, with where: DF0 mounted, DF1 pick, an open write session', async () => {
      for (const [id, n] of [['g1', 1], ['g2', 2], ['g3', 3], ['g4', 4]] as const) await seedTitle(id, ORG, [n]);
      await board('b1', { name: 'A500', desiredSha256: sha(1), desiredDiskId: 'g1-d1', mountedSha256: sha(1), mountedDiskId: 'g1-d1' });
      await board('b2', { name: 'A1200', df1DiskId: 'g2-d1' });
      await board('b3', { name: 'CD32' });
      await getDb().insert(diskWriteSessions).values({ deviceId: 'b3', mount: 1, diskId: 'g3-d1', token: 't', baseSha256: sha(3) });
      const r = await deleteGames(ORG, ['g1', 'g2', 'g3', 'g4'], { now: NOW });
      expect(r.deleted).toEqual(['g4']);
      expect(r.kept).toEqual([
        { id: 'g1', title: 'T g1', holds: [{ deviceName: 'A500', drive: 'DF0', label: 'In A500' }] },
        { id: 'g2', title: 'T g2', holds: [{ deviceName: 'A1200', drive: 'DF1', label: 'In A1200' }] },
        { id: 'g3', title: 'T g3', holds: [{ deviceName: 'CD32', drive: 'DF0', label: 'Writing on CD32' }] },
      ]);
      expect(r.ejected).toEqual([]);
      expect(await gameIds(ORG)).toEqual(['g1', 'g2', 'g3']);
      const [b1] = await getDb().select().from(devices).where(eq(devices.id, 'b1'));
      expect(b1.desiredDiskId).toBe('g1-d1');   // never ejected (Ruling 12)
      expect((await getDb().select().from(diskWriteSessions)).length).toBe(1);
    });

    it('dryRun writes nothing and returns the counts, the deletable titles in request order, kept and missing', async () => {
      await seedTitle('g1', ORG, [1]); await seedTitle('g2', ORG, [2, 3]); await seedTitle('g3', ORG, [4]);
      await board('b1', { name: 'A500', df1DiskId: 'g3-d1' });
      const p = await deleteGames(ORG, ['g2', 'g1', 'g3', 'nope'], { dryRun: true, now: NOW });
      expect(p).toEqual({
        deletable: { titles: 2, disks: 3 },
        titles: [{ id: 'g2', title: 'T g2', year: 1990 }, { id: 'g1', title: 'T g1', year: 1990 }],
        kept: [{ id: 'g3', title: 'T g3', holds: [{ deviceName: 'A500', drive: 'DF1', label: 'In A500' }] }],
        missing: ['nope'],
      });
      expect(await gameIds(ORG)).toEqual(['g1', 'g2', 'g3']);
      expect(await entitled(ORG)).toEqual([sha(1), sha(2), sha(3), sha(4)]);
    });

    it('a board holding an unselected title that shares bytes with a deleted one is not ejected (Review Focus 1)', async () => {
      await seedTitle('g1', ORG, [7]); await seedTitle('g2', ORG, [7]);
      await board('b1', { name: 'A500', desiredSha256: sha(7), desiredDiskId: 'g1-d1', mountedSha256: sha(7),
        mountedDiskId: 'g1-d1', desiredVersion: 3 });
      const r = await deleteGames(ORG, ['g2'], { now: NOW });
      expect(r.deleted).toEqual(['g2']);
      expect(r.ejected).toEqual([]);
      const [b1] = await getDb().select().from(devices).where(eq(devices.id, 'b1'));
      expect(b1).toMatchObject({ desiredDiskId: 'g1-d1', desiredSha256: sha(7), desiredVersion: 3 });
      expect(await entitled(ORG)).toEqual([sha(7)]);
    });

    it('never deletes a blob', async () => {
      await seedTitle('g1', ORG, [1]); await seedTitle('g2', ORG, [2]);
      const before = await blobCount();
      await deleteGames(ORG, ['g1', 'g2'], { now: NOW });
      expect(await blobCount()).toBe(before);
    });

    it('a second run of the same delete reports the titles missing and writes nothing (Ruling 15)', async () => {
      await seedTitle('g1', ORG, [1]);
      await deleteGames(ORG, ['g1'], { now: NOW });
      expect(await deleteGames(ORG, ['g1'], { now: NOW })).toEqual({
        deleted: [], diskIds: [], kept: [], missing: ['g1'], ejected: [], releasedSha256: [],
      });
    });
  });
});
