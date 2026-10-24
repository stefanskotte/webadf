import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_bootstrap_test';
const u = new URL(base); u.pathname = `/${DB}`;
process.env.DATABASE_URL = u.toString();
async function admin(stmt: string, target = base) {
  const c = new Client({ connectionString: target }); await c.connect();
  try { return await c.query(stmt); } finally { await c.end(); }
}
const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { ensureBootstrapInvite } = await import('./bootstrap');

describe('ensureBootstrapInvite', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`); await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
  });
  afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

  it('creates one invite while there is no user, reuses it, and names the admin email', async () => {
    const a = await ensureBootstrapInvite('https://x.lan', 'me@x.lan');
    const b = await ensureBootstrapInvite('https://x.lan', 'me@x.lan');
    expect(a).toMatch(/^Sign up as the first admin \(use me@x\.lan\): https:\/\/x\.lan\/sign-up\?invite=[A-Z0-9]{8}$/);
    expect(b).toBe(a);
    const n = await admin(`select count(*)::int as n from invites where org_id = 'bootstrap'`, u.toString());
    expect(n.rows[0].n).toBe(1);
  });

  it('does not reuse a revoked bootstrap code', async () => {
    const before = await ensureBootstrapInvite('https://x.lan', 'me@x.lan');
    const oldCode = before!.slice(-8);
    await admin(`update invites set revoked_at = now() where code = '${oldCode}'`, u.toString());
    const after = await ensureBootstrapInvite('https://x.lan', 'me@x.lan');
    expect(after).not.toContain(oldCode);
    expect(after).toMatch(/sign-up\?invite=[A-Z0-9]{8}$/);
  });

  it('returns null and creates nothing once a user exists', async () => {
    await admin(`insert into auth."user" (id, name, email, email_verified, created_at, updated_at) values ('u1','x','x@x.lan',false,now(),now())`, u.toString());
    expect(await ensureBootstrapInvite('https://x.lan', 'me@x.lan')).toBeNull();
    const n = await admin(`select count(*)::int as n from invites where org_id = 'bootstrap' and revoked_at is null`, u.toString());
    expect(n.rows[0].n).toBe(1);
  });
});
