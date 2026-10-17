import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_send_targets_test';
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
const { blobs, games, disks, entitlements } = await import('@/db/schema/catalog');
const S = await import('./send-targets');

const NOW = Date.now();
async function board(id: string, orgId: string, extra: Partial<typeof devices.$inferInsert> = {}) {
  await getDb().insert(devices).values({ id, orgId, name: `Device AA:BB:CC:DD:EE:${id.slice(-2)}`,
    macAddress: `AA:BB:CC:DD:EE:${id.slice(-2)}`, tokenHash: `h-${id}`, ...extra });
}

describe('send targets', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
    await board('t-01', 'org-a', { firmwareVersion: '1.15.0+gabc', lastSeenAt: new Date(NOW - 5_000), secondDriveReported: 'net',
      sendRx: 'c', sendRxAt: new Date(NOW - 10_000) });
    await board('t-02', 'org-a', { firmwareVersion: '1.13.0+gdef', lastSeenAt: new Date(NOW) });
    await board('t-03', 'org-a', { firmwareVersion: '1.14.0+g123', lastSeenAt: new Date(NOW) });
    await board('t-04', 'org-b', { firmwareVersion: '1.15.0', lastSeenAt: new Date(NOW) });
    await board('t-05', 'org-a', { name: 'Attic', firmwareVersion: '1.16.0+g456', lastSeenAt: new Date(NOW - 30 * 86_400_000) });
  });
  afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

  it('lists this org\'s boards on 1.15.0 or newer, online first (R1, D11)', async () => {
    const ts = await S.listSendTargets(getDb(), 'org-a', NOW);
    expect(ts.map((t) => t.id)).toEqual(['t-01', 't-05']);
    expect(ts[0]).toMatchObject({ online: true, network: true, rx: 'c', defaultName: true });
    expect(ts[1]).toMatchObject({ name: 'Attic', online: false, network: false, rx: null, defaultName: false });
  });

  it('findSendTarget refuses an old board and another org\'s board', async () => {
    expect(await S.findSendTarget(getDb(), 'org-a', 't-01', NOW)).not.toBeNull();
    expect(await S.findSendTarget(getDb(), 'org-a', 't-02', NOW)).toBeNull();
    expect(await S.findSendTarget(getDb(), 'org-a', 't-04', NOW)).toBeNull();
  });

  it('loadSendDisk reads a disk through this org\'s entitlement only', async () => {
    const sha = 'e'.repeat(64);
    await getDb().insert(blobs).values({ sha256: sha, sizeBytes: 901120, storageKey: `adf/${sha}` });
    await getDb().insert(games).values({ id: 'g1', orgId: 'org-a', title: 'T', sortTitle: 't', metadataSource: 'filename' });
    await getDb().insert(disks).values({ id: 'k1', gameId: 'g1', orgId: 'org-a', diskNo: 1, sha256: sha, sizeBytes: 901120, label: 'T' });
    await getDb().insert(entitlements).values({ orgId: 'org-a', sha256: sha, sourceFilename: 'T-1.adf' });
    expect(await S.loadSendDisk(getDb(), 'org-a', 'k1')).toMatchObject({ sha256: sha, sourceFilename: 'T-1.adf', diskNo: 1, imageFormat: 'adf' });
    expect(await S.loadSendDisk(getDb(), 'org-b', 'k1')).toBeNull();
  });
});
