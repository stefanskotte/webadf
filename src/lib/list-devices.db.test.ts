import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

// listDevices' mountedGameId / desiredGameId (Devices spec §4.3, Task 1): taken from the ORG-SCOPED game aliases, never
// from devices.*_game_id, which are plain text columns with no foreign key and can name another org's game.
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_list_devices_test';
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
const { games } = await import('@/db/schema/catalog');
const { listDevices } = await import('./queries');

describe('listDevices mountedGameId / desiredGameId', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
    const db = getDb();
    await db.insert(games).values([
      { id: 'g-a', orgId: 'org-a', title: 'Own Game', sortTitle: 'own game' },
      { id: 'g-b', orgId: 'org-b', title: 'Foreign Game', sortTitle: 'foreign game' },
    ]);
    await db.insert(devices).values([
      // Own-org game on both sides.
      { id: 'dev-own', orgId: 'org-a', name: 'Own', macAddress: 'AA:BB:CC:DD:EE:01', tokenHash: 'h1',
        mountedGameId: 'g-a', desiredGameId: 'g-a' },
      // Org A's device naming org B's game on both sides.
      { id: 'dev-foreign', orgId: 'org-a', name: 'Foreign', macAddress: 'AA:BB:CC:DD:EE:02', tokenHash: 'h2',
        mountedGameId: 'g-b', desiredGameId: 'g-b' },
      { id: 'dev-empty', orgId: 'org-a', name: 'Empty', macAddress: 'AA:BB:CC:DD:EE:03', tokenHash: 'h3' },
    ]);
  });
  afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

  it('returns the id of an own-org game', async () => {
    const d = (await listDevices('org-a')).find((x) => x.id === 'dev-own')!;
    expect(d.mountedGameId).toBe('g-a');
    expect(d.desiredGameId).toBe('g-a');
    expect(d.mountedGame).toBe('Own Game');
  });
  it('returns null for a game of another org, with no title either', async () => {
    const d = (await listDevices('org-a')).find((x) => x.id === 'dev-foreign')!;
    expect(d.mountedGameId).toBeNull();
    expect(d.desiredGameId).toBeNull();
    expect(d.mountedGame).toBeNull();
  });
  it('returns null when nothing is named', async () => {
    const d = (await listDevices('org-a')).find((x) => x.id === 'dev-empty')!;
    expect(d.mountedGameId).toBeNull();
    expect(d.desiredGameId).toBeNull();
  });
});
