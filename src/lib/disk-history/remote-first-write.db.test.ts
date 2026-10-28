import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Client } from 'pg';
import { createHash } from 'node:crypto';

// Library sharing D2 (spec §4.2 First write): the first change recorded on a hidden remote disk makes it, and its
// title, the person's own -- remote columns cleared in the same transaction, ids unchanged, and the title then shows
// in their library as Uncategorized.
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_remote_first_write_test';
const url = new URL(base);
url.pathname = `/${DB}`;
process.env.DATABASE_URL = url.toString();

async function admin(stmt: string) {
  const c = new Client({ connectionString: base });
  await c.connect();
  try { await c.query(stmt); } finally { await c.end(); }
}

vi.mock('@/lib/storage', () => ({
  diskStore: { put: async () => ({ key: 'x' }), storageKey: (sha: string) => `adf/${sha}` },
}));

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { eq } = await import('drizzle-orm');
const { blobs, disks, games } = await import('@/db/schema/catalog');
const { remoteLibraries } = await import('@/db/schema/sharing');
const { recordVersion } = await import('./store');
const { listGames, getGameDetail } = await import('@/lib/queries');
const { ownCopyGameId } = await import('@/lib/remote-hidden');
const { ADF_BYTES } = await import('@/lib/adfmfm');

const ORG = 'org-d2';
const head = new Uint8Array(ADF_BYTES);
const headSha = createHash('sha256').update(head).digest('hex');
const next = head.slice();
next[100] = 7;

describe('first write to a hidden remote disk (D2)', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
    const db = getDb();
    await db.insert(remoteLibraries).values({ id: 'rl', orgId: ORG, baseUrl: 'https://owner.example', tokenEnc: 'v1.x', name: 'Rob', addedBy: 'u1' });
    await db.insert(blobs).values({ sha256: headSha, sizeBytes: head.length, storageKey: headSha });
    await db.insert(games).values({ id: 'hg', orgId: ORG, title: 'Shared game', sortTitle: 'shared game', remoteLibraryId: 'rl', remoteTitleId: 'T1', metadataSource: 'remote' });
    await db.insert(disks).values({ id: 'hd', gameId: 'hg', orgId: ORG, diskNo: 1, sha256: headSha, sizeBytes: head.length, writeProtected: false, remoteLibraryId: 'rl', remoteDiskId: 'D1' });
    // A local disk: the write path must leave its (null) columns and its title alone.
    await db.insert(games).values({ id: 'lg', orgId: ORG, title: 'Local game', sortTitle: 'local game' });
    await db.insert(disks).values({ id: 'ld', gameId: 'lg', orgId: ORG, diskNo: 1, sha256: headSha, sizeBytes: head.length, writeProtected: false });
  });
  afterAll(async () => {
    await closeDb();
    await admin(`drop database if exists ${DB} with (force)`);
  });

  it('hidden before the write: not in Uncategorized', async () => {
    const ids = (await listGames(ORG, { uncategorized: true })).map((g) => g.id);
    expect(ids).toEqual(['lg']);
  });

  it('an Amiga write makes the disk local, in a local copy of its title; the hidden title stays hidden', async () => {
    const r = await recordVersion({
      orgId: ORG, diskId: 'hd', headSha, head, next, source: 'amiga', deviceId: null, sourceFilename: 'Shared game.adf',
    });
    expect(r).not.toBeNull();
    const db = getDb();
    const own = ownCopyGameId(ORG, 'rl', 'T1');
    const [d] = await db.select().from(disks).where(eq(disks.id, 'hd'));
    expect(d).toMatchObject({ id: 'hd', gameId: own, remoteLibraryId: null, remoteDiskId: null, sha256: r!.sha256 });
    const [g] = await db.select().from(games).where(eq(games.id, own));
    expect(g).toMatchObject({ id: own, title: 'Shared game', sortTitle: 'shared game', remoteLibraryId: null, remoteTitleId: null });
    // The hidden stand-in keeps its remote columns: other disks of the title may still be mounted through it.
    const [h] = await db.select().from(games).where(eq(games.id, 'hg'));
    expect(h.remoteLibraryId).toBe('rl');
    // Uncategorized now holds it, named as it was
    const listed = await listGames(ORG, { uncategorized: true });
    expect(listed.map((x) => x.id).sort()).toEqual([own, 'lg'].sort());
    expect(listed.find((x) => x.id === own)?.title).toBe('Shared game');
  });

  it('a hidden disk of the same title never shows under the person\'s own copy (Review Focus 2)', async () => {
    const db = getDb();
    // Disk 2 of T1, mounted after disk 1 took its write: hidden, in the hidden stand-in.
    await db.insert(disks).values({ id: 'hd1b', gameId: 'hg', orgId: ORG, diskNo: 2, sha256: headSha, sizeBytes: head.length, writeProtected: false, remoteLibraryId: 'rl', remoteDiskId: 'D1b' });
    const own = ownCopyGameId(ORG, 'rl', 'T1');
    const detail = await getGameDetail(ORG, own);
    expect(detail?.disks.map((x) => x.id)).toEqual(['hd']);
    // Its own first write joins the same local title, not a second one.
    await recordVersion({ orgId: ORG, diskId: 'hd1b', headSha, head, next, source: 'amiga', sourceFilename: 'Shared game 2.adf' });
    const [d] = await db.select().from(disks).where(eq(disks.id, 'hd1b'));
    expect(d).toMatchObject({ gameId: own, remoteLibraryId: null });
    expect((await getGameDetail(ORG, own))?.disks.map((x) => x.id)).toEqual(['hd', 'hd1b']);
    expect((await listGames(ORG, { uncategorized: true })).filter((x) => x.title === 'Shared game')).toHaveLength(1);
  });

  it('a write to a local disk changes nothing but its bytes', async () => {
    await recordVersion({ orgId: ORG, diskId: 'ld', headSha, head, next, source: 'amiga', sourceFilename: 'Local.adf' });
    const [g] = await getDb().select().from(games).where(eq(games.id, 'lg'));
    expect(g.remoteLibraryId).toBeNull();
    expect(g.title).toBe('Local game');
  });

  it('another org cannot clear a hidden row through its own write', async () => {
    const db = getDb();
    await db.insert(games).values({ id: 'hg2', orgId: ORG, title: 'Still hidden', sortTitle: 'still hidden', remoteLibraryId: 'rl', remoteTitleId: 'T2' });
    await db.insert(disks).values({ id: 'hd2', gameId: 'hg2', orgId: ORG, diskNo: 1, sha256: headSha, sizeBytes: head.length, writeProtected: false, remoteLibraryId: 'rl', remoteDiskId: 'D2' });
    await recordVersion({ orgId: 'org-else', diskId: 'hd2', headSha, head, next, source: 'amiga', sourceFilename: 'x.adf' }).catch(() => null);
    const [d] = await db.select().from(disks).where(eq(disks.id, 'hd2'));
    expect(d.remoteLibraryId).toBe('rl');
    const [g] = await db.select().from(games).where(eq(games.id, 'hg2'));
    expect(g.remoteLibraryId).toBe('rl');
  });
});
