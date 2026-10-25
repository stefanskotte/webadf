import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { createHash, randomUUID } from 'node:crypto';

// A database of its own (the shared one is the live one).
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_admin_firmware_test';
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
const { listReleasesFull, countReleases } = await import('./firmware-releases');
const Q = await import('./admin-queries');

const db = () => getDb();

async function release(version: string, sequence: number, notes: string | null = null) {
  await db().insert(firmwareReleases).values({
    id: randomUUID(), version, sequence, semver: version.split('+')[0], sha256: 'a'.repeat(64), sizeBytes: 1,
    blobPath: `fw/${version}`, signature: 's', signingKeyId: 'k', signatureFormat: 2, notes, publishedByUserId: 'u',
  });
}
async function device(id: string, orgId: string, firmwareVersion: string | null, lastSeenAt: Date | null) {
  await db().insert(devices).values({
    id, orgId, name: `Board ${id}`, tokenHash: createHash('sha256').update(id).digest('hex'), firmwareVersion, lastSeenAt,
  });
}

describe('admin firmware list: paging, Current, boards', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
  });
  afterAll(async () => {
    await closeDb();
    await admin(`drop database if exists ${DB} with (force)`);
  });

  it('an empty registry: no rows, total 0, no boards', async () => {
    expect(await listReleasesFull({ limit: 25, offset: 0 })).toEqual([]);
    expect(await countReleases()).toBe(0);
    expect(await Q.adminBoardsByVersion([])).toEqual(new Map());
  });

  it('pages newest first, with the total; marks exactly the current release', async () => {
    for (let s = 1; s <= 27; s++) await release(`1.0.${s}+g${s}`, s);
    await release('1.1.0+gbench', 28, 'TEST build: bench');
    await release('0.0.0+e2e-x', 29);

    expect(await countReleases()).toBe(29);
    const p1 = await listReleasesFull({ limit: 25, offset: 0 });
    expect(p1.map((r) => r.sequence)).toEqual([...Array(25)].map((_, i) => 29 - i));
    const p2 = await listReleasesFull({ limit: 25, offset: 25 });
    expect(p2.map((r) => r.sequence)).toEqual([4, 3, 2, 1]);

    const all = [...p1, ...p2];
    // Current skips the e2e version (29) and the TEST build (28): 1.0.27 is current.
    expect(all.filter((r) => r.isCurrent).map((r) => r.version)).toEqual(['1.0.27+g27']);
    expect(all.find((r) => r.sequence === 28)).toMatchObject({ semver: '1.1.0', notes: 'TEST build: bench' });
  });

  it('boards per version: every org, any last-seen, NULL versions ignored', async () => {
    await device('d1', 'org-a', '1.0.27+g27', new Date());
    await device('d2', 'org-b', '1.0.27+g27', null);
    await device('d3', 'org-b', '1.0.27+g27', new Date(Date.now() - 400 * 86_400_000));
    await device('d4', 'org-a', '1.1.0+gbench', new Date());
    await device('d5', 'org-a', null, null);
    await device('d6', 'org-a', '9.9.9+gunknown', new Date());
    const m = await Q.adminBoardsByVersion(['1.0.27+g27', '1.1.0+gbench', '1.0.1+g1']);
    expect(m.get('1.0.27+g27')).toBe(3);
    expect(m.get('1.1.0+gbench')).toBe(1);
    expect(m.get('1.0.1+g1') ?? 0).toBe(0);
    expect(m.has('9.9.9+gunknown')).toBe(false);
  });

  it('?show= filters by the TEST build notes pattern, newest first, and counts what it shows (C6 Ruling 30)', async () => {
    // From the rows above: 1.0.1..1.0.27 (seq 1-27), a TEST build (28), an e2e version with no notes (29).
    expect(await countReleases()).toBe(29);
    expect(await countReleases({ show: 'all' })).toBe(29);
    expect(await countReleases({ show: 'test' })).toBe(1);
    expect(await countReleases({ show: 'releases' })).toBe(28);
    expect((await listReleasesFull({ limit: 25, offset: 0, show: 'test' })).map((r) => r.sequence)).toEqual([28]);
    const rel1 = await listReleasesFull({ limit: 25, offset: 0, show: 'releases' });
    expect(rel1).toHaveLength(25);
    expect(rel1.map((r) => r.sequence).slice(0, 3)).toEqual([29, 27, 26]);
    expect(rel1.some((r) => (r.notes ?? '').startsWith('TEST build'))).toBe(false);
    expect((await listReleasesFull({ limit: 25, offset: 25, show: 'releases' })).map((r) => r.sequence)).toEqual([3, 2, 1]);
    // The unfiltered list is unchanged.
    expect((await listReleasesFull({ limit: 25, offset: 0 })).map((r) => r.sequence)[1]).toBe(28);
  });
});
