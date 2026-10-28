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
  beforeEach(() => { clearCacheForTests(); store.resetFailureCountsForTests(); ejectSaw.length = 0; });
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
    ['bad_response', 'bad_response'],
    ['too_large', 'bad_response'],
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
    expect(openToken(row.tokenEnc, id)).toBe(TOKEN);
    expect(() => openToken(row.tokenEnc, 'another-library')).toThrow();

    const t = await store.getRemoteTarget(ORG, id);
    expect(t?.target).toEqual({ origin: 'https://owner.example', pin: PIN, token: TOKEN });
    expect(await store.getRemoteTarget(OTHER, id)).toBeNull();
    const listed = await store.listRemoteLibraries(ORG);
    expect(listed.map((l) => l.id)).toContain(id);
    expect(Object.keys(listed[0])).not.toContain('tokenEnc');
    expect(await store.listRemoteLibraries(OTHER)).toEqual([]);
  });

  it('two links from one origin are two libraries: every hosted owner shares one origin (final review 1)', async () => {
    const first = await addLib('twice.example');
    const client = fakeClient();
    const r = await store.addRemoteLibrary(ORG, 'u1', link('twice.example', false), { client });
    expect(client.claim).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.id).not.toBe(first);
    const rows = await getDb().select().from(remoteLibraries).where(eq(remoteLibraries.baseUrl, 'https://twice.example'));
    expect(rows).toHaveLength(2);
  });

  it('a token this server cannot open refuses the call but never ends the library or purges (final review 3)', async () => {
    const id = await addLib('unreadable.example');
    await seedHidden(id, 9, { device: true });
    const saved = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = 'a-different-secret';
    try {
      const client = fakeClient();
      const r = await store.remoteCall(ORG, id, 'library', { client });
      expect(r).toEqual({ ok: false, failure: 'token_unreadable' });
      expect(client.getJson).not.toHaveBeenCalled();
      const row = await statusOf(id);
      expect(row.status).toBe('ok');
      expect(row.lastError).toBe('token_unreadable');
      const db = getDb();
      expect(await db.select().from(disks).where(eq(disks.remoteLibraryId, id))).toHaveLength(1);
      expect(await db.select().from(games).where(eq(games.remoteLibraryId, id))).toHaveLength(1);
      const [dev] = await db.select().from(devices).where(eq(devices.id, 'dev9'));
      expect(dev.desiredDiskId).toBe('hd9');
      expect(dev.df1DiskId).toBe('hd9');
    } finally {
      process.env.BETTER_AUTH_SECRET = saved;
    }
    // The secret back: the library works again, nothing was lost.
    const ok = fakeClient({ getJson: vi.fn(async () => ({ ok: true, value: { name: 'x' } })) });
    expect((await store.remoteCall(ORG, id, 'library', { client: ok })).ok).toBe(true);
    expect((await statusOf(id)).lastError).toBeNull();
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
    const down = { ok: false, failure: 'unreachable', detail: 'timeout' };
    // One blip is returned to the caller but leaves the status alone (spec §4.3: "repeated network failures").
    expect(await store.remoteCall(ORG, id, 'library', { client: answer(down) })).toEqual(down);
    expect((await statusOf(id)).status).toBe('ok');
    // An answer in between resets the run.
    await store.remoteCall(ORG, id, 'library', { client: answer({ ok: false, failure: 'rate_limited' }) });
    await store.remoteCall(ORG, id, 'library', { client: answer(down) });
    expect((await statusOf(id)).status).toBe('ok');
    await store.remoteCall(ORG, id, 'library', { client: answer(down) });
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

  it('purge leaves a local disk on its way into a board that still holds a hidden one', async () => {
    const id = await addLib('busy.example');
    await seedHidden(id, 6);
    const db = getDb();
    await db.insert(blobs).values({ sha256: sha(60), sizeBytes: 10, storageKey: sha(60) });
    await db.insert(games).values({ id: 'lg60', orgId: ORG, title: 'L', sortTitle: 'l' });
    await db.insert(disks).values({ id: 'ld60', gameId: 'lg60', orgId: ORG, diskNo: 1, sha256: sha(60), sizeBytes: 10 });
    await db.insert(devices).values({
      id: 'dev60', orgId: ORG, name: 'Busy', macAddress: 'AA:BB:CC:DD:EE:60', tokenHash: 'h60',
      mountedDiskId: 'hd6', desiredDiskId: 'ld60', desiredSha256: sha(60),
    });
    // ...and an idle board holding a hidden disk with nothing desired is ejected.
    await seedHidden(id, 7);
    await db.insert(devices).values({ id: 'dev70', orgId: ORG, name: 'Idle', macAddress: 'AA:BB:CC:DD:EE:70', tokenHash: 'h70', mountedDiskId: 'hd7' });
    const [busyBefore] = await db.select().from(devices).where(eq(devices.id, 'dev60'));
    const [idleBefore] = await db.select().from(devices).where(eq(devices.id, 'dev70'));

    expect(await store.purgeHidden(ORG, id)).toEqual({ ejected: 1, deleted: 2 });
    const [busy] = await db.select().from(devices).where(eq(devices.id, 'dev60'));
    expect(busy.desiredDiskId).toBe('ld60');
    expect(busy.desiredSha256).toBe(sha(60));
    expect(busy.desiredVersion).toBe(busyBefore.desiredVersion);
    const [idle] = await db.select().from(devices).where(eq(devices.id, 'dev70'));
    expect(idle.desiredVersion).toBe(idleBefore.desiredVersion + 1);
    expect(idle.lastDiskId).toBeNull();
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

  it('a sealed token that does not open is refused without calling the owner, and the library is not ended (final review 3)', async () => {
    const id = await addLib('rotated.example');
    await getDb().update(remoteLibraries).set({ tokenEnc: 'v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }).where(eq(remoteLibraries.id, id));
    const client = fakeClient();
    const r = await store.remoteCall(ORG, id, 'library', { client });
    expect(r).toEqual({ ok: false, failure: 'token_unreadable' });
    expect(client.getJson).not.toHaveBeenCalled();
    expect((await statusOf(id)).status).toBe('ok');
    expect((await statusOf(id)).lastError).toBe('token_unreadable');
  });

  it('an unknown or foreign library answers not_found', async () => {
    const id = await addLib('foreign.example');
    expect(await store.remoteCall(OTHER, id, 'library', { client: fakeClient() })).toEqual({ ok: false, failure: 'not_found' });
    expect(await store.remoteCall(ORG, 'nope', 'library', { client: fakeClient() })).toEqual({ ok: false, failure: 'not_found' });
  });
});
