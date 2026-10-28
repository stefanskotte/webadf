import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { eq } from 'drizzle-orm';

// A database of its own (the shared one is the live one).
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_admin_delete_test';
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
const { user, organization, member } = await import('@/db/schema/auth');
const { games } = await import('@/db/schema/catalog');
const { collections } = await import('@/db/schema/collections');
const { devices } = await import('@/db/schema/devices');
const { deleteUserCascade } = await import('./admin-delete');

// Found in the library sharing final review (2026-10-28): the admin delete wiped the data of EVERY organization the
// user belonged to, also ones someone else is still in. Only the organizations the user is the last member of go.
describe('deleteUserCascade with a shared organization', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
    const db = getDb();
    const now = new Date();
    await db.insert(user).values(['a', 'b'].map((id) => ({ id, name: id, email: `${id}@example.test` })));
    await db.insert(organization).values(['o-a', 'o-shared'].map((id) => ({ id, name: id, slug: id, createdAt: now })));
    await db.insert(member).values([
      { id: 'm1', organizationId: 'o-a', userId: 'a', createdAt: now },
      { id: 'm2', organizationId: 'o-shared', userId: 'a', createdAt: now },
      { id: 'm3', organizationId: 'o-shared', userId: 'b', createdAt: now },
    ]);
    await db.insert(games).values([
      { id: 'g-a', orgId: 'o-a', title: 'Mine', sortTitle: 'mine' },
      { id: 'g-shared', orgId: 'o-shared', title: 'Ours', sortTitle: 'ours' },
    ]);
    await db.insert(collections).values([
      { id: 'c-a', orgId: 'o-a', name: 'Mine', sortKey: 1 },
      { id: 'c-shared', orgId: 'o-shared', name: 'Ours', sortKey: 1 },
    ]);
    await db.insert(devices).values([
      { id: 'd-a', orgId: 'o-a', name: 'A', macAddress: 'AA:BB:CC:DD:EE:01', tokenHash: 'h-a' },
      { id: 'd-shared', orgId: 'o-shared', name: 'S', macAddress: 'AA:BB:CC:DD:EE:02', tokenHash: 'h-s' },
    ]);
  });
  afterAll(async () => {
    await closeDb();
    await admin(`drop database if exists ${DB} with (force)`);
  });

  it("removes the user and their own organization's data, and leaves the shared organization's alone", async () => {
    const r = await deleteUserCascade('a');
    expect(r).toMatchObject({ games: 1, devices: 1, orgsRemoved: 1 });

    const db = getDb();
    const ids = async <T extends { id: string }>(rows: Promise<T[]>) => (await rows).map((x) => x.id).sort();
    expect(await ids(db.select({ id: user.id }).from(user))).toEqual(['b']);
    expect(await ids(db.select({ id: organization.id }).from(organization))).toEqual(['o-shared']);
    expect(await ids(db.select({ id: member.id }).from(member))).toEqual(['m3']);
    expect(await ids(db.select({ id: games.id }).from(games))).toEqual(['g-shared']);
    expect(await ids(db.select({ id: collections.id }).from(collections))).toEqual(['c-shared']);
    expect(await ids(db.select({ id: devices.id }).from(devices).where(eq(devices.orgId, 'o-shared')))).toEqual(['d-shared']);
    expect(await ids(db.select({ id: devices.id }).from(devices).where(eq(devices.orgId, 'o-a')))).toEqual([]);
  });
});
