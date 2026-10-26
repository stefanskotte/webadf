import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

// A database of its own (the shared one is the live one).
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_admin_counts_test';
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
const { user } = await import('@/db/schema/auth');
const { blobs } = await import('@/db/schema/catalog');
const Q = await import('./admin-queries');
const { scanStatus } = await import('./tosec-sweep');

const db = () => getDb();
const sha = (c: string) => c.repeat(64);

describe('adminCounts: newestUserAt and blobsUnchecked (C6 spec §2.2, Ruling 14)', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
  });
  afterAll(async () => {
    await closeDb();
    await admin(`drop database if exists ${DB} with (force)`);
  });

  it('an empty database: no newest user, nothing unchecked', async () => {
    const c = await Q.adminCounts();
    expect(c.newestUserAt).toBeNull();
    expect(c.blobsUnchecked).toBe(0);
  });

  it("newestUserAt is the newest account's date; blobsUnchecked is scanStatus' own unchecked", async () => {
    const now = new Date();
    await db().insert(user).values([
      { id: 'u1', name: 'Old', email: 'old@example.test', emailVerified: true, createdAt: new Date('2026-01-02T03:00:00Z'), updatedAt: now },
      { id: 'u2', name: 'New', email: 'new@example.test', emailVerified: true, createdAt: new Date('2026-10-25T23:30:00Z'), updatedAt: now },
    ]);
    await db().insert(blobs).values([
      { sha256: sha('a'), sizeBytes: 1, storageKey: sha('a') },                                                    // unchecked
      { sha256: sha('b'), sizeBytes: 1, storageKey: sha('b'), matchState: 'none', matchCheckedAt: now, hashedAt: now }, // decided
      { sha256: sha('c'), sizeBytes: 1, storageKey: sha('c'), derivedFromSha256: sha('a') },                          // a restore's copy: never counted
    ]);
    const c = await Q.adminCounts();
    expect(c.newestUserAt).toBe('2026-10-25');
    expect(c.blobsUnchecked).toBe(1);
    expect(c.blobsUnchecked).toBe((await scanStatus()).unchecked);
    expect(c.users).toBe(2);
    expect(c.blobs).toBe(3);   // the plain count is unchanged: every row
  });
});
