import { readFileSync, readdirSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getDb } from '@/db';

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

const pgDump = async (url: string, file: string) => {
  await promisify(execFile)('pg_dump', ['--format=custom', `--file=${file}`, `--dbname=${url}`]);
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
      throw new MigrationRefused(`the database has a migration newer than this image (which knows up to ${state.imageLatest}) -- use a newer image (WEBADF_IMAGE_TAG)`);
    }
    if (state.pending.length === 0) { log('migrations: up to date'); return { applied: [], backup: null }; }
    let backup: string | null = null;
    if (latest !== null) { // a fresh database has nothing to back up
      mkdirSync(opts.backupDir, { recursive: true });
      backup = join(opts.backupDir, backupName(new Date(), state.pending[0]));
      log(`migrations: backing up to ${backup} before ${state.pending.length} pending`);
      await (opts.dump ?? pgDump)(opts.url, backup);
      for (const old of prunable(readdirSync(opts.backupDir), KEEP)) unlinkSync(join(opts.backupDir, old));
    }
    try {
      await migrate(getDb(), { migrationsFolder: opts.migrationsFolder });
    } catch (e) {
      throw new MigrationRefused(`migration failed (${(e as Error).message}); the schema is unchanged${backup ? `; backup: ${backup}` : ''}`);
    }
    log(`migrations: applied ${state.pending.join(', ')}`);
    return { applied: state.pending, backup };
  } finally {
    await lock.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await lock.end();
  }
}
