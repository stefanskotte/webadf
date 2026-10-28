import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

// Library sharing Task 6 (spec §4.1, Review Focus 2): a hidden remote stand-in (games/disks with remote_library_id
// set) never reaches a local view, and identification sweeps never touch it. Device/drive state still shows it,
// named "<title> (remote)".
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_remote_hidden_test';
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
const { eq, inArray } = await import('drizzle-orm');
const { games, disks, blobs, entitlements } = await import('@/db/schema/catalog');
const { devices } = await import('@/db/schema/devices');
const { collections, collectionGames } = await import('@/db/schema/collections');
const { remoteLibraries } = await import('@/db/schema/sharing');
const { tosecEntries } = await import('@/db/schema/tosec');
const { openretroEntries } = await import('@/db/schema/openretro');
const { demozooProductions, demozooSuggestions } = await import('@/db/schema/demozoo');
const queries = await import('./queries');
const coll = await import('./collections');
const { search } = await import('./search');
const nfc = await import('./nfc/store');
const { listReviewQueue, countReviewQueue } = await import('./demozoo/queries');
const { searchCandidates } = await import('./disk-set-search');
const { addDisksToSet, NotFound } = await import('./disk-set-store');
const { readNextForDevices } = await import('./next-disk');
const { liveStateRows } = await import('./live-state');
const { adminCounts } = await import('./admin-queries');
const { libraryUsage } = await import('./about/library-usage');
const { deleteGames } = await import('./disk-delete');
const { applyMatch } = await import('./tosec-apply');
const { applyEnrichment } = await import('./openretro-apply');
const { applyAutomaticLink, confirmDemozoo } = await import('./demozoo/apply');

const ORG = 'org-rh';
const sha = (n: number) => String(n).padStart(64, '0');
// Local: gL "Local Quest" (2 disks, in collection c1), gU "Loose Quest" (1 disk, uncategorized).
// Hidden: gH "Hidden Quest" (2 disks, in no collection -- the real invariant) and gH2 "Stray Quest", which should
// never be in a collection but is put in c1 here to prove every collection query filters it anyway.
const L1 = sha(1), L2 = sha(2), U1 = sha(3), H1 = sha(4), H2 = sha(5), S1 = sha(6);
const hidden = { remoteLibraryId: 'rl1' };

describe('hidden remote rows', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
    const db = getDb();
    await db.insert(remoteLibraries).values({ id: 'rl1', orgId: ORG, baseUrl: 'https://owner.example', tokenEnc: 'x', name: 'Owner', addedBy: 'u1' });
    await db.insert(blobs).values([L1, L2, U1, H1, H2, S1].map((s) => ({ sha256: s, sizeBytes: 901120, storageKey: s })));
    await db.insert(entitlements).values([L1, L2, U1, H1, H2, S1].map((s) => ({ orgId: ORG, sha256: s, sourceFilename: `${s.slice(-1)}.adf` })));
    await db.insert(games).values([
      { id: 'gL', orgId: ORG, title: 'Local Quest', sortTitle: 'local quest', metadataSource: 'filename', createdAt: new Date('2026-01-01') },
      { id: 'gU', orgId: ORG, title: 'Loose Quest', sortTitle: 'loose quest', metadataSource: 'filename', createdAt: new Date('2026-01-02') },
      { id: 'gH', orgId: ORG, title: 'Hidden Quest', sortTitle: 'hidden quest', metadataSource: 'filename', createdAt: new Date('2026-01-03'), ...hidden, remoteTitleId: 't1' },
      { id: 'gH2', orgId: ORG, title: 'Stray Quest', sortTitle: 'stray quest', metadataSource: 'filename', createdAt: new Date('2026-01-04'), ...hidden, remoteTitleId: 't2' },
    ]);
    await db.insert(disks).values([
      { id: 'dL1', gameId: 'gL', orgId: ORG, diskNo: 1, sha256: L1, sizeBytes: 901120 },
      { id: 'dL2', gameId: 'gL', orgId: ORG, diskNo: 2, sha256: L2, sizeBytes: 901120 },
      { id: 'dU', gameId: 'gU', orgId: ORG, diskNo: 1, sha256: U1, sizeBytes: 901120 },
      { id: 'dH1', gameId: 'gH', orgId: ORG, diskNo: 1, sha256: H1, sizeBytes: 901120, tosecName: 'hidden-1.adf', ...hidden, remoteDiskId: 'r1' },
      { id: 'dH2', gameId: 'gH', orgId: ORG, diskNo: 2, sha256: H2, sizeBytes: 901120, ...hidden, remoteDiskId: 'r2' },
      { id: 'dS1', gameId: 'gH2', orgId: ORG, diskNo: 1, sha256: S1, sizeBytes: 901120, ...hidden, remoteDiskId: 'r3' },
    ]);
    await db.insert(collections).values({ id: 'c1', orgId: ORG, name: 'Favourites', sortKey: 0 });
    await db.insert(collectionGames).values([
      { collectionId: 'c1', gameId: 'gL', sortKey: 0 }, { collectionId: 'c1', gameId: 'gH2', sortKey: 1 },
    ]);
    await db.insert(devices).values([
      { id: 'devH', orgId: ORG, name: 'Hidden board', tokenHash: 'h-rh-1', desiredDiskId: 'dH1', desiredSha256: H1,
        desiredGameId: 'gH', desiredDiskNo: 1, mountedDiskId: 'dH1', mountedSha256: H1, mountedGameId: 'gH', mountedDiskNo: 1 },
      { id: 'devL', orgId: ORG, name: 'Local board', tokenHash: 'h-rh-2', desiredDiskId: 'dL1', desiredSha256: L1,
        desiredGameId: 'gL', desiredDiskNo: 1, mountedDiskId: 'dL1', mountedSha256: L1, mountedGameId: 'gL', mountedDiskNo: 1 },
    ]);
  });
  afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

  const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();

  it('listGames leaves hidden titles out of all, a collection and Uncategorized', async () => {
    expect(ids(await queries.listGames(ORG))).toEqual(['gL', 'gU']);
    expect(ids(await queries.listGames(ORG, { collectionId: 'c1' }))).toEqual(['gL']);
    expect(ids(await queries.listGames(ORG, { uncategorized: true }))).toEqual(['gU']);
  });

  it('counts leave hidden titles and disks out', async () => {
    expect(await queries.countGames(ORG, {})).toEqual({ titles: 2, disks: 3 });
    expect(await queries.countGames(ORG, { collectionId: 'c1' })).toEqual({ titles: 1, disks: 2 });
    expect(await queries.countGames(ORG, { uncategorized: true })).toEqual({ titles: 1, disks: 1 });
    expect(await queries.countAllGames(ORG)).toEqual({ titles: 2, disks: 3 });
    expect(await coll.countUncategorized(ORG)).toBe(1);
    const usage = await libraryUsage(ORG);
    expect({ titles: usage.titles, disks: usage.disks }).toEqual({ titles: 2, disks: 3 });
    const admin = await adminCounts();
    expect({ games: admin.games, disks: admin.disks }).toEqual({ games: 2, disks: 3 });
  });

  it('collections count, preview and list only local titles', async () => {
    const [c] = await coll.listCollections(ORG);
    expect({ gameCount: c.gameCount, diskCount: c.diskCount }).toEqual({ gameCount: 1, diskCount: 2 });
    expect(await coll.listCollectionGameIds(ORG, 'c1')).toEqual(['gL']);
    expect(await coll.addGameToCollection(ORG, 'c1', 'gH')).toBe(false);
    const moved = await coll.moveGamesToCollection(ORG, ['gH'], 'c1');
    expect(moved?.missing).toEqual(['gH']);
  });

  it('cover and kind helpers answer nothing for a hidden title', async () => {
    const db = getDb();
    await db.insert(tosecEntries).values({
      id: 'te0', setName: 'Commodore Amiga - Games', gameName: 'Kind (1990)(X)', romName: 'Kind (1990)(X).adf',
      sizeBytes: 901120, title: 'Kind', sortTitle: 'kind',
    });
    await db.update(blobs).set({ tosecEntryId: 'te0' }).where(inArray(blobs.sha256, [L1, H1]));
    await db.update(games).set({ coverOverrideSha256: 'c'.repeat(64) }).where(inArray(games.id, ['gL', 'gH']));
    const kinds = await queries.kindsForGames(ORG, ['gL', 'gH']);
    expect(kinds.get('gL')).not.toBeNull();
    expect(kinds.get('gH')).toBeNull();
    const covers = await queries.coverUrlsForGames(ORG, ['gL', 'gH']);
    expect(covers.has('gL')).toBe(true);
    expect(covers.has('gH')).toBe(false);
    await db.update(blobs).set({ tosecEntryId: null }).where(inArray(blobs.sha256, [L1, H1]));
    await db.update(games).set({ coverOverrideSha256: null }).where(inArray(games.id, ['gL', 'gH']));
  });

  it('search and the disk-set candidates leave hidden titles out', async () => {
    const r = await search(ORG, 'Quest');
    expect(ids(r.titles)).toEqual(['gL', 'gU']);
    const c = await searchCandidates(ORG, 'Quest', null);
    expect(c.titles.map((t) => t.gameId).sort()).toEqual(['gL', 'gU']);
    await expect(addDisksToSet(ORG, 'gL', ['dH2'])).rejects.toBeInstanceOf(NotFound);
    await expect(addDisksToSet(ORG, 'gH', ['dU'])).rejects.toBeInstanceOf(NotFound);
  });

  it('getGameDetail is null for a hidden title (the page 404s)', async () => {
    expect(await queries.getGameDetail(ORG, 'gH')).toBeNull();
    expect((await queries.getGameDetail(ORG, 'gL'))?.disks.map((d) => d.id)).toEqual(['dL1', 'dL2']);
  });

  it('NFC lists and fob writes leave hidden disks out', async () => {
    const rows = await nfc.listDisksForNfc(ORG, ['gL', 'gH']);
    expect(rows.map((d) => d.id).sort()).toEqual(['dL1', 'dL2']);
    expect(await nfc.readDiskForNfc(ORG, 'dH1')).toBeNull();
    expect(await nfc.requestNfcWrite(ORG, 'devL', 'dH1', new Date())).toBeNull();
  });

  it('a bulk delete reports a hidden title missing and leaves it alone', async () => {
    const r = await deleteGames(ORG, ['gH'], { dryRun: true, now: Date.now() });
    expect(r.missing).toEqual(['gH']);
  });

  it('next disk is never a hidden disk', async () => {
    const devs = [
      { id: 'devH', desiredDiskId: 'dH1', mountedDiskId: 'dH1', trackMaxBytes: null, playsHd: false },
      { id: 'devL', desiredDiskId: 'dL1', mountedDiskId: 'dL1', trackMaxBytes: null, playsHd: false },
    ];
    const next = await readNextForDevices(ORG, devs);
    expect(next.get('devH')).toEqual({ kind: 'nothing_mounted' });
    const l = next.get('devL');
    expect(l?.kind === 'disk' ? l.disk.id : null).toBe('dL2');
  });

  it('device state still shows a mounted hidden disk, named "<title> (remote)", with no game link', async () => {
    const rows = await liveStateRows(getDb(), ORG);
    const h = rows.find((r) => r.id === 'devH')!;
    expect(h.mountedDiskId).toBe('dH1');
    expect(h.mountedGameTitle).toBe('Hidden Quest (remote)');
    expect(h.desiredGameTitle).toBe('Hidden Quest (remote)');
    expect(h.mountedGameId).toBeNull();
    const l = rows.find((r) => r.id === 'devL')!;
    expect(l.mountedGameTitle).toBe('Local Quest');
    expect(l.mountedGameId).toBe('gL');

    const list = await queries.listDevices(ORG);
    const lh = list.find((d) => d.id === 'devH')!;
    expect(lh.mountedGame).toBe('Hidden Quest (remote)');
    expect(lh.desiredGame).toBe('Hidden Quest (remote)');
    expect(lh.mountedGameId).toBeNull();
    expect(lh.desiredGameId).toBeNull();
    expect(list.find((d) => d.id === 'devL')!.mountedGame).toBe('Local Quest');
  });

  it('the Demozoo review queue leaves hidden titles out, and confirm refuses one', async () => {
    const db = getDb();
    await db.insert(demozooProductions).values({ id: 77, title: 'Quest Demo', titleKey: 'questdemo', supertype: 'production' });
    await db.insert(demozooSuggestions).values([
      { sha256: U1, productionId: 77, source: 'filename' },
      { sha256: H1, productionId: 77, source: 'filename' },
    ]);
    const q = await listReviewQueue(ORG);
    expect(q.map((i) => i.gameId)).toEqual(['gU']);
    expect(await countReviewQueue(ORG)).toBe(1);
    expect(await confirmDemozoo(ORG, 'gH', 77)).toBe(false);
  });

  it('identification sweeps never retitle or merge a hidden title', async () => {
    const db = getDb();
    // A TOSEC entry for the hidden disk's bytes, naming the LOCAL title: without the guard applyMatch would retitle
    // the hidden game "Local Quest" and mergeDuplicates would fold one of the two into the other.
    await db.insert(tosecEntries).values({
      id: 'te1', setName: 'Commodore Amiga - Games', gameName: 'Local Quest (1990)(X)', romName: 'Local Quest (1990)(X)(Disk 1 of 2).adf',
      sizeBytes: 901120, title: 'Local Quest', sortTitle: 'local quest', year: null, publisher: 'X', diskNo: 1,
    });
    await applyMatch(H1, 'te1');
    await applyMatch(L1, 'te1');   // the merge pass for the local title's own match must not absorb the hidden one either
    const [h] = await db.select().from(games).where(eq(games.id, 'gH'));
    expect(h).toMatchObject({ title: 'Hidden Quest', sortTitle: 'hidden quest', metadataSource: 'filename', remoteLibraryId: 'rl1' });
    const hd = await db.select({ id: disks.id, gameId: disks.gameId, tosecName: disks.tosecName }).from(disks)
      .where(inArray(disks.id, ['dH1', 'dH2']));
    expect(hd.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'dH1', gameId: 'gH', tosecName: 'hidden-1.adf' }, { id: 'dH2', gameId: 'gH', tosecName: null },
    ]);
    expect((await db.select({ id: games.id }).from(games).where(eq(games.id, 'gL'))).length).toBe(1);

    // Make the hidden title a same-named duplicate of the local one; a local match's merge still leaves it alone.
    await db.update(games).set({ title: 'Local Quest', sortTitle: 'local quest' }).where(eq(games.id, 'gH'));
    await applyMatch(L1, 'te1');
    expect((await db.select({ id: games.id }).from(games).where(inArray(games.id, ['gL', 'gH']))).length).toBe(2);
    expect((await db.select({ g: disks.gameId }).from(disks).where(eq(disks.id, 'dH1')))[0].g).toBe('gH');
    await db.update(games).set({ title: 'Hidden Quest', sortTitle: 'hidden quest' }).where(eq(games.id, 'gH'));

    await db.insert(openretroEntries).values({ uuid: 'or1', gameName: 'Local Quest', publisher: 'OR Pub', developer: 'OR Dev', description: 'Prose' });
    await applyEnrichment(H1, 'or1');
    const [h2] = await db.select().from(games).where(eq(games.id, 'gH'));
    expect({ publisher: h2.publisher, developer: h2.developer, description: h2.description })
      .toEqual({ publisher: null, developer: null, description: null });

    await applyAutomaticLink(H1, 77);
    const [h3] = await db.select().from(games).where(eq(games.id, 'gH'));
    expect({ title: h3.title, demozooProductionId: h3.demozooProductionId }).toEqual({ title: 'Hidden Quest', demozooProductionId: null });
  });
});
