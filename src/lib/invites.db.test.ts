import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { and, eq, gt, isNull } from 'drizzle-orm';

// A database of its own (the shared one is the live one).
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_invites_test';
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
const { invites } = await import('@/db/schema/devices');
const { user } = await import('@/db/schema/auth');
const I = await import('./invites');
const Q = await import('./admin-queries');

const db = () => getDb();
const row = async (code: string) => (await db().select().from(invites).where(eq(invites.code, code)))[0];
const issue = () => I.issueInvite('org-x', 'creator');

describe('invites: revoked state and consumer', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
    const now = new Date();
    await db().insert(user).values({ id: 'u1', name: 'U One', email: 'one@example.test', emailVerified: true, createdAt: now, updatedAt: now });
    await db().insert(user).values({ id: 'u2', name: 'U Two', email: 'two@example.test', emailVerified: true, createdAt: now, updatedAt: now });
  });
  afterAll(async () => {
    await closeDb();
    await admin(`drop database if exists ${DB} with (force)`);
  });

  it('revoke keeps the row and marks it revoked', async () => {
    const code = await issue();
    expect(await I.revokeInvite(code)).toBe('revoked');
    const r = await row(code);
    expect(r).toBeTruthy();
    expect(r.revokedAt).toBeInstanceOf(Date);
    const listed = (await Q.adminListInvites()).find((i) => i.code === code);
    expect(listed?.state).toBe('revoked');
  });

  it('revoke also expires the code, so pre-A7 code (no revoked_at check) still refuses it after a rollback', async () => {
    const code = await issue();
    expect(await I.revokeInvite(code)).toBe('revoked');
    const r = await row(code);
    expect(r.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    // The old claim's WHERE: consumed_at is null and expires_at > now()
    const old = await db().select().from(invites)
      .where(and(eq(invites.code, code), isNull(invites.consumedAt), gt(invites.expiresAt, new Date())));
    expect(old).toHaveLength(0);
    expect((await Q.adminListInvites()).find((i) => i.code === code)?.state).toBe('revoked');
  });

  it('revoking twice answers revoked both times and keeps the first timestamp', async () => {
    const code = await issue();
    expect(await I.revokeInvite(code)).toBe('revoked');
    const first = (await row(code)).revokedAt;
    expect(await I.revokeInvite(code)).toBe('revoked');
    expect((await row(code)).revokedAt).toEqual(first);
  });

  it('revoking a consumed code answers consumed and leaves it unrevoked', async () => {
    const code = await issue();
    expect((await I.claimInvite(code)).ok).toBe(true);
    expect(await I.revokeInvite(code)).toBe('consumed');
    expect((await row(code)).revokedAt).toBeNull();
  });

  it('revoking an unknown code answers missing', async () => {
    expect(await I.revokeInvite('ZZZZZZZZ')).toBe('missing');
  });

  it('a revoked code cannot be claimed', async () => {
    const code = await issue();
    await I.revokeInvite(code);
    expect((await I.claimInvite(code)).ok).toBe(false);
    expect((await row(code)).consumedAt).toBeNull();
  });

  it('recordInviteConsumer sets the id once and never overwrites', async () => {
    const code = await issue();
    await I.claimInvite(code);
    await I.recordInviteConsumer(code, 'u1');
    expect((await row(code)).consumedByUserId).toBe('u1');
    await I.recordInviteConsumer(code, 'u2');
    expect((await row(code)).consumedByUserId).toBe('u1');
  });

  it('recordInviteConsumer normalises the code and tolerates garbage', async () => {
    const code = await issue();
    await I.claimInvite(code);
    await I.recordInviteConsumer(` ${code.toLowerCase()} `, 'u1');
    expect((await row(code)).consumedByUserId).toBe('u1');
    await expect(I.recordInviteConsumer('', 'u1')).resolves.toBeUndefined();
  });

  it('adminListInvites returns usedByEmail and consumedAt', async () => {
    const code = await issue();
    await I.claimInvite(code);
    await I.recordInviteConsumer(code, 'u2');
    const listed = (await Q.adminListInvites()).find((i) => i.code === code);
    expect(listed?.state).toBe('consumed');
    expect(listed?.usedByEmail).toBe('two@example.test');
    expect(listed?.consumedAt).toBeInstanceOf(Date);
  });

  it('usedByEmail is null for a code consumed before the id was recorded', async () => {
    const code = await issue();
    await I.claimInvite(code);
    const listed = (await Q.adminListInvites()).find((i) => i.code === code);
    expect(listed?.usedByEmail).toBeNull();
  });

  it('liveInvites excludes revoked codes', async () => {
    const before = (await Q.adminCounts()).liveInvites;
    const code = await issue();
    expect((await Q.adminCounts()).liveInvites).toBe(before + 1);
    await I.revokeInvite(code);
    expect((await Q.adminCounts()).liveInvites).toBe(before);
  });
});
