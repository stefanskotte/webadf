import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Client } from 'pg';

// The recipient's remote-library store (spec §4.1-4.4) against a real Postgres, with a fake share client.
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_remote_store_test';
const url = new URL(base);
url.pathname = `/${DB}`;
process.env.DATABASE_URL = url.toString();
process.env.BETTER_AUTH_SECRET = 'remote-store-test-secret';
process.env.BETTER_AUTH_URL = 'https://me.example/';

async function admin(stmt: string) {
  const c = new Client({ connectionString: base });
  await c.connect();
  try { await c.query(stmt); } finally { await c.end(); }
}

// Review Focus 3: record, at each eject, whether the hidden disk row still existed -- the eject must come first.
const ejectSaw: { device: string; diskRows: number }[] = [];
vi.mock('@/lib/mount', async (orig) => {
  const real = await orig<typeof import('@/lib/mount')>();
  return {
    ...real,
    clearDesired: async (orgId: string, deviceId: string) => {
      const { getDb: db } = await import('@/db');
      const { disks: d } = await import('@/db/schema/catalog');
      const { isNotNull: nn } = await import('drizzle-orm');
      const rows = await db().select({ id: d.id }).from(d).where(nn(d.remoteLibraryId));
      ejectSaw.push({ device: deviceId, diskRows: rows.length });
      return real.clearDesired(orgId, deviceId);
    },
  };
});

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { eq, and } = await import('drizzle-orm');
const { organization } = await import('@/db/schema/auth');
const { blobs, disks, games, entitlements } = await import('@/db/schema/catalog');
const { devices } = await import('@/db/schema/devices');
const { remoteLibraries } = await import('@/db/schema/sharing');
const store = await import('./store');
const { clearCacheForTests } = await import('./cache');
const { openToken } = await import('./crypto');
type ShareClient = import('@/lib/share/client').ShareClient;

const ORG = 'org-rs';
const OTHER = 'org-rs-other';
const CODE = 'wfsc_' + 'c'.repeat(43);
const TOKEN = 'wfst_' + 't'.repeat(43);
const PIN = 'p'.repeat(43);
const link = (host = 'owner.example', pin = true) => `  https://${host}/s/${CODE}${pin ? `#pin=${PIN}` : ''}  `;
const sha = (n: number) => String(n).padStart(64, '0');

function fakeClient(over: Partial<Record<keyof ShareClient, unknown>> = {}) {
  const c = {
    ping: vi.fn(async () => ({ ok: true, value: { protocol: 1 } })),
    claim: vi.fn(async () => ({ ok: true, value: { token: TOKEN, library: { name: "Rob's\u0007 library" } } })),
    getJson: vi.fn(async () => ({ ok: true, value: { titles: [], nextCursor: null } })),
    getBytes: vi.fn(async () => ({ ok: false, failure: 'not_found' })),
    ...over,
  };
  return c as unknown as ShareClient & Record<keyof ShareClient, ReturnType<typeof vi.fn>>;
}

async function addLib(host: string, client = fakeClient()): Promise<string> {
  const r = await store.addRemoteLibrary(ORG, 'u1', link(host), { client });
  if (!r.ok) throw new Error('add failed ' + r.reason);
  return r.id;
}

async function statusOf(id: string) {
  const [r] = await getDb().select().from(remoteLibraries).where(eq(remoteLibraries.id, id));
  return r;
}

/** A hidden pair of library `lib`, plus a device holding it in DF0 and DF1. */
async function seedHidden(lib: string, n: number, opts: { device?: boolean } = {}) {
  const db = getDb();
  await db.insert(blobs).values({ sha256: sha(n), sizeBytes: 10, storageKey: sha(n) }).onConflictDoNothing();
  await db.insert(entitlements).values({ orgId: ORG, sha256: sha(n), sourceFilename: 'x.adf' }).onConflictDoNothing();
  await db.insert(games).values({ id: `hg${n}`, orgId: ORG, title: `H${n}`, sortTitle: `h${n}`, remoteLibraryId: lib, remoteTitleId: `t${n}`, metadataSource: 'remote' });
  await db.insert(disks).values({ id: `hd${n}`, gameId: `hg${n}`, orgId: ORG, diskNo: 1, sha256: sha(n), sizeBytes: 10, writeProtected: false, remoteLibraryId: lib, remoteDiskId: `d${n}` });
  if (opts.device) {
    await db.insert(devices).values({
      id: `dev${n}`, orgId: ORG, name: `Board ${n}`, macAddress: `AA:BB:CC:DD:EE:${String(n).padStart(2, '0')}`, tokenHash: `h${n}`,
      desiredDiskId: `hd${n}`, desiredSha256: sha(n), mountedDiskId: `hd${n}`, df1DiskId: `hd${n}`,
    });
  }
}

describe('remote library store', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
    await getDb().insert(organization).values({ id: ORG, name: 'Stefan’s team', slug: 'rs', createdAt: new Date() });
  });
  afterAll(async () => {
    store.setShareClientForTests(null);
    await closeDb();
    await admin(`drop database if exists ${DB} with (force)`);
  });
  beforeEach(() => { clearCacheForTests(); ejectSaw.length = 0; });
  afterEach(() => { vi.useRealTimers(); });

  it('a pasted text that is not a share link is bad_link, and nobody is contacted', async () => {
    const client = fakeClient();
    expect(await store.addRemoteLibrary(ORG, 'u1', 'https://owner.example/library', { client })).toEqual({ ok: false, reason: 'bad_link' });
    expect(client.claim).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid_or_used', 'invalid_or_used'],
    ['not_found', 'invalid_or_used'],
    ['unreachable', 'unreachable'],
    ['rate_limited', 'unreachable'],
    ['protocol', 'protocol'],
    ['bad_response', 'protocol'],
  ])('a claim failing %s is %s, and nothing is stored', async (failure, reason) => {
    const client = fakeClient({ claim: vi.fn(async () => ({ ok: false, failure })) });
    const r = await store.addRemoteLibrary(ORG, 'u1', link('fail.example'), { client });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(reason);
    expect(await getDb().select().from(remoteLibraries).where(eq(remoteLibraries.baseUrl, 'https://fail.example'))).toHaveLength(0);
  });

  it('add claims as this instance and stores the token sealed, never in plain', async () => {
    const client = fakeClient();
    const id = await addLib('owner.example', client);
    expect(client.claim).toHaveBeenCalledWith(
      { origin: 'https://owner.example', pin: PIN }, CODE, { instanceUrl: 'https://me.example', instanceName: 'Stefan’s team' },
    );
    const row = await statusOf(id);
    expect(row.orgId).toBe(ORG);
    expect(row.baseUrl).toBe('https://owner.example');
    expect(row.tlsPin).toBe(PIN);
    expect(row.name).toBe("Rob's library");
    expect(row.status).toBe('ok');
    expect(row.addedBy).toBe('u1');
    expect(row.tokenEnc).not.toContain(TOKEN);
    expect(row.tokenEnc).not.toContain('tttt');
    expect(openToken(row.tokenEnc)).toBe(TOKEN);

    const t = await store.getRemoteTarget(ORG, id);
    expect(t?.target).toEqual({ origin: 'https://owner.example', pin: PIN, token: TOKEN });
    expect(await store.getRemoteTarget(OTHER, id)).toBeNull();
    const listed = await store.listRemoteLibraries(ORG);
    expect(listed.map((l) => l.id)).toContain(id);
    expect(Object.keys(listed[0])).not.toContain('tokenEnc');
    expect(await store.listRemoteLibraries(OTHER)).toEqual([]);
  });

  it('the same owner twice is already_added, without claiming', async () => {
    await addLib('twice.example');
    const client = fakeClient();
    expect(await store.addRemoteLibrary(ORG, 'u1', link('twice.example', false), { client })).toEqual({ ok: false, reason: 'already_added' });
    expect(client.claim).not.toHaveBeenCalled();
  });

  it('remoteCall caches a listing for 60 s, then asks again', async () => {
    const id = await addLib('cache.example');
    const client = fakeClient();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-28T12:00:00Z'));
    const a = await store.remoteCall(ORG, id, 'titles?limit=48', { client });
    expect(a.ok).toBe(true);
    await store.remoteCall(ORG, id, 'titles?limit=48', { client });
    expect(client.getJson).toHaveBeenCalledTimes(1);
    expect(client.getJson).toHaveBeenCalledWith({ origin: 'https://cache.example', pin: PIN, token: TOKEN }, 'titles?limit=48');
    await store.remoteCall(ORG, id, 'library', { client });
    expect(client.getJson).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date('2026-10-28T12:01:01Z'));
    await store.remoteCall(ORG, id, 'titles?limit=48', { client });
    expect(client.getJson).toHaveBeenCalledTimes(3);
    expect((await statusOf(id)).lastOkAt?.toISOString()).toBe('2026-10-28T12:01:01.000Z');
  });

  it('the test client override is used when no client is passed (Ruling P3)', async () => {
    const id = await addLib('override.example');
    const client = fakeClient();
    store.setShareClientForTests(client);
    try {
      await store.remoteCall(ORG, id, 'library');
      expect(client.getJson).toHaveBeenCalledTimes(1);
    } finally {
      store.setShareClientForTests(null);
    }
  });

  it('status follows the answers: unreachable, protocol, rate limited (unchanged), ok; failures are not cached', async () => {
    const id = await addLib('status.example');
    const answer = (r: unknown) => fakeClient({ getJson: vi.fn(async () => r) });
    await store.remoteCall(ORG, id, 'library', { client: answer({ ok: false, failure: 'unreachable', detail: 'timeout' }) });
    expect((await statusOf(id)).status).toBe('unreachable');
    expect((await statusOf(id)).lastError).toBe('unreachable: timeout');
    await store.remoteCall(ORG, id, 'library', { client: answer({ ok: false, failure: 'protocol', detail: 'remote_older' }) });
    expect((await statusOf(id)).status).toBe('protocol');
    await store.remoteCall(ORG, id, 'library', { client: answer({ ok: false, failure: 'rate_limited' }) });
    expect((await statusOf(id)).status).toBe('protocol');
    const ok = answer({ ok: true, value: { name: 'x' } });
    await store.remoteCall(ORG, id, 'library', { client: ok });
    expect(ok.getJson).toHaveBeenCalledTimes(1);
    const row = await statusOf(id);
    expect(row.status).toBe('ok');
    expect(row.lastError).toBeNull();
  });

  it('a 401 ends the library and purges its hidden rows; an ended library is never called again', async () => {
    const id = await addLib('revoked.example');
    await seedHidden(id, 1, { device: true });
    const client = fakeClient({ getJson: vi.fn(async () => ({ ok: false, failure: 'ended' })) });
    const r = await store.remoteCall(ORG, id, 'library', { client });
    expect(r).toEqual({ ok: false, failure: 'ended' });
    expect((await statusOf(id)).status).toBe('ended');
    const db = getDb();
    expect(await db.select().from(disks).where(eq(disks.remoteLibraryId, id))).toHaveLength(0);
    expect(await db.select().from(games).where(eq(games.remoteLibraryId, id))).toHaveLength(0);
    const [dev] = await db.select().from(devices).where(eq(devices.id, 'dev1'));
    expect(dev.desiredDiskId).toBeNull();
    expect(dev.df1DiskId).toBeNull();

    const again = fakeClient();
    expect(await store.remoteCall(ORG, id, 'library', { client: again })).toEqual({ ok: false, failure: 'ended' });
    expect(again.getJson).not.toHaveBeenCalled();
    // Still listed until removed (spec §4.3)
    expect((await store.listRemoteLibraries(ORG)).find((l) => l.id === id)?.status).toBe('ended');
    // A new answer cannot resurrect it
    await store.noteRemoteResult(ORG, id, { ok: true, value: {} });
    expect((await statusOf(id)).status).toBe('ended');
  });

  it('purge ejects DF0 and DF1 before deleting, forgets the last disk, and keeps shared bytes and local disks (Review Focus 3)', async () => {
    const id = await addLib('purge.example');
    await seedHidden(id, 2, { device: true });
    await seedHidden(id, 3);
    const db = getDb();
    // sha(3) is also held by a local disk: its entitlement must stay.
    await db.insert(games).values({ id: 'lg3', orgId: ORG, title: 'Local', sortTitle: 'local' });
    await db.insert(disks).values({ id: 'ld3', gameId: 'lg3', orgId: ORG, diskNo: 1, sha256: sha(3), sizeBytes: 10 });
    // A hidden disk that took its first write (D2) is local now and must survive.
    await db.insert(blobs).values({ sha256: sha(4), sizeBytes: 10, storageKey: sha(4) });
    await db.insert(games).values({ id: 'mine4', orgId: ORG, title: 'Mine', sortTitle: 'mine' });
    await db.insert(disks).values({ id: 'mine4d', gameId: 'mine4', orgId: ORG, diskNo: 1, sha256: sha(4), sizeBytes: 10 });
    const [before] = await db.select().from(devices).where(eq(devices.id, 'dev2'));

    const r = await store.purgeHidden(ORG, id);
    expect(r).toEqual({ ejected: 1, deleted: 2 });
    expect(ejectSaw).toEqual([{ device: 'dev2', diskRows: expect.any(Number) }]);
    expect(ejectSaw[0].diskRows).toBeGreaterThanOrEqual(2); // the rows were still there when the board was told

    const [dev] = await db.select().from(devices).where(eq(devices.id, 'dev2'));
    expect(dev.desiredDiskId).toBeNull();
    expect(dev.desiredSha256).toBeNull();
    expect(dev.desiredVersion).toBe(before.desiredVersion + 1);
    expect(dev.df1DiskId).toBeNull();
    expect(dev.df1Version).toBe(before.df1Version + 1);
    expect(dev.lastDiskId).toBeNull();

    expect(await db.select().from(disks).where(eq(disks.remoteLibraryId, id))).toHaveLength(0);
    expect(await db.select().from(games).where(eq(games.remoteLibraryId, id))).toHaveLength(0);
    const ents = (await db.select().from(entitlements).where(eq(entitlements.orgId, ORG))).map((e) => e.sha256);
    expect(ents).not.toContain(sha(2));
    expect(ents).toContain(sha(3));
    expect(await db.select().from(disks).where(eq(disks.id, 'ld3'))).toHaveLength(1);
    expect(await db.select().from(disks).where(eq(disks.id, 'mine4d'))).toHaveLength(1);
    // Blobs stay for the GC
    expect(await db.select().from(blobs).where(eq(blobs.sha256, sha(2)))).toHaveLength(1);
  });

  it('remove purges then deletes the library; another org cannot remove it', async () => {
    const id = await addLib('remove.example');
    await seedHidden(id, 5, { device: true });
    expect(await store.removeRemoteLibrary(OTHER, id)).toBe(false);
    expect(await statusOf(id)).toBeDefined();
    expect(await store.removeRemoteLibrary(ORG, id)).toBe(true);
    expect(await statusOf(id)).toBeUndefined();
    const db = getDb();
    expect(await db.select().from(disks).where(and(eq(disks.orgId, ORG), eq(disks.id, 'hd5')))).toHaveLength(0);
    const [dev] = await db.select().from(devices).where(eq(devices.id, 'dev5'));
    expect(dev.desiredDiskId).toBeNull();
    expect(ejectSaw.map((e) => e.device)).toEqual(['dev5']);
    expect(await store.removeRemoteLibrary(ORG, id)).toBe(false);
  });

  it('a token that can no longer be opened ends the library without calling the owner', async () => {
    const id = await addLib('rotated.example');
    await getDb().update(remoteLibraries).set({ tokenEnc: 'v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }).where(eq(remoteLibraries.id, id));
    const client = fakeClient();
    const r = await store.remoteCall(ORG, id, 'library', { client });
    expect(r.ok).toBe(false);
    expect(client.getJson).not.toHaveBeenCalled();
    expect((await statusOf(id)).status).toBe('ended');
  });

  it('an unknown or foreign library answers not_found', async () => {
    const id = await addLib('foreign.example');
    expect(await store.remoteCall(OTHER, id, 'library', { client: fakeClient() })).toEqual({ ok: false, failure: 'not_found' });
    expect(await store.remoteCall(ORG, 'nope', 'library', { client: fakeClient() })).toEqual({ ok: false, failure: 'not_found' });
  });
});
