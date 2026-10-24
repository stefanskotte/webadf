import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

// A database of its own (the shared one is the live one).
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_game_detail_kind_test';
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
const { games, disks, blobs } = await import('@/db/schema/catalog');
const { tosecEntries } = await import('@/db/schema/tosec');
const { getGameDetail } = await import('./queries');

const ORG = 'org-kind';

async function seed(id: string, setNames: Array<string | null>) {
  await getDb().insert(games).values({ id, orgId: ORG, title: id, sortTitle: id });
  for (const [i, setName] of setNames.entries()) {
    const sha = `${id}-${i}`.padEnd(64, '0');
    let entryId: string | null = null;
    if (setName) {
      entryId = `${id}-entry-${i}`;
      await getDb().insert(tosecEntries).values({
        id: entryId, setName, gameName: id, romName: `${id}-${i}.adf`, sizeBytes: 901120, title: id, sortTitle: id,
      });
    }
    await getDb().insert(blobs).values({ sha256: sha, sizeBytes: 901120, storageKey: sha, tosecEntryId: entryId });
    await getDb().insert(disks).values({ id: `${id}-d${i}`, gameId: id, orgId: ORG, diskNo: i + 1, sha256: sha, sizeBytes: 901120 });
  }
}

describe('getGameDetail kind', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
    await seed('g-game', ['Commodore Amiga - Games - [ADF]']);
    await seed('g-demo', ['Commodore Amiga - Demos - Various - [ADF]']);
    await seed('g-app', ['Commodore Amiga - Applications - [ADF]']);
    await seed('g-none', [null]);
    await seed('g-mixed', ['Commodore Amiga - Demos - Various - [ADF]', 'Commodore Amiga - Games - [ADF]']);
  });
  afterAll(async () => {
    await closeDb();
    await admin(`drop database if exists ${DB} with (force)`);
  });

  it('is the TOSEC set kind, by the same rule the list uses', async () => {
    expect((await getGameDetail(ORG, 'g-game'))?.kind).toBe('Game');
    expect((await getGameDetail(ORG, 'g-demo'))?.kind).toBe('Demo');
    expect((await getGameDetail(ORG, 'g-app'))?.kind).toBe('App');
  });

  it('is null for an unrecognised title, and breaks a tie alphabetically for a mixed set', async () => {
    expect((await getGameDetail(ORG, 'g-none'))?.kind).toBeNull();
    expect((await getGameDetail(ORG, 'g-mixed'))?.kind).toBe('Demo');
  });
});
