import { readFileSync, readdirSync, mkdirSync, unlinkSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

/** Self-hosting P2 (spec D9): backed-up, locked, refusing a downgrade. */
export interface JournalEntry { when: number; tag: string }
export interface MigrationState { pending: string[]; newer: boolean; imageLatest: string }
export class MigrationRefused extends Error {}

const LOCK_KEY = 7_240_012; // arbitrary, constant: "webadf migrate"
const KEEP = 5;
const BACKUP_RE = /^\d{8}T\d{6}Z-before-.+\.dump$/;

export function migrationState(entries: JournalEntry[], dbLatest: number | null): MigrationState {
  const imageLatest = entries.at(-1)!.tag;
  const last = entries.at(-1)!.when;
  return {
    pending: entries.filter((x) => dbLatest === null || x.when > dbLatest).map((x) => x.tag),
    newer: dbLatest !== null && dbLatest > last,
    imageLatest,
  };
}

export function backupName(now: Date, firstPendingTag: string): string {
  const ts = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${ts}-before-${firstPendingTag}.dump`;
}

export function prunable(names: string[], keep: number): string[] {
  return names.filter((n) => BACKUP_RE.test(n)).sort().reverse().slice(keep).reverse();
}

/** Connection parts for pg_dump by environment, so the password never reaches argv or a log. */
export function pgEnv(url: string): Record<string, string> {
  const u = new URL(url);
  const env: Record<string, string> = {};
  if (u.hostname) env.PGHOST = u.hostname;
  if (u.port) env.PGPORT = u.port;
  if (u.username) env.PGUSER = decodeURIComponent(u.username);
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (db) env.PGDATABASE = db;
  return env;
}

const pgDump = async (url: string, file: string) => {
  try {
    await promisify(execFile)('pg_dump', ['--format=custom', `--file=${file}`], { env: { ...process.env, ...pgEnv(url) } });
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error((err.stderr ?? '').trim() || 'pg_dump failed');
  }
};

export async function runStartupMigrations(opts: {
  url: string; migrationsFolder: string; backupDir: string;
  dump?: (url: string, file: string) => Promise<void>; log?: (line: string) => void;
}): Promise<{ applied: string[]; backup: string | null }> {
  const log = opts.log ?? ((l) => console.log(l));
  const journal = JSON.parse(readFileSync(join(opts.migrationsFolder, 'meta/_journal.json'), 'utf8')) as { entries: JournalEntry[] };
  const lock = new Client({ connectionString: opts.url });
  await lock.connect();
  try {
    await lock.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    const has = await lock.query(`select to_regclass('drizzle.__drizzle_migrations') is not null as e`);
    const latest = has.rows[0].e
      ? Number((await lock.query('select max(created_at)::text as m from drizzle.__drizzle_migrations')).rows[0].m ?? NaN)
      : null;
    const state = migrationState(journal.entries, latest === null || Number.isNaN(latest) ? null : latest);
    if (state.newer) {
      throw new MigrationRefused(`the database has a migration newer than this image (database at created_at ${latest}, this image knows up to ${state.imageLatest}) -- use a newer image (WEBADF_IMAGE_TAG)`);
    }
    if (state.pending.length === 0) { log('migrations: up to date'); return { applied: [], backup: null }; }
    let backup: string | null = null;
    if (latest !== null) { // a fresh database has nothing to back up
      mkdirSync(opts.backupDir, { recursive: true });
      // A migration that keeps failing is retried on every restart (restart: unless-stopped). The schema is
      // unchanged by a failed run, so the backup taken before the first attempt still holds; reusing it keeps
      // the retries from rotating the older backups out.
      const suffix = `-before-${state.pending[0]}.dump`;
      const taken = readdirSync(opts.backupDir).filter((n) => BACKUP_RE.test(n) && n.endsWith(suffix)).sort().at(-1);
      if (taken) {
        backup = join(opts.backupDir, taken);
        log(`migrations: backup before ${state.pending[0]} already taken: ${backup}`);
      } else {
        backup = join(opts.backupDir, backupName(new Date(), state.pending[0]));
        log(`migrations: backing up to ${backup} before ${state.pending.length} pending`);
        try {
          await (opts.dump ?? pgDump)(opts.url, backup);
          chmodSync(backup, 0o600); // password hashes and sessions
        } catch (e) {
          if (existsSync(backup)) unlinkSync(backup);
          throw new MigrationRefused(`backup failed (${(e as Error).message.trim()}); nothing was migrated`);
        }
        for (const old of prunable(readdirSync(opts.backupDir), KEEP)) unlinkSync(join(opts.backupDir, old));
      }
    }
    const pool = new Pool({ connectionString: opts.url });
    try {
      await migrate(drizzle(pool), { migrationsFolder: opts.migrationsFolder });
    } catch (e) {
      const err = e as Error & { cause?: unknown };
      const why = err.cause instanceof Error ? err.cause.message : err.message;
      const range = state.pending.length > 1 ? `${state.pending[0]}..${state.pending.at(-1)}` : state.pending[0];
      throw new MigrationRefused(`migration failed in ${range} (${why}); the schema is unchanged${backup ? `; backup: ${backup}` : ''}`);
    } finally {
      await pool.end();
    }
    log(`migrations: applied ${state.pending.join(', ')}`);
    return { applied: state.pending, backup };
  } finally {
    await lock.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await lock.end();
  }
}
