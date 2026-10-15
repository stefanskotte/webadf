import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Client } from 'pg';
import { mkdtempSync, readdirSync, cpSync, readFileSync, writeFileSync, statSync } from 'node:fs';
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

  describe('with one extra migration', () => {
    const DB2 = 'webadf_startup_migrate_test2';
    const u2 = new URL(base); u2.pathname = `/${DB2}`;
    const url2 = u2.toString();

    function folderWith(sql: string) {
      const folder = mkdtempSync(join(tmpdir(), 'mig-'));
      cpSync('drizzle', folder, { recursive: true });
      const jp = join(folder, 'meta/_journal.json');
      const j = JSON.parse(readFileSync(jp, 'utf8'));
      const last = j.entries.at(-1);
      j.entries.push({ idx: last.idx + 1, version: last.version, when: last.when + 1000, tag: '0039_selfhost_test', breakpoints: last.breakpoints });
      writeFileSync(jp, JSON.stringify(j, null, 2));
      writeFileSync(join(folder, '0039_selfhost_test.sql'), sql);
      return folder;
    }
    const count = async () => (await admin('select count(*)::int as n from drizzle.__drizzle_migrations', url2)).rows[0].n as number;
    const probe = async () => (await admin(`select to_regclass('public.selfhost_probe') is not null as e`, url2)).rows[0].e as boolean;
    const tmpBackups = () => mkdtempSync(join(tmpdir(), 'bk-'));

    beforeEach(async () => {
      await admin(`drop database if exists ${DB2} with (force)`); await admin(`create database ${DB2}`);
      await runStartupMigrations({ url: url2, migrationsFolder: 'drizzle', backupDir: tmpBackups(), log: () => {} });
    });
    afterAll(async () => { await admin(`drop database if exists ${DB2} with (force)`); });

    it('behind -> latest: backs up first, then applies', async () => {
      const before = await count();
      const dumps: string[] = [];
      const r = await runStartupMigrations({
        url: url2, migrationsFolder: folderWith('create table selfhost_probe (id int);'), backupDir: tmpBackups(),
        dump: async (_u, f) => { dumps.push(f); writeFileSync(f, 'x'); }, log: () => {},
      });
      expect(r.applied).toEqual(['0039_selfhost_test']);
      expect(dumps).toHaveLength(1);
      expect(dumps[0]).toMatch(/-before-0039_selfhost_test\.dump$/);
      expect(await probe()).toBe(true);
      expect(await count()).toBe(before + 1);
    });

    it('a backup is readable by its owner only (0600): it holds password hashes and sessions', async () => {
      const dir = tmpBackups();
      await runStartupMigrations({
        url: url2, migrationsFolder: folderWith('create table selfhost_probe (id int);'), backupDir: dir,
        dump: async (_u, f) => { writeFileSync(f, 'x', { mode: 0o644 }); }, log: () => {},
      });
      const [name] = readdirSync(dir);
      expect(name).toMatch(/-before-0039_selfhost_test\.dump$/);
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    });

    it('a migration that keeps failing reuses its backup instead of taking (and rotating) a new one per restart', async () => {
      const dir = tmpBackups();
      const folder = folderWith('select 1/0;');
      const dumps: string[] = [];
      const lines: string[] = [];
      const run = () => runStartupMigrations({
        url: url2, migrationsFolder: folder, backupDir: dir,
        dump: async (_u, f) => { dumps.push(f); writeFileSync(f, 'x'); }, log: (l) => lines.push(l),
      });
      await expect(run()).rejects.toThrow(/migration failed in 0039_selfhost_test/);
      await expect(run()).rejects.toThrow(new RegExp(`backup: ${dumps[0]?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      expect(dumps).toHaveLength(1);
      expect(readdirSync(dir)).toHaveLength(1);
      expect(lines).toContain(`migrations: backup before 0039_selfhost_test already taken: ${dumps[0]}`);
    });

    it('a failing migration names the migration, the cause and the backup', async () => {
      const before = await count();
      await expect(runStartupMigrations({
        url: url2, migrationsFolder: folderWith('select 1/0;'), backupDir: tmpBackups(),
        dump: async (_u, f) => { writeFileSync(f, 'x'); }, log: () => {},
      })).rejects.toThrow(/migration failed in 0039_selfhost_test \(division by zero\); the schema is unchanged; backup: .*-before-0039_selfhost_test\.dump/);
      expect(await count()).toBe(before);
    });

    it('a failing dump stops before migrating', async () => {
      const before = await count();
      await expect(runStartupMigrations({
        url: url2, migrationsFolder: folderWith('create table selfhost_probe (id int);'), backupDir: tmpBackups(),
        dump: async () => { throw new Error('boom'); }, log: () => {},
      })).rejects.toThrow(/backup failed/);
      expect(await count()).toBe(before);
      expect(await probe()).toBe(false);
    });
  });

  it('refuses a database newer than the image', async () => {
    await admin(`insert into drizzle.__drizzle_migrations (hash, created_at) values ('future', 99999999999999)`, url);
    await expect(runStartupMigrations({ url, migrationsFolder: 'drizzle', backupDir: mkdtempSync(join(tmpdir(), 'bk-')), log: () => {} }))
      .rejects.toThrow(/newer than this image \(database at created_at 99999999999999, this image knows up to 0038_/);
  });
});
