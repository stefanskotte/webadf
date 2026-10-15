import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { sql } from 'drizzle-orm';

// A database of its own: the baseline test drops the journal and migrates the
// whole schema, which must not disturb the shared test database.
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_baseline_test';
const url = new URL(base);
url.pathname = `/${DB}`;
process.env.DATABASE_URL = url.toString();

async function admin(stmt: string) {
  const c = new Client({ connectionString: base });
  await c.connect();
  try { await c.query(stmt); } finally { await c.end(); }
}

const { getDb, closeDb } = await import('./index');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { baseline } = await import('../../scripts/db-baseline');

async function journal() {
  const { rows } = await getDb().execute(sql`select hash, created_at::text as created_at from drizzle.__drizzle_migrations order by id`);
  return rows as { hash: string; created_at: string }[];
}

describe('db:baseline', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
  });
  afterAll(async () => {
    await closeDb();
    await admin(`drop database if exists ${DB} with (force)`);
  });

  it('writes exactly the journal the migrator writes, refuses a second time, and leaves migrate nothing to do', async () => {
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
    const migrated = await journal();
    expect(migrated.length).toBeGreaterThanOrEqual(39);

    // Same table DDL as the migrator's (drizzle-orm pg-core dialect.migrate).
    const ddlBefore = await getDb().execute(sql`select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'drizzle' and table_name = '__drizzle_migrations' order by ordinal_position`);

    await getDb().execute(sql`drop schema drizzle cascade`);
    const dry = await baseline({ apply: false });
    expect(dry.rows).toHaveLength(migrated.length);
    const noJournal = await getDb().execute(sql`select to_regclass('drizzle.__drizzle_migrations') is null as gone`);
    expect(noJournal.rows[0].gone).toBe(true); // a dry run writes nothing

    await baseline({ apply: true });
    expect(await journal()).toEqual(migrated);
    const ddlAfter = await getDb().execute(sql`select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'drizzle' and table_name = '__drizzle_migrations' order by ordinal_position`);
    expect(ddlAfter.rows).toEqual(ddlBefore.rows);

    await expect(baseline({ apply: true })).rejects.toThrow('journal already exists');
    expect(await journal()).toEqual(migrated);

    // If migrate re-ran anything, 0000's CREATE TABLEs would throw; the
    // unchanged journal proves it recorded nothing either.
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
    expect(await journal()).toEqual(migrated);
  });
});
