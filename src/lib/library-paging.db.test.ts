import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

// A database of its own (the shared one is the live one).
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_library_paging_test';
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
const { games, disks, blobs } = await import('@/db/schema/catalog');
const { collections, collectionGames } = await import('@/db/schema/collections');
const { listGames, countGames } = await import('./queries');
const { listCollectionGameIds } = await import('./collections');
const { makeSortTitle } = await import('./tosec');

const ORG = 'org-paging';
const OTHER = 'org-other';
// 210 titles, past the old 200 cap: g-000 (oldest) .. g-209 (newest), each with one disk; g-000..g-004 also have a
// second disk. g-000..g-009 are in collection c-1, in reverse order of their ids (a hand-made order).
const N = 210;
const id = (i: number) => `g-${String(i).padStart(3, '0')}`;

describe('library paging (queries)', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
    const db = getDb();
    const t0 = Date.UTC(2026, 0, 1);
    await db.insert(games).values(Array.from({ length: N }, (_, i) => ({
      id: id(i), orgId: ORG, title: `Title ${i}`, sortTitle: makeSortTitle(`Title ${i}`), createdAt: new Date(t0 + i * 60_000),
    })));
    // Another tenant's title: never counted, never listed.
    await db.insert(games).values({ id: 'x-1', orgId: OTHER, title: 'Other', sortTitle: 'other' });
    const shas: string[] = [];
    const rows: (typeof disks.$inferInsert)[] = [];
    for (let i = 0; i < N; i++) {
      for (let d = 0; d < (i < 5 ? 2 : 1); d++) {
        const sha = String(shas.length + 1).padStart(64, '0');
        shas.push(sha);
        rows.push({ id: `${id(i)}-${d}`, gameId: id(i), orgId: ORG, diskNo: d + 1, sha256: sha, sizeBytes: 100 });
      }
    }
    await db.insert(blobs).values(shas.map((sha) => ({ sha256: sha, sizeBytes: 100, storageKey: sha })));
    await db.insert(disks).values(rows);
    await db.insert(collections).values({ id: 'c-1', orgId: ORG, name: 'Ten' });
    await db.insert(collectionGames).values(Array.from({ length: 10 }, (_, i) => ({ collectionId: 'c-1', gameId: id(i), sortKey: 10 - i })));
  });
  afterAll(async () => {
    await closeDb();
    await admin(`drop database if exists ${DB} with (force)`);
  });

  it('a page is the slice of the sorted library at its offset', async () => {
    const p1 = await listGames(ORG, { limit: 48, offset: 0 });
    const p2 = await listGames(ORG, { limit: 48, offset: 48 });
    expect(p1.map((g) => g.id)).toEqual(Array.from({ length: 48 }, (_, k) => id(N - 1 - k)));   // newest first
    expect(p2[0].id).toBe(id(N - 1 - 48));
    expect(p2).toHaveLength(48);
  });

  it('the last page holds what is left', async () => {
    const last = await listGames(ORG, { limit: 48, offset: 192 });
    expect(last.map((g) => g.id)).toEqual(Array.from({ length: 18 }, (_, k) => id(17 - k)));
  });

  it('no limit is every title -- the old silent 200 cap is gone', async () => {
    expect(await listGames(ORG, { limit: null })).toHaveLength(N);
  });

  it('a collection pages in its own hand-made order', async () => {
    const p = await listGames(ORG, { collectionId: 'c-1', limit: 4, offset: 4 });
    expect(p.map((g) => g.id)).toEqual([id(5), id(4), id(3), id(2)]);
  });

  it('the inbox pages too', async () => {
    const p = await listGames(ORG, { uncategorized: true, limit: 5, offset: 195 });
    expect(p.map((g) => g.id)).toEqual([id(14), id(13), id(12), id(11), id(10)]);
  });

  it('counts titles and disks of the whole view, not of one page, and only this org', async () => {
    expect(await countGames(ORG, {})).toEqual({ titles: N, disks: N + 5 });
    expect(await countGames(ORG, { collectionId: 'c-1' })).toEqual({ titles: 10, disks: 15 });
    expect(await countGames(ORG, { uncategorized: true })).toEqual({ titles: N - 10, disks: N - 10 });
    expect(await countGames(OTHER, {})).toEqual({ titles: 1, disks: 0 });
  });

  it("a collection's full order, for dragging inside one page", async () => {
    expect(await listCollectionGameIds(ORG, 'c-1')).toEqual(Array.from({ length: 10 }, (_, k) => id(9 - k)));
    expect(await listCollectionGameIds(OTHER, 'c-1')).toEqual([]);   // another tenant learns nothing
  });
});
