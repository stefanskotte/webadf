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
const { devices } = await import('@/db/schema/devices');
const { readDesired } = await import('@/lib/mount');
const { purgeHidden } = await import('@/lib/remote/store');
const { MACHINE_SOURCES } = await import('@/lib/tosec-apply');

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
    expect(g).toMatchObject({
      id: own, title: 'Shared game', sortTitle: 'shared game', remoteLibraryId: null, remoteTitleId: null,
      // The notice's name (spec §4.2): the remote library's name at copy time.
      copiedFrom: 'Rob',
    });
    // A machine source: scans may re-identify it, and it never wins a dedupe as a human edit.
    expect(g.metadataSource).toBe('filename');
    expect(MACHINE_SOURCES).toContain(g.metadataSource);
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

  it('a board holding the disk follows it into the own copy; a purge of the stand-in leaves its title intact', async () => {
    const db = getDb();
    await db.insert(games).values({ id: 'hg4', orgId: ORG, title: 'Held game', sortTitle: 'held game', remoteLibraryId: 'rl', remoteTitleId: 'T4', metadataSource: 'remote' });
    await db.insert(disks).values({ id: 'hd4', gameId: 'hg4', orgId: ORG, diskNo: 1, sha256: headSha, sizeBytes: head.length, writeProtected: false, remoteLibraryId: 'rl', remoteDiskId: 'D4' });
    await db.insert(devices).values({
      id: 'dev4', orgId: ORG, name: 'Board', tokenHash: 'h'.repeat(64),
      desiredSha256: headSha, desiredGameId: 'hg4', desiredDiskId: 'hd4', desiredDiskNo: 1, desiredVersion: 3,
      mountedSha256: headSha, mountedGameId: 'hg4', mountedDiskId: 'hd4',
    });
    // Another board holding a different disk is left alone.
    await db.insert(devices).values({ id: 'dev5', orgId: ORG, name: 'Other', tokenHash: 'i'.repeat(64), desiredGameId: 'lg', desiredDiskId: 'ld', mountedGameId: 'lg', mountedDiskId: 'ld' });
    await recordVersion({ orgId: ORG, diskId: 'hd4', headSha, head, next, source: 'amiga', sourceFilename: 'Held.adf' });
    const own = ownCopyGameId(ORG, 'rl', 'T4');
    const [dev] = await db.select().from(devices).where(eq(devices.id, 'dev4'));
    expect(dev).toMatchObject({ desiredGameId: own, mountedGameId: own, desiredDiskId: 'hd4', mountedDiskId: 'hd4' });
    const [other] = await db.select().from(devices).where(eq(devices.id, 'dev5'));
    expect(other).toMatchObject({ desiredGameId: 'lg', mountedGameId: 'lg' });
    // The revoke's purge deletes the now-empty stand-in; the board's title still comes through.
    await purgeHidden(ORG, 'rl');
    expect(await db.select().from(games).where(eq(games.id, 'hg4'))).toEqual([]);
    const d = await readDesired('dev4');
    expect(d?.desired).toMatchObject({ game: 'Held game', gameId: own, diskId: 'hd4' });
  });

  it('two first writes at once to two disks of one title make exactly one own copy holding both', async () => {
    const db = getDb();
    await db.insert(games).values({ id: 'hg6', orgId: ORG, title: 'Pair game', sortTitle: 'pair game', remoteLibraryId: 'rl', remoteTitleId: 'T6', metadataSource: 'remote' });
    await db.insert(disks).values([
      { id: 'hd6a', gameId: 'hg6', orgId: ORG, diskNo: 1, sha256: headSha, sizeBytes: head.length, writeProtected: false, remoteLibraryId: 'rl', remoteDiskId: 'D6a' },
      { id: 'hd6b', gameId: 'hg6', orgId: ORG, diskNo: 2, sha256: headSha, sizeBytes: head.length, writeProtected: false, remoteLibraryId: 'rl', remoteDiskId: 'D6b' },
    ]);
    await Promise.all(['hd6a', 'hd6b'].map((diskId) =>
      recordVersion({ orgId: ORG, diskId, headSha, head, next, source: 'amiga', sourceFilename: `${diskId}.adf` })));
    const own = ownCopyGameId(ORG, 'rl', 'T6');
    const copies = (await db.select().from(games).where(eq(games.orgId, ORG))).filter((g) => g.title === 'Pair game' && g.remoteLibraryId === null);
    expect(copies.map((g) => g.id)).toEqual([own]);
    const moved = await db.select().from(disks).where(eq(disks.gameId, own));
    expect(moved.map((x) => x.id).sort()).toEqual(['hd6a', 'hd6b']);
    expect(moved.every((x) => x.remoteLibraryId === null)).toBe(true);
  });
});
