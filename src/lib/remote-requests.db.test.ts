import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { sql } from 'drizzle-orm';

// A database of its own (the shared one is the live one).
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_remote_requests_test';
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

// NET: volumes (spec 2026-10-30 §4.1): the request queue's table and the device columns it rests on.
describe('remote_requests schema', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
  });
  afterAll(async () => {
    await closeDb();
    await admin(`drop database if exists ${DB} with (force)`);
  });

  it('has the table and the device columns', async () => {
    const db = getDb();
    const t = await db.execute(sql`select to_regclass('public.remote_requests') as t`);
    expect(t.rows[0].t).toBe('remote_requests');
    const c = await db.execute(sql`select column_name from information_schema.columns where table_name = 'devices'
      and column_name in ('req_version','rx_proto','browse_on') order by column_name`);
    expect(c.rows.map((r) => r.column_name)).toEqual(['browse_on', 'req_version', 'rx_proto']);
  });
});
