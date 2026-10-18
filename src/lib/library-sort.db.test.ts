import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

// A database of its own (the shared one is the live one).
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_library_sort_test';
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
const { listGames } = await import('./queries');
const { makeSortTitle } = await import('./tosec');
type LibrarySort = import('./user-prefs-schema').LibrarySort;

const ORG = 'org-sort';
// Added in this order (createdAt ascending): B, The A, C, D.
const FIXTURE = [
  { id: 'g-b', title: 'Bravo', year: 1990, publisher: 'Zeta', disks: [100, 100] },
  { id: 'g-a', title: 'The Alpha', year: null, publisher: 'alpha soft', disks: [900] },
  { id: 'g-c', title: 'charlie', year: 1988, publisher: null, disks: [50, 50, 50] },
  { id: 'g-d', title: 'Delta', year: 1993, publisher: 'Mid', disks: [10] },
];

const ids = async (sort?: LibrarySort) =>
  (await listGames(ORG, { sort })).map((g) => g.id);

describe('library sort', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
    let t = Date.UTC(2026, 0, 1);
    let s = 0;
    for (const f of FIXTURE) {
      await getDb().insert(games).values({
        id: f.id, orgId: ORG, title: f.title, sortTitle: makeSortTitle(f.title), year: f.year, publisher: f.publisher,
        createdAt: new Date(t += 60_000),
      });
      for (const [i, size] of f.disks.entries()) {
        const sha = String(++s).padStart(64, '0');
        await getDb().insert(blobs).values({ sha256: sha, sizeBytes: size, storageKey: sha });
        await getDb().insert(disks).values({ id: `${f.id}-${i}`, gameId: f.id, orgId: ORG, diskNo: i + 1, sha256: sha, sizeBytes: size });
      }
    }
  });
  afterAll(async () => {
    await closeDb();
    await admin(`drop database if exists ${DB} with (force)`);
  });

  it("no sort is today's order: newest added first", async () => {
    expect(await ids()).toEqual(['g-d', 'g-c', 'g-a', 'g-b']);
    expect(await ids({ key: 'added', dir: 'desc' })).toEqual(['g-d', 'g-c', 'g-a', 'g-b']);
    expect(await ids({ key: 'added', dir: 'asc' })).toEqual(['g-b', 'g-a', 'g-c', 'g-d']);
  });

  it('title sorts case-insensitively and ignores a leading article', async () => {
    expect(await ids({ key: 'title', dir: 'asc' })).toEqual(['g-a', 'g-b', 'g-c', 'g-d']);
    expect(await ids({ key: 'title', dir: 'desc' })).toEqual(['g-d', 'g-c', 'g-b', 'g-a']);
  });

  it('year and publisher put the unknown last in either direction', async () => {
    expect(await ids({ key: 'year', dir: 'desc' })).toEqual(['g-d', 'g-b', 'g-c', 'g-a']);
    expect(await ids({ key: 'year', dir: 'asc' })).toEqual(['g-c', 'g-b', 'g-d', 'g-a']);
    expect(await ids({ key: 'publisher', dir: 'asc' })).toEqual(['g-a', 'g-d', 'g-b', 'g-c']);
  });

  it('size and disk count sort on the totals over all of a title\'s disks', async () => {
    expect(await ids({ key: 'size', dir: 'desc' })).toEqual(['g-a', 'g-b', 'g-c', 'g-d']);
    // A tie (one disk each) falls back to newest added first.
    expect(await ids({ key: 'disks', dir: 'desc' })).toEqual(['g-c', 'g-b', 'g-d', 'g-a']);
  });

  it('the uncategorized inbox takes the same sort', async () => {
    const u = (await listGames(ORG, { uncategorized: true, sort: { key: 'title', dir: 'asc' } })).map((g) => g.id);
    expect(u).toEqual(['g-a', 'g-b', 'g-c', 'g-d']);
  });

  it('the sort applies before the 200-row cap, not to the page after it', async () => {
    const first = (await listGames(ORG, { limit: 1, sort: { key: 'title', dir: 'asc' } })).map((g) => g.id);
    expect(first).toEqual(['g-a']);
  });
});
