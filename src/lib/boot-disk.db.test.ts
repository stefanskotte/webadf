import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from 'pg';

// Disk at startup (2026-10-19, migration 0045): the real columns and the one UPDATE that decides a boot. A board on
// "No disk" comes back from a power-up with DF0 empty -- the desired disk is cleared at the FIRST request of a boot
// the server has not seen -- and never on a reconnect (the same boot id) or an update's own reboot (ota).
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_boot_disk_test';
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
const { touchLastSeen } = await import('./mount');
const { noteBoot, saveBootDisk } = await import('./boot-disk-store');

const ID = 'boot-dev-01';
const ORG = 'org-boot';
const SHA = 'a'.repeat(64);
const row = async () => (await getDb().select().from(devices).where(eq(devices.id, ID)))[0]!;
async function mounted(version = 4) {
  await getDb().update(devices).set({
    desiredSha256: SHA, desiredGameId: 'g1', desiredDiskNo: 1, desiredDiskId: 'd1', desiredVersion: version,
  }).where(eq(devices.id, ID));
}

describe('Disk at startup', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
    await getDb().insert(devices).values({ id: ID, orgId: ORG, name: 'Device AA:BB:CC:DD:EE:02',
      macAddress: 'AA:BB:CC:DD:EE:02', tokenHash: 'h-boot', firmwareVersion: '1.18.1+gabc1234' });
  });
  afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });
  // Every test but the baseline ones starts from a board whose earlier boot (0000000b) the server has heard.
  beforeEach(async () => {
    await getDb().update(devices).set({ bootDisk: 'last', bootId: '0000000b', prevBootId: null,
      firmwareVersion: '1.18.1+gabc1234' }).where(eq(devices.id, ID));
  });
  const fresh = () => getDb().update(devices).set({ bootId: null, prevBootId: null }).where(eq(devices.id, ID));

  it('defaults to the last disk, with no boot heard', async () => {
    const id = 'boot-dev-fresh';
    await getDb().insert(devices).values({ id, orgId: ORG, name: 'Device AA:BB:CC:DD:EE:03',
      macAddress: 'AA:BB:CC:DD:EE:03', tokenHash: 'h-boot-2' });
    const [r] = await getDb().select().from(devices).where(eq(devices.id, id));
    expect(r.bootDisk).toBe('last');
    expect(r.bootId).toBeNull();
    expect(r.prevBootId).toBeNull();
  });

  // Fix round 1: the first boot id ever heard from a board is only a baseline. The update that installs 1.18.1
  // reboots under OLDER firmware, which writes no update mark -- that boot must never be the one that empties DF0.
  it('the first boot ever heard is a baseline: recorded, never cleared', async () => {
    await saveBootDisk(ORG, ID, 'empty');
    await fresh();
    await mounted(4);
    await noteBoot(ID, { id: '1a2b3c4d', ota: false });
    const r = await row();
    expect(r.bootId).toBe('1a2b3c4d');
    expect(r.desiredSha256).toBe(SHA);
    expect(r.desiredVersion).toBe(4);
  });

  // Fix round 1: a late request from the previous boot (A), landing after the new boot's (B) first one, neither
  // clears again nor makes B look new a second time.
  it('A, B, a late A, then B again: exactly one clear', async () => {
    await saveBootDisk(ORG, ID, 'empty');
    await fresh();
    await mounted(4);
    await noteBoot(ID, { id: 'aaaaaaaa', ota: false });    // baseline
    await noteBoot(ID, { id: 'bbbbbbbb', ota: false });    // power-up: cleared, version 5
    expect((await row()).desiredVersion).toBe(5);
    await mounted(6);                                       // a tag tapped in boot B
    await touchLastSeen(ID, { id: 'aaaaaaaa', ota: false }); // boot A's request, late
    let r = await row();
    expect(r.desiredSha256).toBe(SHA);
    expect(r.bootId).toBe('bbbbbbbb');
    expect(r.prevBootId).toBe('aaaaaaaa');
    await noteBoot(ID, { id: 'bbbbbbbb', ota: false });    // boot B again
    r = await row();
    expect(r.desiredSha256).toBe(SHA);
    expect(r.desiredVersion).toBe(6);
  });

  it('on Last disk, a boot is recorded and the disk comes back', async () => {
    await mounted();
    await noteBoot(ID, { id: '1a2b3c4d', ota: false });
    const r = await row();
    expect(r.bootId).toBe('1a2b3c4d');
    expect(r.desiredSha256).toBe(SHA);
    expect(r.desiredVersion).toBe(4);
  });

  it('on No disk, the first request of a new boot empties DF0 and moves the version', async () => {
    await saveBootDisk(ORG, ID, 'empty');
    await mounted(4);
    await noteBoot(ID, { id: '1a2b3c4d', ota: false });
    const r = await row();
    expect(r.desiredSha256).toBeNull();
    expect(r.desiredDiskId).toBeNull();
    expect(r.desiredGameId).toBeNull();
    expect(r.desiredDiskNo).toBeNull();
    expect(r.desiredVersion).toBe(5);
    expect(r.bootId).toBe('1a2b3c4d');
  });

  it('a reconnect (the same boot) never ejects a disk mounted after the boot', async () => {
    await saveBootDisk(ORG, ID, 'empty');
    await mounted(4);
    await noteBoot(ID, { id: '1a2b3c4d', ota: false });   // power-up: emptied, version 5
    await mounted(6);                                       // a tag tapped, the game runs
    await noteBoot(ID, { id: '1a2b3c4d', ota: false });   // Wi-Fi drops and comes back
    await touchLastSeen(ID, { id: '1a2b3c4d', ota: false }); // ...and polls
    const r = await row();
    expect(r.desiredSha256).toBe(SHA);
    expect(r.desiredVersion).toBe(6);
  });

  it('the poll path (touchLastSeen with a boot) decides a boot the same way', async () => {
    await saveBootDisk(ORG, ID, 'empty');
    await mounted(4);
    const before = (await row()).lastSeenAt;
    await touchLastSeen(ID, { id: '0badf00d', ota: false });
    const r = await row();
    expect(r.desiredSha256).toBeNull();
    expect(r.desiredVersion).toBe(5);
    expect(r.lastSeenAt!.getTime()).toBeGreaterThanOrEqual(before?.getTime() ?? 0);
    // A poll without a boot (older firmware) changes nothing but last_seen_at.
    await mounted(6);
    await touchLastSeen(ID);
    expect((await row()).desiredSha256).toBe(SHA);
  });

  it('an update boot keeps the disk, and the next power-up still empties it', async () => {
    await saveBootDisk(ORG, ID, 'empty');
    await mounted(4);
    await noteBoot(ID, { id: '11111111', ota: true });
    expect((await row()).desiredSha256).toBe(SHA);
    expect((await row()).bootId).toBe('11111111');
    await noteBoot(ID, { id: '22222222', ota: false });
    expect((await row()).desiredSha256).toBeNull();
  });

  it('a boot with nothing desired moves nothing', async () => {
    await saveBootDisk(ORG, ID, 'empty');
    await getDb().update(devices).set({ desiredSha256: null, desiredGameId: null, desiredDiskNo: null,
      desiredDiskId: null, desiredVersion: 9 }).where(eq(devices.id, ID));
    await noteBoot(ID, { id: '33333333', ota: false });
    expect((await row()).desiredVersion).toBe(9);
  });

  it('DF1 is not touched by a boot', async () => {
    await saveBootDisk(ORG, ID, 'empty');
    await mounted(4);
    await getDb().update(devices).set({ df1Version: 3 }).where(eq(devices.id, ID));
    await noteBoot(ID, { id: '44444444', ota: false });
    expect((await row()).df1Version).toBe(3);
  });

  it('No disk needs firmware 1.18.1 by the reported version; Last disk is never refused', async () => {
    await getDb().update(devices).set({ firmwareVersion: '1.18.0+gabc1234' }).where(eq(devices.id, ID));
    expect(await saveBootDisk(ORG, ID, 'empty')).toBe('firmware_too_old');
    expect((await row()).bootDisk).toBe('last');
    expect(await saveBootDisk(ORG, ID, 'last')).toBe('ok');
    await getDb().update(devices).set({ firmwareVersion: '1.19.0+gabc1234' }).where(eq(devices.id, ID));
    expect(await saveBootDisk(ORG, ID, 'empty')).toBe('ok');
    expect((await row()).bootDisk).toBe('empty');
  });

  it('another org cannot set it', async () => {
    expect(await saveBootDisk('org-other', ID, 'empty')).toBe('not_found');
    expect(await saveBootDisk(ORG, 'no-such-device', 'last')).toBe('not_found');
    expect((await row()).bootDisk).toBe('last');
  });
});
