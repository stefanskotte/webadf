// src/lib/collections-names-migration.db.test.ts
// Migration 0052 (Files 2 operator ruling R3): a library that already holds collections whose names differ only in case
// (a self-hosted one may; production held none on 2026-10-29) must still migrate. The oldest of each group keeps its
// name; each later one becomes `<name> (2)`, `<name> (3)`, ... with a suffix not already used in that org, at most 80
// characters; then the unique index makes the rule hold from there on.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_collections_0052_test';
const url = new URL(base); url.pathname = `/${DB}`; process.env.DATABASE_URL = url.toString();
async function admin(stmt: string) { const c = new Client({ connectionString: base }); await c.connect(); try { await c.query(stmt); } finally { await c.end(); } }

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { sql, eq } = await import('drizzle-orm');
const { collections } = await import('@/db/schema/collections');

const MIGRATION = 'drizzle/0052_collection_names_unique.sql';
const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 12, minute));
const nameOf = async (id: string) => (await getDb().select({ n: collections.name }).from(collections).where(eq(collections.id, id)))[0]?.n;
const LONG = 'L'.repeat(80);

beforeAll(async () => {
  await admin(`drop database if exists ${DB} with (force)`);
  await admin(`create database ${DB}`);
  await migrate(getDb(), { migrationsFolder: 'drizzle' });
  // Back to the state before 0052, with the duplicates it has to clear.
  await getDb().execute(sql`drop index collections_org_name_uq`);
  await getDb().insert(collections).values([
    // One org, three cases of one name, inserted out of age order: age decides, not insert order.
    { id: 'b-demos', orgId: 'o1', name: 'demos', createdAt: at(2) },
    { id: 'a-Demos', orgId: 'o1', name: 'Demos', createdAt: at(1) },
    { id: 'c-DEMOS', orgId: 'o1', name: 'DEMOS', createdAt: at(3) },
    // Same created_at: id breaks the tie.
    { id: 'z-games', orgId: 'o1', name: 'games', createdAt: at(5) },
    { id: 'y-Games', orgId: 'o1', name: 'Games', createdAt: at(5) },
    // Another org's Demos is not a duplicate of o1's.
    { id: 'o2-Demos', orgId: 'o2', name: 'Demos', createdAt: at(9) },
    // A suffix already used in the org (any case) is skipped.
    { id: 'i1', orgId: 'o3', name: 'Intros', createdAt: at(1) },
    { id: 'i2', orgId: 'o3', name: 'intros', createdAt: at(2) },
    { id: 'i-taken', orgId: 'o3', name: 'INTROS (2)', createdAt: at(3) },
    // 80 characters: the suffix fits by trimming the name, never by growing past 80.
    { id: 'long1', orgId: 'o3', name: LONG, createdAt: at(4) },
    { id: 'long2', orgId: 'o3', name: LONG.toLowerCase(), createdAt: at(5) },
  ]);
  for (const stmt of readFileSync(MIGRATION, 'utf8').split('--> statement-breakpoint')) {
    if (stmt.trim()) await getDb().execute(sql.raw(stmt));
  }
});
afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

describe('migration 0052: collection names unique per library, any case', () => {
  it('the oldest keeps its name; later ones get (2), (3) in age order', async () => {
    expect(await nameOf('a-Demos')).toBe('Demos');
    expect(await nameOf('b-demos')).toBe('demos (2)');
    expect(await nameOf('c-DEMOS')).toBe('DEMOS (3)');
    expect(await nameOf('y-Games')).toBe('Games');
    expect(await nameOf('z-games')).toBe('games (2)');
  });
  it("another org's same name is untouched", async () => {
    expect(await nameOf('o2-Demos')).toBe('Demos');
  });
  it('a suffix already used in the org, any case, is skipped', async () => {
    expect(await nameOf('i1')).toBe('Intros');
    expect(await nameOf('i-taken')).toBe('INTROS (2)');
    expect(await nameOf('i2')).toBe('intros (3)');
  });
  it('a renamed name stays within 80 characters', async () => {
    expect(await nameOf('long1')).toBe(LONG);
    const renamed = await nameOf('long2');
    expect(renamed).toBe(`${'l'.repeat(76)} (2)`);
    expect(renamed!.length).toBeLessThanOrEqual(80);
  });
  it('afterwards another case of a name is refused by the index; another org may still use it', async () => {
    const err = await getDb().insert(collections).values({ id: 'x', orgId: 'o1', name: 'dEmOs' }).then(() => null, (e: unknown) => e);
    expect(err).toBeTruthy();
    const cause = (err as { cause?: { code?: string; constraint?: string } }).cause;
    expect(cause?.code).toBe('23505');
    expect(cause?.constraint).toBe('collections_org_name_uq');
    await getDb().insert(collections).values({ id: 'y', orgId: 'o4', name: 'dEmOs' });
    expect(await nameOf('y')).toBe('dEmOs');
  });
});
