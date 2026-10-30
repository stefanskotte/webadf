// src/app/api/collections/collections-routes.db.test.ts
// The Library's collection routes under the name rule (Files 2 operator ruling R3, migration 0052): a name another of
// this library's collections has, in any case, is 409 {error:'name_exists'} on create and rename; a collection may take
// its own name in another case; another library's names do not count.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Client } from 'pg';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_collections_routes_test';
const url = new URL(base); url.pathname = `/${DB}`; process.env.DATABASE_URL = url.toString();
async function admin(stmt: string) { const c = new Client({ connectionString: base }); await c.connect(); try { await c.query(stmt); } finally { await c.end(); } }

let session = { orgId: 'o1', userId: 'u1', email: 'a@b.test' };
vi.mock('@/lib/session', () => ({ requireOrg: async () => session }));
const asOrg = (orgId: string) => { session = { ...session, orgId }; };

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { eq } = await import('drizzle-orm');
const { collections } = await import('@/db/schema/collections');
const { POST } = await import('./route');
const { PATCH } = await import('./[id]/route');

const send = (method: string, path: string, body: unknown) =>
  new Request(`http://x${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const create = (name: string) => POST(send('POST', '/api/collections', { name }));
const rename = (id: string, name: string) => PATCH(send('PATCH', `/api/collections/${id}`, { name }), { params: Promise.resolve({ id }) });
const names = async (org: string) => (await getDb().select({ n: collections.name }).from(collections).where(eq(collections.orgId, org))).map((r) => r.n).sort();

beforeAll(async () => {
  await admin(`drop database if exists ${DB} with (force)`);
  await admin(`create database ${DB}`);
  await migrate(getDb(), { migrationsFolder: 'drizzle' });
});
beforeEach(async () => {
  asOrg('o1');
  await getDb().delete(collections);
  await getDb().insert(collections).values([
    { id: 'c1', orgId: 'o1', name: 'Demos', sortKey: 0 }, { id: 'c2', orgId: 'o1', name: 'Games', sortKey: 1 },
    { id: 'c9', orgId: 'o2', name: 'Theirs', sortKey: 0 },
  ]);
});
afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

describe('collection routes: names unique per library, any case (R3)', () => {
  it('POST a name another collection has in another case: 409 name_exists, nothing written', async () => {
    const res = await create('demos');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'name_exists' });
    expect(await names('o1')).toEqual(['Demos', 'Games']);
  });
  it('POST a name only another library has: created', async () => {
    const res = await create('theirs');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: 'theirs' });
  });
  it('PATCH to another collection\'s name in another case: 409 name_exists, name kept', async () => {
    const res = await rename('c2', 'DEMOS');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'name_exists' });
    expect(await names('o1')).toEqual(['Demos', 'Games']);
  });
  it('PATCH to its own name in another case: allowed', async () => {
    const res = await rename('c1', 'DEMOS');
    expect(res.status).toBe(200);
    expect(await names('o1')).toEqual(['DEMOS', 'Games']);
  });
  it('PATCH to a name only another library has: allowed', async () => {
    const res = await rename('c1', 'THEIRS');
    expect(res.status).toBe(200);
    expect(await names('o1')).toEqual(['Games', 'THEIRS']);
  });
  it("PATCH another library's collection: 404, whatever the name", async () => {
    expect((await rename('c9', 'Demos')).status).toBe(404);
    asOrg('o2');
    expect((await rename('c9', 'Demos')).status).toBe(200);
  });
});
