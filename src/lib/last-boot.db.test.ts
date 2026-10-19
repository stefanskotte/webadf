import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

// devices.last_boot / nfc_last_fail (migration 0046, fw 1.18.2): the boot trail and the newest tag failure as
// recordStatus stores them -- the real columns, so a jsonb that does not round-trip (or a migration that never
// ran) fails here.
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_last_boot_test';
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

const ID = 'lastboot-dev-01';
const read = async () => (await getDb().select({
  lb: devices.lastBoot, at: devices.lastBootAt, f: devices.nfcLastFail, fat: devices.nfcLastFailAt,
}).from(devices).where(eq(devices.id, ID)))[0]!;

describe('devices.last_boot and nfc_last_fail', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
    await getDb().insert(devices).values({ id: ID, orgId: 'org-lb', name: 'Device AA:BB:CC:DD:EE:46',
      macAddress: 'AA:BB:CC:DD:EE:46', tokenHash: 'h-lb' });
  });
  afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

  it('is null for a board that never sent one', async () => {
    const r = await read();
    expect(r.lb).toBeNull();
    expect(r.f).toBeNull();
  });
  it('stores the previous boot with when it arrived, and keeps it across reports that do not carry it', async () => {
    const lb = { reset: 'watchdog' as const, c0: 'i2c' as const, up0: 0, upd: 'i2c' as const };
    await recordStatus(ID, { mountedSha256: null, firmwareVersion: '1.18.2+gabc', lastBoot: lb });
    let r = await read();
    expect(r.lb).toEqual(lb);
    expect(r.at).toBeInstanceOf(Date);
    await recordStatus(ID, { mountedSha256: null, firmwareVersion: '1.18.2+gabc' });
    r = await read();
    expect(r.lb).toEqual(lb);                          // sent once a boot: the next report says nothing about it
  });
  it('stores the newest tag failure', async () => {
    await recordStatus(ID, { mountedSha256: null, nfcFail: 'locked:0x14@A2' });
    const r = await read();
    expect(r.f).toBe('locked:0x14@A2');
    expect(r.fat).toBeInstanceOf(Date);
  });
});
