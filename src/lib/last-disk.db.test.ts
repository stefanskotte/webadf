import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

// "Re-insert last disk" (A4, migration 0048): an eject asked through the web remembers the disk the drive held, or
// the one on its way in; an eject of an already-empty drive keeps the earlier memory; deleting the disk forgets it.
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_last_disk_test';
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
const { devices } = await import('@/db/schema/devices');
const { games, disks, blobs } = await import('@/db/schema/catalog');
const { clearDesired } = await import('./mount');

const ORG = 'org-last';
const DEV = 'dev-last';
const sha = (n: number) => String(n).padStart(64, '0');
const row = async () => (await getDb().select().from(devices).where(eq(devices.id, DEV)))[0]!;
const set = (patch: Partial<typeof devices.$inferInsert>) => getDb().update(devices).set(patch).where(eq(devices.id, DEV));

describe('last disk', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
    const db = getDb();
    await db.insert(blobs).values([1, 2].map((n) => ({ sha256: sha(n), sizeBytes: 100, storageKey: sha(n) })));
    await db.insert(games).values([{ id: 'g1', orgId: ORG, title: 'One', sortTitle: 'one' }, { id: 'g2', orgId: ORG, title: 'Two', sortTitle: 'two' }]);
    await db.insert(disks).values([
      { id: 'd1', gameId: 'g1', orgId: ORG, diskNo: 1, sha256: sha(1), sizeBytes: 100 },
      { id: 'd2', gameId: 'g2', orgId: ORG, diskNo: 1, sha256: sha(2), sizeBytes: 100 },
    ]);
    await db.insert(devices).values({ id: DEV, orgId: ORG, name: 'B', macAddress: 'AA:BB:CC:DD:EE:10', tokenHash: 'h-last' });
  });
  afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

  it('an eject remembers the disk the drive held', async () => {
    await set({ mountedDiskId: 'd1', desiredDiskId: 'd1', desiredSha256: sha(1) });
    await clearDesired(ORG, DEV);
    expect((await row()).lastDiskId).toBe('d1');
  });

  it('an eject of a disk still on its way in remembers that one', async () => {
    await set({ mountedDiskId: 'd1', desiredDiskId: 'd2', desiredSha256: sha(2) });
    await clearDesired(ORG, DEV);
    expect((await row()).lastDiskId).toBe('d2');
  });

  it('an eject of an empty drive keeps the earlier memory', async () => {
    await set({ mountedDiskId: null, desiredDiskId: null, desiredSha256: null });
    await clearDesired(ORG, DEV);
    expect((await row()).lastDiskId).toBe('d2');
  });

  it("another org's eject call changes nothing", async () => {
    await set({ mountedDiskId: 'd1', desiredDiskId: 'd1' });
    await clearDesired('org-other', DEV);
    expect((await row()).lastDiskId).toBe('d2');
  });

  it('deleting the disk forgets it', async () => {
    await set({ mountedDiskId: null, desiredDiskId: null });
    await getDb().delete(disks).where(eq(disks.id, 'd2'));
    expect((await row()).lastDiskId).toBeNull();
  });
});
