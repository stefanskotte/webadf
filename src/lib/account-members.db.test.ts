import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

// A database of its own (the shared one is the live one).
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_account_members_test';
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
const { otherMemberCount } = await import('./admin-delete');

// Self-service account delete refuses when anyone else shares the organization (A2): the count it rests on.
describe('otherMemberCount', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
    const db = getDb();
    const now = new Date();
    await db.insert(user).values(['solo', 'a', 'b', 'c', 'none'].map((id) => ({ id, name: id, email: `${id}@example.test` })));
    await db.insert(organization).values(['o-solo', 'o-shared', 'o-c'].map((id) => ({ id, name: id, slug: id, createdAt: now })));
    await db.insert(member).values([
      { id: 'm1', organizationId: 'o-solo', userId: 'solo', createdAt: now },
      { id: 'm2', organizationId: 'o-shared', userId: 'a', createdAt: now },
      { id: 'm3', organizationId: 'o-shared', userId: 'b', createdAt: now },
      // c is alone in o-c, but also in o-shared: two others there.
      { id: 'm4', organizationId: 'o-c', userId: 'c', createdAt: now },
      { id: 'm5', organizationId: 'o-shared', userId: 'c', createdAt: now },
    ]);
  });
  afterAll(async () => {
    await closeDb();
    await admin(`drop database if exists ${DB} with (force)`);
  });

  it('is 0 for the only member of their organization', async () => {
    expect(await otherMemberCount('solo')).toBe(0);
  });
  it('counts the other people in a shared organization, not the user', async () => {
    expect(await otherMemberCount('a')).toBe(2);
  });
  it('looks across every membership', async () => {
    expect(await otherMemberCount('c')).toBe(2);
  });
  it('is 0 for a user with no membership', async () => {
    expect(await otherMemberCount('none')).toBe(0);
  });
});
