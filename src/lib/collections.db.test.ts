// src/lib/collections.db.test.ts
// Collection names are unique per library, any case (Files 2 operator ruling R3): createCollection and renameCollection
// refuse a clash themselves, so every caller (the Library routes, Files' LIBRARY:) gets the same answer.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from 'pg';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_collections_names_test';
const url = new URL(base); url.pathname = `/${DB}`; process.env.DATABASE_URL = url.toString();
async function admin(stmt: string) { const c = new Client({ connectionString: base }); await c.connect(); try { await c.query(stmt); } finally { await c.end(); } }

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { eq } = await import('drizzle-orm');
const { collections } = await import('@/db/schema/collections');
const { organization } = await import('@/db/schema/auth');
const { createCollection, renameCollection, collectionNameTaken } = await import('./collections');

const names = async (org: string) => (await getDb().select({ n: collections.name }).from(collections).where(eq(collections.orgId, org))).map((r) => r.n).sort();

beforeAll(async () => {
  await admin(`drop database if exists ${DB} with (force)`);
  await admin(`create database ${DB}`);
  await migrate(getDb(), { migrationsFolder: 'drizzle' });
  await getDb().insert(organization).values([{ id: 'o1', name: 'o1', slug: 'o1', createdAt: new Date() }, { id: 'o2', name: 'o2', slug: 'o2', createdAt: new Date() }]);
});
beforeEach(async () => {
  await getDb().delete(collections);
  await getDb().insert(collections).values([
    { id: 'c1', orgId: 'o1', name: 'Demos', sortKey: 0 }, { id: 'c2', orgId: 'o1', name: 'Games', sortKey: 1 },
    { id: 'c9', orgId: 'o2', name: 'Theirs', sortKey: 0 },
  ]);
});
afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

describe('collection names are unique per library, any case (R3)', () => {
  it('collectionNameTaken: any case, trimmed, this org only, except the one named', async () => {
    expect(await collectionNameTaken('o1', 'demos')).toBe(true);
    expect(await collectionNameTaken('o1', '  DEMOS ')).toBe(true);
    expect(await collectionNameTaken('o1', 'Demos', 'c1')).toBe(false);
    expect(await collectionNameTaken('o1', 'Demos', 'c2')).toBe(true);
    expect(await collectionNameTaken('o1', 'Theirs')).toBe(false);
    expect(await collectionNameTaken('o2', 'Demos')).toBe(false);
  });
  it('createCollection refuses a clash and writes nothing; another org may use the name', async () => {
    expect(await createCollection('o1', 'GAMES')).toBe('name_exists');
    expect(await names('o1')).toEqual(['Demos', 'Games']);
    expect(await createCollection('o2', 'Games')).toMatchObject({ name: 'Games' });
    expect(await names('o2')).toEqual(['Games', 'Theirs']);
  });
  it('renameCollection refuses a clash with another; its own name in another case is allowed; a foreign id is not found', async () => {
    expect(await renameCollection('o1', 'c1', 'games')).toBe('name_exists');
    expect(await renameCollection('o1', 'c1', 'DEMOS')).toBe(true);
    expect(await names('o1')).toEqual(['DEMOS', 'Games']);
    expect(await renameCollection('o1', 'c9', 'Anything')).toBe(false);
    expect(await renameCollection('o2', 'c9', 'Demos')).toBe(true);
  });
});
