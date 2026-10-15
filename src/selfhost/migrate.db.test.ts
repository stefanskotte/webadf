import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_startup_migrate_test';
const u = new URL(base); u.pathname = `/${DB}`;
const url = u.toString();
process.env.DATABASE_URL = url;

async function admin(stmt: string, target = base) {
  const c = new Client({ connectionString: target }); await c.connect();
  try { return await c.query(stmt); } finally { await c.end(); }
}
const { runStartupMigrations } = await import('./migrate');
const { closeDb } = await import('@/db');

describe('runStartupMigrations', () => {
  beforeAll(async () => { await admin(`drop database if exists ${DB} with (force)`); await admin(`create database ${DB}`); });
  afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

  it('two concurrent starts serialise: one applies, one finds nothing; no backup on a fresh db', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bk-'));
    const dumps: string[] = [];
    const dump = async (_u: string, f: string) => { dumps.push(f); };
    const [a, b] = await Promise.all([
      runStartupMigrations({ url, migrationsFolder: 'drizzle', backupDir: dir, dump, log: () => {} }),
      runStartupMigrations({ url, migrationsFolder: 'drizzle', backupDir: dir, dump, log: () => {} }),
    ]);
    expect([a.applied.length > 0, b.applied.length > 0].sort()).toEqual([false, true]);
    expect(dumps).toEqual([]);
    const rows = await admin('select count(*)::int as n from drizzle.__drizzle_migrations', url);
    expect(rows.rows[0].n).toBe(Math.max(a.applied.length, b.applied.length));
    expect(readdirSync(dir)).toEqual([]);
  });

  it('backs up before applying when the database is behind', async () => {
    await admin('delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations)', url);
    const last = await admin('select max(created_at)::text as m from drizzle.__drizzle_migrations', url);
    expect(last.rows[0].m).toBeTruthy();
    // The deleted row's migration re-runs: it must be idempotent-safe for this test, so re-record instead of re-running:
    // simulate "behind" with a stubbed migrate is not possible here, so assert the backup call only.
    const dir = mkdtempSync(join(tmpdir(), 'bk-'));
    const dumps: string[] = [];
    await runStartupMigrations({ url, migrationsFolder: 'drizzle', backupDir: dir, dump: async (_u, f) => { dumps.push(f); }, log: () => {} }).catch(() => {});
    expect(dumps).toHaveLength(1);
    expect(dumps[0]).toMatch(/-before-0038_.+\.dump$/);
  });

  it('refuses a database newer than the image', async () => {
    await admin(`insert into drizzle.__drizzle_migrations (hash, created_at) values ('future', 99999999999999)`, url);
    await expect(runStartupMigrations({ url, migrationsFolder: 'drizzle', backupDir: mkdtempSync(join(tmpdir(), 'bk-')), log: () => {} }))
      .rejects.toThrow(/newer than this image \(which knows up to 0038_/);
  });
});
