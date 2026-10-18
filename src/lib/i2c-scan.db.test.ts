import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

// devices.i2c_addrs (migration 0044): the boot I2C scan as recordStatus stores it -- the real column, so an
// int[] that does not round-trip through node-postgres (or a migration that never ran) fails here.
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_i2c_scan_test';
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
const { recordStatus } = await import('./mount');

const ID = 'i2c-dev-01';
const read = async () => (await getDb().select({ a: devices.i2cAddrs }).from(devices).where(eq(devices.id, ID)))[0]!.a;

describe('devices.i2c_addrs', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
    await getDb().insert(devices).values({ id: ID, orgId: 'org-i2c', name: 'Device AA:BB:CC:DD:EE:01',
      macAddress: 'AA:BB:CC:DD:EE:01', tokenHash: 'h-i2c' });
  });
  afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

  it('is null for a board that never sent a scan', async () => {
    expect(await read()).toBeNull();
  });
  it('stores the scan a status report carries, and the empty list as empty', async () => {
    await recordStatus(ID, { mountedSha256: null, firmwareVersion: '1.17.0+gabc', i2c: [0x28, 0x3c] });
    expect(await read()).toEqual([40, 60]);
    await recordStatus(ID, { mountedSha256: null, firmwareVersion: '1.17.0+gabc', i2c: [] });
    expect(await read()).toEqual([]);
  });
  it('a report without firmwareVersion leaves it; one from an older build clears it', async () => {
    await recordStatus(ID, { mountedSha256: null, firmwareVersion: '1.17.0+gabc', i2c: [0x3c] });
    await recordStatus(ID, { mountedSha256: null });
    expect(await read()).toEqual([60]);
    await recordStatus(ID, { mountedSha256: null, firmwareVersion: '1.16.0+gabc' });
    expect(await read()).toBeNull();
  });
});
