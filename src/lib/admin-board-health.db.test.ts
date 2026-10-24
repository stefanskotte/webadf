import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { createHash, randomUUID } from 'node:crypto';

// A database of its own (the shared one is the live one).
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_admin_overview_test';
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
const { devices } = await import('@/db/schema/devices');
const { firmwareReleases } = await import('@/db/schema/firmware');
const { user, organization, member } = await import('@/db/schema/auth');
const { STALE_AFTER_MS } = await import('./device-state');
const { readCurrentRelease } = await import('./firmware-releases');
const Q = await import('./admin-queries');

const db = () => getDb();
const NOW = Date.now();
const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number) => new Date(NOW - ms);

async function release(version: string, sequence: number, notes: string | null = null) {
  await db().insert(firmwareReleases).values({
    id: randomUUID(), version, sequence, semver: version.split('+')[0], sha256: 'a'.repeat(64), sizeBytes: 1,
    blobPath: `fw/${version}`, signature: 's', signingKeyId: 'k', signatureFormat: 2, notes, publishedByUserId: 'u-a1',
  });
}

async function device(id: string, orgId: string, over: Partial<typeof devices.$inferInsert> = {}) {
  await db().insert(devices).values({
    id, orgId, name: `Board ${id}`, tokenHash: createHash('sha256').update(id).digest('hex'), ...over,
  });
}

describe('admin overview: board counts, firmware distribution, needs attention', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
    const t0 = new Date(NOW - 30 * D);
    const t1 = new Date(NOW - 20 * D);
    await db().insert(user).values([
      { id: 'u-a1', name: 'A1', email: 'a-first@example.test', emailVerified: true, createdAt: t0, updatedAt: t0 },
      { id: 'u-a2', name: 'A2', email: 'a-owner@example.test', emailVerified: true, createdAt: t1, updatedAt: t1 },
      { id: 'u-b1', name: 'B1', email: 'b-first@example.test', emailVerified: true, createdAt: t0, updatedAt: t0 },
      { id: 'u-b2', name: 'B2', email: 'b-later@example.test', emailVerified: true, createdAt: t1, updatedAt: t1 },
    ]);
    await db().insert(organization).values([
      { id: 'org-a', name: 'A', slug: 'org-a', createdAt: t0 },
      { id: 'org-b', name: 'B', slug: 'org-b', createdAt: t0 },
    ]);
    // org-a: the owner joined AFTER a plain member -- the owner role wins. org-b: no owner; the earliest member wins.
    await db().insert(member).values([
      { id: 'm-a1', organizationId: 'org-a', userId: 'u-a1', role: 'member', createdAt: t0 },
      { id: 'm-a2', organizationId: 'org-a', userId: 'u-a2', role: 'owner', createdAt: t1 },
      { id: 'm-b2', organizationId: 'org-b', userId: 'u-b2', role: 'member', createdAt: t1 },
      { id: 'm-b1', organizationId: 'org-b', userId: 'u-b1', role: 'member', createdAt: t0 },
    ]);

    await release('1.20.0+gold', 10);
    await release('1.21.0+gcur', 11);
    await release('1.22.0+gbench', 12, 'TEST build: bench only');
    await release('0.0.0+e2e-x', 13);

    await device('a-online-current', 'org-a', { firmwareVersion: '1.21.0+gcur', lastSeenAt: ago(5_000) });
    await device('a-stale-edge', 'org-a', { firmwareVersion: '1.21.0+gcur', lastSeenAt: ago(STALE_AFTER_MS + 5_000) });
    await device('a-behind', 'org-a', { firmwareVersion: '1.20.0+gold', lastSeenAt: ago(H) });
    await device('a-null-version', 'org-a', { firmwareVersion: null, lastSeenAt: ago(2 * H) });
    await device('b-offline', 'org-b', { firmwareVersion: '1.21.0+gcur', lastSeenAt: ago(3 * D) });
    await device('b-error', 'org-b', {
      firmwareVersion: '1.21.0+gcur', lastSeenAt: ago(30 * D), lastError: 'mount failed', lastErrorAt: ago(2 * H),
    });
    await device('b-never', 'org-b', { firmwareVersion: null, lastSeenAt: null });
    await device('b-gone', 'org-b', { firmwareVersion: '1.20.0+gold', lastSeenAt: ago(10 * D) });
    await device('b-bench', 'org-b', { firmwareVersion: '1.22.0+gbench', lastSeenAt: ago(10_000) });
  });
  afterAll(async () => {
    await closeDb();
    await admin(`drop database if exists ${DB} with (force)`);
  });

  it('the current release skips TEST builds and e2e versions', async () => {
    expect(await readCurrentRelease()).toEqual({ version: '1.21.0+gcur', sequence: 11 });
  });

  it('board counts: paired, online within STALE_AFTER_MS, seen in 7 days -- across both orgs', async () => {
    expect(await Q.adminBoardCounts(NOW)).toEqual({ paired: 9, online: 2, seen7d: 6 });
  });

  it('the distribution groups boards seen in 7 days by version, with the release sequence, NULL kept', async () => {
    const rows = await Q.adminFirmwareDistribution(NOW);
    const by = new Map(rows.map((r) => [r.version, r]));
    expect(rows).toHaveLength(4);
    expect(by.get('1.21.0+gcur')).toEqual({ version: '1.21.0+gcur', count: 3, sequence: 11 });
    expect(by.get('1.20.0+gold')).toEqual({ version: '1.20.0+gold', count: 1, sequence: 10 });
    expect(by.get('1.22.0+gbench')).toEqual({ version: '1.22.0+gbench', count: 1, sequence: 12 });
    expect(by.get(null)).toEqual({ version: null, count: 1, sequence: null });
  });

  it('attention: error, behind, offline; healthy, never-seen and long-gone boards absent; owner emails', async () => {
    const rows = await Q.adminNeedsAttention(NOW);
    const ids = rows.map((r) => r.deviceId);
    expect(ids).toEqual(['b-error', 'a-behind', 'a-null-version', 'b-offline']);
    const by = new Map(rows.map((r) => [r.deviceId, r]));
    expect(by.get('b-error')!.reasons).toEqual([{ kind: 'error', text: 'Error 2h ago: mount failed' }]);
    expect(by.get('a-behind')!.reasons).toEqual([{ kind: 'behind', text: 'Behind: runs 1.20.0+gold, current is 1.21.0+gcur' }]);
    expect(by.get('a-null-version')!.reasons).toEqual([{ kind: 'behind', text: 'Behind: runs unknown, current is 1.21.0+gcur' }]);
    expect(by.get('b-offline')!.reasons).toEqual([{ kind: 'offline', text: 'Offline 3d ago' }]);
    expect(by.get('a-behind')!.ownerEmail).toBe('a-owner@example.test');
    expect(by.get('b-error')!.ownerEmail).toBe('b-first@example.test');
    expect(by.get('a-behind')!.name).toBe('Board a-behind');
    for (const healthy of ['a-online-current', 'a-stale-edge', 'b-bench', 'b-never', 'b-gone']) {
      expect(ids).not.toContain(healthy);
    }
  });

  it('attention keeps at most 20 rows, errors first', async () => {
    for (let i = 0; i < 22; i++) {
      await device(`err-${i}`, 'org-a', {
        firmwareVersion: '1.21.0+gcur', lastSeenAt: ago(i * 1000), lastError: 'x', lastErrorAt: ago(H),
      });
    }
    const rows = await Q.adminNeedsAttention(NOW);
    expect(rows).toHaveLength(20);
    expect(rows.every((r) => r.reasons[0].kind === 'error')).toBe(true);
    expect(rows[0].deviceId).toBe('err-0');
  });
});
