import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Client } from 'pg';

// The late-holder safety net (spec §3.3 step 4): a board that mounts one of the titles AFTER deleteGames read the
// devices is ejected and named, as single delete does. Simulated by a plan that saw no boards -- exactly what a read
// taken before that mount looks like. A file of its own because vi.mock applies to the whole file.
vi.mock('@/lib/bulk-delete-plan', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/bulk-delete-plan')>();
  return {
    ...real,
    planBulkDelete: (...a: Parameters<typeof real.planBulkDelete>) => real.planBulkDelete(a[0], a[1], [], a[3], a[4]),
  };
});

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_library_bulk_late_test';
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
const { eq } = await import('drizzle-orm');
const { games, disks, blobs, entitlements } = await import('@/db/schema/catalog');
const { devices } = await import('@/db/schema/devices');
const { deleteGames } = await import('./disk-delete');

const ORG = 'org-bulk-late';
const NOW = Date.UTC(2026, 9, 26, 12);
const S = '7'.repeat(64);
const T = '8'.repeat(64);

describe('deleteGames: a board that mounted after the read', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
    const db = getDb();
    await db.insert(games).values({ id: 'g1', orgId: ORG, title: 'Late', sortTitle: 'late' });
    await db.insert(blobs).values({ sha256: S, sizeBytes: 100, storageKey: S });
    await db.insert(disks).values({ id: 'g1-d1', gameId: 'g1', orgId: ORG, diskNo: 1, sha256: S, sizeBytes: 100 });
    await db.insert(entitlements).values({ orgId: ORG, sha256: S, sourceFilename: 'late.adf' });
    await db.insert(devices).values([
      { id: 'b1', orgId: ORG, name: 'A500', tokenHash: 'h-b1', lastSeenAt: new Date(NOW), desiredSha256: S,
        desiredDiskId: 'g1-d1', desiredVersion: 4 },
      { id: 'b2', orgId: ORG, name: 'A1200', tokenHash: 'h-b2', lastSeenAt: new Date(NOW), df1DiskId: 'g1-d1', df1Version: 2 },
    ]);
    await db.insert(games).values({ id: 'g2', orgId: ORG, title: 'Late2', sortTitle: 'late2' });
    await db.insert(blobs).values({ sha256: T, sizeBytes: 100, storageKey: T });
    await db.insert(disks).values({ id: 'g2-d1', gameId: 'g2', orgId: ORG, diskNo: 1, sha256: T, sizeBytes: 100 });
    await db.insert(games).values({ id: 'g3', orgId: ORG, title: 'Other', sortTitle: 'other' });
    await db.insert(disks).values({ id: 'g3-d1', gameId: 'g3', orgId: ORG, diskNo: 1, sha256: S, sizeBytes: 100 });
    await db.insert(devices).values({ id: 'b3', orgId: ORG, name: 'CD32', tokenHash: 'h-b3', lastSeenAt: new Date(NOW),
      df1DiskId: 'g3-d1', df1Sha256: T, df1Version: 6 });
  });
  afterAll(async () => {
    await closeDb();
    await admin(`drop database if exists ${DB} with (force)`);
  });

  it('ejects DF0 and DF1, bumps both cursors, names both boards, and deletes the title', async () => {
    const r = await deleteGames(ORG, ['g1'], { now: NOW });
    expect(r.deleted).toEqual(['g1']);
    expect([...r.ejected].sort()).toEqual(['A1200', 'A500']);
    const [b1] = await getDb().select().from(devices).where(eq(devices.id, 'b1'));
    const [b2] = await getDb().select().from(devices).where(eq(devices.id, 'b2'));
    expect(b1).toMatchObject({ desiredDiskId: null, desiredSha256: null, desiredVersion: 5 });
    expect(b2).toMatchObject({ df1DiskId: null, df1Version: 3 });
  });

  it("leaves a board's DF1 pick of a surviving title alone, even while it still reports the deleted bytes (re-review C-new)", async () => {
    // CD32 has been told to load Other (g3-d1) in DF1 and still reports the old T bytes: it is already replacing them,
    // and clearing its pick would drop the disk the user just chose.
    const r = await deleteGames(ORG, ['g2'], { now: NOW });
    expect(r.deleted).toEqual(['g2']);
    expect(r.ejected).toEqual([]);
    const [b3] = await getDb().select().from(devices).where(eq(devices.id, 'b3'));
    expect(b3).toMatchObject({ df1DiskId: 'g3-d1', df1Version: 6 });
  });
});
