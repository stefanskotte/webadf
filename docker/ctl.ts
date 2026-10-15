import { statfsSync, readdirSync, existsSync, mkdirSync, chownSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig, ConfigError } from '@/selfhost/config';
import { checkFreeSpace, checkWritable, checkPgData, type CheckResult } from '@/selfhost/checks';
import { renderCaddyfile } from '@/selfhost/caddyfile';
import { ensureSecrets, readSecrets, SecretError } from '@/selfhost/secrets';
import { parseCron, nextRun, nextArm } from '@/selfhost/cron';
import { config as vercelConfig } from '../vercel';

/** webadf-ctl: the container's entry (self-hosting P2). One line per failure, exit 1. */
const DATA = '/data';
const OWNER = { uid: 1000, gid: 1000 };
const say = (l: string) => console.log(`webadf: ${l}`);
function die(l: string): never { console.error(`webadf: ${l}`); process.exit(1); }
function report(r: CheckResult) { if (r.level === 'fail') die(r.message); if (r.level === 'warn') say(`warning: ${r.message}`); }
function free(dir: string) { const s = statfsSync(dir); return s.bavail * s.bsize; }

async function setup() {
  let cfg;
  try { cfg = resolveConfig(process.env); } catch (e) { if (e instanceof ConfigError) die(e.message); throw e; }
  // secrets/ is left to ensureSecrets, which creates it 0700 (made here first it would keep the default mode).
  for (const d of ['postgres', 'blobs', 'caddy', 'backups']) mkdirSync(join(DATA, d), { recursive: true });
  for (const d of ['blobs', 'backups']) chownSync(join(DATA, d), OWNER.uid, OWNER.gid);
  report(checkPgData(readdirSync(join(DATA, 'postgres')), existsSync(join(DATA, 'postgres/data/PG_VERSION'))));
  report(checkFreeSpace(free(DATA), 'the data folder'));
  const created = ensureSecrets(join(DATA, 'secrets'), OWNER);
  if (created.length) say(`created secrets: ${created.join(', ')}`);
  writeFileSync(join(DATA, 'caddy/Caddyfile'), renderCaddyfile(cfg));
  say(`setup ok -- ${cfg.url}`);
}

function env() {
  let cfg;
  try { cfg = resolveConfig(process.env); } catch (e) { if (e instanceof ConfigError) die(e.message); throw e; }
  let s;
  try { s = readSecrets(join(DATA, 'secrets')); } catch (e) { if (e instanceof SecretError) die(e.message); throw e; }
  process.env.DATABASE_URL = `postgresql://webadf:${encodeURIComponent(s.pg_password)}@db:5432/webadf`;
  process.env.BETTER_AUTH_SECRET = s.better_auth_secret;
  process.env.CRON_SECRET = s.cron_secret;
  process.env.BETTER_AUTH_URL = cfg.url;
  process.env.SUPERADMIN_EMAILS = cfg.superadmins;
  process.env.STORAGE_DIR = join(DATA, 'blobs');
  delete process.env.BLOB_READ_WRITE_TOKEN;
  // The weekly blob GC deletes, as on our deployment (parity); BLOB_GC_DELETE=0 in .env makes it report only.
  if (!process.env.BLOB_GC_DELETE?.trim()) process.env.BLOB_GC_DELETE = '1'; // unset or empty = the default
  return cfg;
}

async function waitForDb(url: string) {
  const { Client } = await import('pg');
  const deadline = Date.now() + 60_000;
  for (;;) {
    const c = new Client({ connectionString: url });
    try { await c.connect(); await c.end(); return; } catch (e) {
      const msg = (e as Error).message;
      if (/password authentication failed/.test(msg)) die('the database refuses the password in secrets/pg_password -- was data/postgres created by another install? (restore its secrets folder, or start with an empty data/postgres)');
      if (Date.now() > deadline) die(`the database at db:5432 did not answer within 60 s (${msg})`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function start() {
  const cfg = env();
  for (const d of ['blobs', 'backups']) report(checkWritable(join(DATA, d), d));
  report(checkFreeSpace(free(DATA), 'the data folder'));
  await waitForDb(process.env.DATABASE_URL!);
  const { runStartupMigrations, MigrationRefused } = await import('@/selfhost/migrate');
  try {
    await runStartupMigrations({ url: process.env.DATABASE_URL!, migrationsFolder: '/app/drizzle', backupDir: join(DATA, 'backups'), log: say });
  } catch (e) { if (e instanceof MigrationRefused) die(e.message); throw e; }
  const { ensureBootstrapInvite } = await import('@/selfhost/bootstrap');
  const line = await ensureBootstrapInvite(cfg.url, cfg.adminEmail);
  if (line) say(line);
  const { closeDb } = await import('@/db');
  await closeDb();
  process.env.HOSTNAME = '0.0.0.0';
  process.env.PORT = '3000';
  // Next's standalone server, copied into the image beside this file. A variable, so neither tsc nor esbuild resolves it.
  const server = '/app/server.js';
  await import(server);
}

async function scheduler() {
  env();
  // compose stop / up sends SIGTERM; nothing here needs flushing, so leave at once instead of waiting 10 s for SIGKILL.
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => process.exit(0));
  const jobs = (vercelConfig.crons ?? []).map((c) => ({ path: c.path, cron: parseCron(c.schedule) }));
  say(`scheduler: ${jobs.map((j) => j.path).join(', ')}`);
  for (const j of jobs) {
    (function arm(at: Date) {
      setTimeout(async () => {
        const t0 = Date.now();
        say(`cron ${j.path}: start`);
        try {
          const r = await fetch(`http://app:3000${j.path}`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
          await r.arrayBuffer(); // drain, so the connection is released
          say(`cron ${j.path}: HTTP ${r.status} in ${Math.round((Date.now() - t0) / 1000)} s`);
        } catch (e) {
          say(`cron ${j.path}: failed (${(e as Error).message}); next slot retries`);
        }
        // nextArm: never the same slot twice, and missed slots (suspend, overrun) collapse into this run.
        arm(nextArm(j.cron, at, new Date()));
      }, Math.max(0, at.getTime() - Date.now()));
    })(nextRun(j.cron, new Date()));
  }
}

const cmd = process.argv[2];
const run = cmd === 'setup' ? setup : cmd === 'start' ? start : cmd === 'scheduler' ? scheduler : null;
if (!run) die('usage: webadf-ctl setup|start|scheduler');
run().catch((e) => die(`unexpected: ${(e as Error).stack ?? e}`));
