import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

// Wi-Fi networks (migration 0060): recordStatus's `wifi` tail and requestWifi's conditional UPDATE on the real
// columns. The review of 3bf330b2 (I1): a restarted board's first reports carry ack 0 / res null, and re-ack an
// old seq as 'none' -- neither may lower the ack or wipe the result, or deliverWifi sends the request again.
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_wifi_networks_test';
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
const { requestWifi, readWifiRow } = await import('./wifi-networks-store');
const { deliverWifi } = await import('./wifi-networks');

const ID = 'wifi-dev-01', ORG = 'org-wifi', FW = '1.26.0+gabc';
const HOME = '486f6d65', PHONE = '50686f6e65';
const row = async () => (await getDb().select().from(devices).where(eq(devices.id, ID)))[0]!;
const report = (wifi?: { nets: string[]; cur: number; ack: number; res: string | null; setup: number }, fw = FW) =>
  recordStatus(ID, { mountedSha256: null, firmwareVersion: fw, ...(wifi ? { wifi } : {}) });

describe('Wi-Fi networks in the database', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
    await getDb().insert(devices).values({ id: ID, orgId: ORG, name: 'Wifi', macAddress: 'AA:BB:CC:DD:EE:02', tokenHash: 'h-wifi' });
  });
  afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

  it('starts as a board that has not reported, and refuses requests then', async () => {
    const r = await row();
    expect([r.wifiNets, r.wifiSeq, r.wifiOp, r.wifiAck]).toEqual([null, 0, 'none', null]);
    expect(await requestWifi(ORG, ID, 'open', null)).toBe('firmware_too_old');
  });

  it('stores the tail, and a report without it from the same build keeps it', async () => {
    await report({ nets: [HOME, PHONE], cur: 0, ack: 0, res: null, setup: 0 });
    let r = await row();
    expect([r.wifiNets, r.wifiCurrent, r.wifiFirmware, r.wifiSetupUntil]).toEqual([[HOME, PHONE], 0, FW, null]);
    await report();
    r = await row();
    expect(r.wifiNets).toEqual([HOME, PHONE]);
  });

  it('guards a remove: not the network in use, not the last one, only a saved one', async () => {
    expect(await requestWifi(ORG, ID, 'remove', HOME)).toBe('in_use');
    expect(await requestWifi(ORG, ID, 'remove', '41')).toBe('not_saved');
    expect(await requestWifi('other-org', ID, 'remove', PHONE)).toBe('not_found');
    expect(await requestWifi(ORG, ID, 'remove', PHONE)).toEqual({ seq: 1 });
    expect(await requestWifi(ORG, ID, 'cancel', null)).toEqual({ seq: 2 });   // still waiting: a cancel is a seq
    expect((await row()).wifiOp).toBe('none');
  });

  it('a restarted board can neither lower the ack nor wipe the result (I1)', async () => {
    await requestWifi(ORG, ID, 'remove', PHONE);   // seq 3
    await report({ nets: [HOME], cur: 0, ack: 3, res: 'ok', setup: 0 });
    let r = await row();
    expect([r.wifiAck, r.wifiResult]).toEqual([3, 'ok']);
    // The OTA trial's first report: ack 0, nothing handled yet.
    await report({ nets: [HOME], cur: 0, ack: 0, res: null, setup: 0 });
    r = await row();
    expect([r.wifiAck, r.wifiResult]).toEqual([3, 'ok']);
    // The server sends 'none' for a seq it heard, so the request is not run twice...
    expect(deliverWifi((await readWifiRow(ID))!, Date.now())).toEqual({ seq: 3, op: 'none' });
    // ...and the board's re-ack of it as 'none' does not overwrite what it did.
    await report({ nets: [HOME], cur: 0, ack: 3, res: 'none', setup: 0 });
    r = await row();
    expect([r.wifiAck, r.wifiResult]).toEqual([3, 'ok']);
    // A newer seq's answer is taken.
    await requestWifi(ORG, ID, 'open', null);   // seq 4
    await report({ nets: [HOME], cur: 0, ack: 4, res: 'disk', setup: 0 });
    r = await row();
    expect([r.wifiAck, r.wifiResult]).toEqual([4, 'disk']);
  });

  it('stores when the setup page closes, and clears it when closed', async () => {
    const before = Date.now();
    await report({ nets: [HOME], cur: 0, ack: 4, res: 'disk', setup: 600 });
    const until = (await row()).wifiSetupUntil!.getTime();
    expect(until).toBeGreaterThanOrEqual(before + 599_000);
    await report({ nets: [HOME], cur: 0, ack: 4, res: 'disk', setup: 0 });
    expect((await row()).wifiSetupUntil).toBeNull();
  });

  it('a report naming another build without the tail clears the list (an older or reverted firmware)', async () => {
    await report(undefined, '1.24.2+gold');
    const r = await row();
    expect([r.wifiNets, r.wifiCurrent]).toEqual([null, null]);
    expect(await requestWifi(ORG, ID, 'open', null)).toBe('firmware_too_old');
  });
});
