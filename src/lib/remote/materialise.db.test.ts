import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Client } from 'pg';
import { createHash } from 'node:crypto';

// Materialising a remote disk as a hidden pair (spec §4.2 Mount), against a real Postgres with a fake share client.
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_remote_materialise_test';
const url = new URL(base);
url.pathname = `/${DB}`;
process.env.DATABASE_URL = url.toString();
process.env.BETTER_AUTH_SECRET = 'remote-materialise-test-secret';
process.env.BETTER_AUTH_URL = 'https://me.example';

async function admin(stmt: string) {
  const c = new Client({ connectionString: base });
  await c.connect();
  try { await c.query(stmt); } finally { await c.end(); }
}

const stored = new Map<string, Uint8Array>();
vi.mock('@/lib/storage', () => ({
  diskStore: {
    put: async (sha: string, b: Uint8Array) => { stored.set(sha, b); return { key: sha }; },
    storageKey: (sha: string) => `adf/${sha}`,
    read: async (sha: string) => stored.get(sha)!,
  },
}));

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { eq, and } = await import('drizzle-orm');
const { disks, games, entitlements } = await import('@/db/schema/catalog');
const { remoteLibraries } = await import('@/db/schema/sharing');
const { ADF_BYTES } = await import('@/lib/adfmfm');
const { stableId } = await import('@/lib/ingest');
const store = await import('./store');
const { materialiseRemoteDisk } = await import('./materialise');
const { clearCacheForTests } = await import('./cache');
type ShareClient = import('@/lib/share/client').ShareClient;

const ORG = 'org-mat';
const TOKEN = 'wfst_' + 'm'.repeat(43);
const CODE = 'wfsc_' + 'm'.repeat(43);

const adf = (fill: number) => new Uint8Array(ADF_BYTES).fill(fill);
const hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function detail(bytes: Uint8Array, over: Record<string, unknown> = {}) {
  return {
    title: { id: 'T1', title: 'Turrican  II', year: 1991, publisher: 'Rainbow Arts', kind: 'game', diskCount: 1, hasCover: false, coverDigest: null, collectionIds: [] },
    disks: [{ id: 'D1', name: 'Disk 1', diskNo: 1, sizeBytes: bytes.length, sha256: hex(bytes), imageFormat: 'adf', extractable: true, updatedAt: '2026-10-28T00:00:00.000Z', ...over }],
  };
}

function fakeClient(listing: unknown, bytes: { ok: boolean; value?: Uint8Array; etag?: string; failure?: string }) {
  return {
    ping: vi.fn(),
    claim: vi.fn(async () => ({ ok: true, value: { token: TOKEN, library: { name: 'Rob' } } })),
    getJson: vi.fn(async () => listing),
    getBytes: vi.fn(async () => bytes),
  } as unknown as ShareClient & Record<keyof ShareClient, ReturnType<typeof vi.fn>>;
}
const okListing = (b: Uint8Array) => ({ ok: true, value: detail(b) });
const okBytes = (b: Uint8Array) => ({ ok: true, value: b, etag: hex(b) });

let lib = '';
let n = 0;
const hiddenDiskId = () => stableId('rdisk', ORG, lib, 'D1');
const hiddenGameId = () => stableId('rgame', ORG, lib, 'T1');
const rowsOf = async () => ({
  disks: await getDb().select().from(disks).where(eq(disks.orgId, ORG)),
  games: await getDb().select().from(games).where(eq(games.orgId, ORG)),
});

describe('materialiseRemoteDisk', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
  });
  afterAll(async () => {
    await closeDb();
    await admin(`drop database if exists ${DB} with (force)`);
  });
  beforeEach(async () => {
    clearCacheForTests();
    stored.clear();
    const db = getDb();
    await db.delete(disks).where(eq(disks.orgId, ORG));
    await db.delete(games).where(eq(games.orgId, ORG));
    await db.delete(entitlements).where(eq(entitlements.orgId, ORG));
    const r = await store.addRemoteLibrary(ORG, 'u1', `https://owner${++n}.example/s/${CODE}`, { client: fakeClient(null, { ok: false }) });
    if (!r.ok) throw new Error(r.reason);
    lib = r.id;
  });

  it('creates a hidden, writable pair holding the owner\'s bytes', async () => {
    const b = adf(1);
    const client = fakeClient(okListing(b), okBytes(b));
    const r = await materialiseRemoteDisk(ORG, lib, 'T1', 'D1', { client });
    expect(r).toEqual({ ok: true, diskId: hiddenDiskId() });
    expect(client.getJson).toHaveBeenCalledWith({ origin: `https://owner${n}.example`, pin: null, token: TOKEN }, 'titles/T1');
    expect(client.getBytes).toHaveBeenCalledWith(expect.anything(), 'disks/D1/bytes');
    const { disks: ds, games: gs } = await rowsOf();
    expect(gs).toHaveLength(1);
    expect(gs[0]).toMatchObject({ id: hiddenGameId(), title: 'Turrican II', year: 1991, publisher: 'Rainbow Arts', remoteLibraryId: lib, remoteTitleId: 'T1', metadataSource: 'remote' });
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({
      id: hiddenDiskId(), gameId: hiddenGameId(), sha256: hex(b), sizeBytes: ADF_BYTES, diskNo: 1, label: 'Disk 1',
      writeProtected: false, imageFormat: 'adf', remoteLibraryId: lib, remoteDiskId: 'D1',
    });
    expect(stored.get(hex(b))).toBe(b);
    const ents = await getDb().select().from(entitlements).where(and(eq(entitlements.orgId, ORG), eq(entitlements.sha256, hex(b))));
    expect(ents).toHaveLength(1);
  });

  it('a second mount re-asks the owner but reuses the row and fetches no bytes', async () => {
    const b = adf(2);
    await materialiseRemoteDisk(ORG, lib, 'T1', 'D1', { client: fakeClient(okListing(b), okBytes(b)) });
    const again = fakeClient(okListing(b), okBytes(b));
    expect(await materialiseRemoteDisk(ORG, lib, 'T1', 'D1', { client: again })).toEqual({ ok: true, diskId: hiddenDiskId() });
    expect(again.getJson).toHaveBeenCalledTimes(1);
    expect(again.getBytes).not.toHaveBeenCalled();
    expect((await rowsOf()).disks).toHaveLength(1);
  });

  it('the owner changed the disk: the untouched row follows, the old bytes\' entitlement goes', async () => {
    const old = adf(3);
    const now = adf(4);
    await materialiseRemoteDisk(ORG, lib, 'T1', 'D1', { client: fakeClient(okListing(old), okBytes(old)) });
    const r = await materialiseRemoteDisk(ORG, lib, 'T1', 'D1', { client: fakeClient(okListing(now), okBytes(now)) });
    expect(r).toEqual({ ok: true, diskId: hiddenDiskId() });
    const { disks: ds } = await rowsOf();
    expect(ds).toHaveLength(1);
    expect(ds[0].sha256).toBe(hex(now));
    const ents = (await getDb().select().from(entitlements).where(eq(entitlements.orgId, ORG))).map((e) => e.sha256);
    expect(ents).toEqual([hex(now)]);
  });

  it('bytes whose ETag disagrees are a mismatch, and nothing is created', async () => {
    const b = adf(5);
    const r = await materialiseRemoteDisk(ORG, lib, 'T1', 'D1', { client: fakeClient(okListing(b), { ok: true, value: b, etag: 'f'.repeat(64) }) });
    expect(r).toEqual({ ok: false, reason: 'mismatch' });
    expect(await rowsOf()).toEqual({ disks: [], games: [] });
    expect(stored.size).toBe(0);
  });

  it('bytes that are not what the listing named are a mismatch', async () => {
    const listed = adf(6);
    const other = adf(7);
    const r = await materialiseRemoteDisk(ORG, lib, 'T1', 'D1', { client: fakeClient(okListing(listed), okBytes(other)) });
    expect(r).toEqual({ ok: false, reason: 'mismatch' });
    expect((await rowsOf()).disks).toHaveLength(0);
  });

  it('a title no longer shared (404) is not_shared: no bytes fetched, nothing created (Review Focus 1)', async () => {
    const b = adf(8);
    const client = fakeClient({ ok: false, failure: 'not_found' }, okBytes(b));
    expect(await materialiseRemoteDisk(ORG, lib, 'T1', 'D1', { client })).toEqual({ ok: false, reason: 'not_shared' });
    expect(client.getBytes).not.toHaveBeenCalled();
    expect(await rowsOf()).toEqual({ disks: [], games: [] });
  });

  it('a held hidden disk whose title left scope is not mounted again (Review Focus 1)', async () => {
    const b = adf(9);
    await materialiseRemoteDisk(ORG, lib, 'T1', 'D1', { client: fakeClient(okListing(b), okBytes(b)) });
    const client = fakeClient({ ok: false, failure: 'not_found' }, okBytes(b));
    expect(await materialiseRemoteDisk(ORG, lib, 'T1', 'D1', { client })).toEqual({ ok: false, reason: 'not_shared' });
  });

  it('a disk missing from the title\'s list is not_shared', async () => {
    const b = adf(10);
    const client = fakeClient(okListing(b), okBytes(b));
    expect(await materialiseRemoteDisk(ORG, lib, 'T1', 'D2', { client })).toEqual({ ok: false, reason: 'not_shared' });
    expect(client.getBytes).not.toHaveBeenCalled();
  });

  it('a bytes 404 after the listing is not_shared', async () => {
    const b = adf(11);
    const client = fakeClient(okListing(b), { ok: false, failure: 'not_found' });
    expect(await materialiseRemoteDisk(ORG, lib, 'T1', 'D1', { client })).toEqual({ ok: false, reason: 'not_shared' });
    expect((await rowsOf()).disks).toHaveLength(0);
  });

  it('a 401 is ended, and ends the library', async () => {
    const client = fakeClient({ ok: false, failure: 'ended' }, { ok: false });
    expect(await materialiseRemoteDisk(ORG, lib, 'T1', 'D1', { client })).toEqual({ ok: false, reason: 'ended' });
    const [row] = await getDb().select().from(remoteLibraries).where(eq(remoteLibraries.id, lib));
    expect(row.status).toBe('ended');
    // and no further calls
    const again = fakeClient(okListing(adf(1)), okBytes(adf(1)));
    expect(await materialiseRemoteDisk(ORG, lib, 'T1', 'D1', { client: again })).toEqual({ ok: false, reason: 'ended' });
    expect(again.getJson).not.toHaveBeenCalled();
  });

  it('maps unreachable, too large and a bad listing (a garbled answer is bad_response, final review 6)', async () => {
    const b = adf(12);
    expect(await materialiseRemoteDisk(ORG, lib, 'T1', 'D1', { client: fakeClient({ ok: false, failure: 'unreachable' }, okBytes(b)) }))
      .toEqual({ ok: false, reason: 'unreachable' });
    expect(await materialiseRemoteDisk(ORG, lib, 'T1', 'D1', { client: fakeClient(okListing(b), { ok: false, failure: 'too_large' }) }))
      .toEqual({ ok: false, reason: 'too_large' });
    expect(await materialiseRemoteDisk(ORG, lib, 'T1', 'D1', { client: fakeClient({ ok: true, value: detail(b, { sizeBytes: 3_000_000 }) }, okBytes(b)) }))
      .toEqual({ ok: false, reason: 'too_large' });
    expect(await materialiseRemoteDisk(ORG, lib, 'T1', 'D1', { client: fakeClient({ ok: true, value: detail(b, { sha256: 'nope' }) }, okBytes(b)) }))
      .toEqual({ ok: false, reason: 'bad_response' });
    expect(await materialiseRemoteDisk(ORG, lib, 'T1', 'D1', { client: fakeClient({ ok: true, value: { nope: 1 } }, okBytes(b)) }))
      .toEqual({ ok: false, reason: 'bad_response' });
    expect(await materialiseRemoteDisk('org-other', lib, 'T1', 'D1', { client: fakeClient(okListing(b), okBytes(b)) }))
      .toEqual({ ok: false, reason: 'not_shared' });
  });

  it('a revoke landing while the bytes are in flight leaves no hidden row and answers ended', async () => {
    const b = adf(15);
    const client = fakeClient(okListing(b), okBytes(b));
    client.getBytes.mockImplementation(async () => {
      await store.endRemoteLibrary(ORG, lib);
      return okBytes(b);
    });
    expect(await materialiseRemoteDisk(ORG, lib, 'T1', 'D1', { client })).toEqual({ ok: false, reason: 'ended' });
    expect(await rowsOf()).toEqual({ disks: [], games: [] });
  });

  it('a Remove landing while the bytes are in flight answers ended, not an error', async () => {
    const b = adf(16);
    const client = fakeClient(okListing(b), okBytes(b));
    client.getBytes.mockImplementation(async () => {
      await store.removeRemoteLibrary(ORG, lib);
      return okBytes(b);
    });
    expect(await materialiseRemoteDisk(ORG, lib, 'T1', 'D1', { client })).toEqual({ ok: false, reason: 'ended' });
    expect(await rowsOf()).toEqual({ disks: [], games: [] });
  });

  it('an owner year outside 1900..2100 is dropped, a long title is capped', async () => {
    const b = adf(17);
    const listing = detail(b);
    listing.title = { ...listing.title, year: 99999, title: 'x'.repeat(1000) };
    await materialiseRemoteDisk(ORG, lib, 'T1', 'D1', { client: fakeClient({ ok: true, value: listing }, okBytes(b)) });
    const { games: gs } = await rowsOf();
    expect(gs[0].year).toBeNull();
    expect(gs[0].title).toHaveLength(300);
  });

  it('a sibling disk of a title that became local lands hidden, and the game stays local and keeps its name (C1)', async () => {
    const b = adf(18);
    await materialiseRemoteDisk(ORG, lib, 'T1', 'D1', { client: fakeClient(okListing(b), okBytes(b)) });
    const db = getDb();
    await db.update(disks).set({ remoteLibraryId: null, remoteDiskId: null }).where(eq(disks.id, hiddenDiskId()));
    await db.update(games).set({ remoteLibraryId: null, remoteTitleId: null, title: 'My copy', sortTitle: 'my copy' }).where(eq(games.id, hiddenGameId()));
    const two = adf(19);
    const listing = { ok: true, value: { ...detail(b), disks: [...detail(b).disks, { ...detail(two).disks[0], id: 'D2', name: 'Disk 2', diskNo: 2 }] } };
    listing.value.title = { ...listing.value.title, title: 'Owner renamed it' };
    const r = await materialiseRemoteDisk(ORG, lib, 'T1', 'D2', { client: fakeClient(listing, okBytes(two)) });
    expect(r).toEqual({ ok: true, diskId: stableId('rdisk', ORG, lib, 'D2') });
    const [g] = await db.select().from(games).where(eq(games.id, hiddenGameId()));
    expect(g).toMatchObject({ remoteLibraryId: null, title: 'My copy' });
    const [d2] = await db.select().from(disks).where(eq(disks.id, stableId('rdisk', ORG, lib, 'D2')));
    expect(d2).toMatchObject({ gameId: hiddenGameId(), remoteLibraryId: lib, remoteDiskId: 'D2' });
  });

  it('a row that took its first write is the person\'s own: never refreshed, never re-hidden', async () => {
    const b = adf(13);
    await materialiseRemoteDisk(ORG, lib, 'T1', 'D1', { client: fakeClient(okListing(b), okBytes(b)) });
    const db = getDb();
    await db.update(disks).set({ remoteLibraryId: null, remoteDiskId: null }).where(eq(disks.id, hiddenDiskId()));
    await db.update(games).set({ remoteLibraryId: null, remoteTitleId: null }).where(eq(games.id, hiddenGameId()));
    const now = adf(14);
    const client = fakeClient(okListing(now), okBytes(now));
    expect(await materialiseRemoteDisk(ORG, lib, 'T1', 'D1', { client })).toEqual({ ok: true, diskId: hiddenDiskId() });
    expect(client.getBytes).not.toHaveBeenCalled();
    const { disks: ds, games: gs } = await rowsOf();
    expect(ds[0]).toMatchObject({ sha256: hex(b), remoteLibraryId: null });
    expect(gs[0].remoteLibraryId).toBeNull();
  });
});
