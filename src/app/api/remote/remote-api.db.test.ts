import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Client } from 'pg';
import { createHash } from 'node:crypto';

// The recipient's /api/remote/* routes (Task 8), plus the guards carried from Task 6: R-6a (Re-insert / NFC tap of a
// hidden disk), R-6b (local routes 404 hidden ids), R-7 (the hidden row vanishing before the mount). Real Postgres,
// a fake share client (setShareClientForTests), an in-memory disk store.
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_remote_api_test';
const url = new URL(base);
url.pathname = `/${DB}`;
process.env.DATABASE_URL = url.toString();
process.env.BETTER_AUTH_SECRET = 'remote-api-test-secret';
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
    read: async (sha: string) => { const b = stored.get(sha); if (!b) throw new Error('missing'); return b; },
    stat: async (sha: string) => (stored.has(sha) ? { sizeBytes: stored.get(sha)!.byteLength } : null),
    remove: async (sha: string) => { stored.delete(sha); },
  },
  coverStore: { read: async () => null, put: async () => undefined },
  imageStore: { read: async () => null },
}));

const ORG = 'org-remote-api';
const OTHER = 'org-remote-other';
let session = { orgId: ORG, userId: 'u1', email: 'a@b.test' };
vi.mock('@/lib/session', () => ({ requireOrg: async () => session }));
vi.mock('next/server', () => ({ after: vi.fn() }));

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { eq } = await import('drizzle-orm');
const { blobs, disks, games, entitlements } = await import('@/db/schema/catalog');
const { devices } = await import('@/db/schema/devices');
const { transfers } = await import('@/db/schema/transfers');
const { remoteLibraries } = await import('@/db/schema/sharing');
const { ADF_BYTES } = await import('@/lib/adfmfm');
const { stableId } = await import('@/lib/ingest');
const store = await import('@/lib/remote/store');
const { clearCacheForTests } = await import('@/lib/remote/cache');
const { mountDiskResponse } = await import('@/lib/mount-http');
const { tapDevice } = await import('@/lib/nfc/store');
type ShareClient = import('@/lib/share/client').ShareClient;

const TOKEN = 'wfst_' + 'r'.repeat(43);
const CODE = 'wfsc_' + 'r'.repeat(43);
const T1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const D1 = 'bbbbbbbb-0000-4000-8000-000000000001';

const adf = (fill: number) => new Uint8Array(ADF_BYTES).fill(fill);
const hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

type R = { ok: boolean; [k: string]: unknown };
const owner = { json: new Map<string, R>(), bytes: new Map<string, R>(), claim: { ok: true, value: { token: TOKEN, library: { name: "Rob's games" } } } as R };
const client = {
  ping: vi.fn(),
  claim: vi.fn(async () => owner.claim),
  getJson: vi.fn(async (_t: unknown, path: string) => owner.json.get(path) ?? { ok: false, failure: 'not_found' }),
  getBytes: vi.fn(async (_t: unknown, path: string) => owner.bytes.get(path) ?? { ok: false, failure: 'not_found' }),
};

function titleDetail(b: Uint8Array, diskIds = [D1]) {
  return {
    ok: true,
    value: {
      title: { id: T1, title: 'Turrican II', year: 1991, publisher: 'Rainbow Arts', kind: 'game', diskCount: diskIds.length, hasCover: true, coverDigest: 'c1', collectionIds: [] },
      disks: diskIds.map((id, i) => ({ id, name: `Disk ${i + 1}`, diskNo: i + 1, sizeBytes: b.length, sha256: hex(b), imageFormat: 'adf', extractable: true, updatedAt: '2026-10-28T00:00:00.000Z' })),
    },
  };
}
function shareDisk(b: Uint8Array) {
  owner.json.set(`titles/${T1}`, titleDetail(b));
  owner.bytes.set(`disks/${D1}/bytes`, { ok: true, value: b, etag: hex(b) });
}

const req = (path: string, method = 'GET', body?: unknown) => new Request(`http://test${path}`, {
  method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

const listRoute = await import('./route');
const libRoute = await import('./[id]/route');
const libraryRoute = await import('./[id]/library/route');
const titlesRoute = await import('./[id]/titles/route');
const titleRoute = await import('./[id]/titles/[titleId]/route');
const filesRoute = await import('./[id]/disks/[diskId]/files/route');
const mountRoute = await import('./[id]/disks/[diskId]/mount/route');
const sendRoute = await import('./[id]/disks/[diskId]/send/route');
const downloadRoute = await import('./[id]/disks/[diskId]/download/route');
const coversRoute = await import('./[id]/covers/[titleId]/route');
const localMount = await import('@/app/api/devices/[id]/mount/route');

let n = 0;
async function addLibrary(): Promise<string> {
  const res = await listRoute.POST(req('/api/remote', 'POST', { link: `https://owner${++n}.example/s/${CODE}` }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

const DEV = 'dev-remote-api';
async function addDevice(id = DEV, orgId = ORG) {
  await getDb().insert(devices).values({
    id, orgId, name: `Board ${id}`, macAddress: `AA:BB:CC:00:00:${id.length.toString(16).padStart(2, '0')}`, tokenHash: `h-${id}`,
    firmwareVersion: '1.21.1+abc1234', lastSeenAt: new Date(),
  });
}
const deviceRow = async (id = DEV) => (await getDb().select().from(devices).where(eq(devices.id, id)))[0];
const hiddenId = (lib: string) => stableId('rdisk', ORG, lib, D1);
const hiddenGame = (lib: string) => stableId('rgame', ORG, lib, T1);

async function mountRemote(lib: string, extra: Record<string, unknown> = {}) {
  return mountRoute.POST(req(`/api/remote/${lib}/disks/${D1}/mount`, 'POST', { titleId: T1, deviceId: DEV, ...extra }),
    params({ id: lib, diskId: D1 }));
}

describe('/api/remote', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
    store.setShareClientForTests(client as unknown as ShareClient);
  });
  afterAll(async () => {
    store.setShareClientForTests(null);
    await closeDb();
    await admin(`drop database if exists ${DB} with (force)`);
  });
  beforeEach(async () => {
    session = { orgId: ORG, userId: 'u1', email: 'a@b.test' };
    clearCacheForTests();
    store.resetFailureCountsForTests();
    stored.clear();
    owner.json.clear();
    owner.bytes.clear();
    owner.claim = { ok: true, value: { token: TOKEN, library: { name: "Rob's games" } } };
    vi.clearAllMocks();
    const db = getDb();
    await db.delete(transfers);
    await db.delete(devices);
    await db.delete(disks);
    await db.delete(games);
    await db.delete(entitlements);
    await db.delete(remoteLibraries);
    await addDevice();
  });

  describe('list, add, remove', () => {
    it('adds from a link, lists it with its host, removes it', async () => {
      const id = await addLibrary();
      const list = await (await listRoute.GET()).json();
      expect(list.libraries).toEqual([expect.objectContaining({ id, name: "Rob's games", host: `owner${n}.example`, status: 'ok' })]);
      expect(JSON.stringify(list)).not.toContain('wfst_');

      const del = await libRoute.DELETE(req(`/api/remote/${id}`, 'DELETE'), params({ id }));
      expect(del.status).toBe(200);
      expect((await (await listRoute.GET()).json()).libraries).toEqual([]);
      expect((await libRoute.DELETE(req(`/api/remote/${id}`, 'DELETE'), params({ id }))).status).toBe(404);
    });

    it('says why an add failed', async () => {
      expect((await listRoute.POST(req('/api/remote', 'POST', { link: 'not a link' }))).status).toBe(400);
      owner.claim = { ok: false, failure: 'invalid_or_used' };
      const used = await listRoute.POST(req('/api/remote', 'POST', { link: `https://owner-x.example/s/${CODE}` }));
      expect(used.status).toBe(404);
      expect(await used.json()).toEqual({ error: 'invalid_or_used' });
      owner.claim = { ok: false, failure: 'unreachable', detail: 'dns' };
      const down = await listRoute.POST(req('/api/remote', 'POST', { link: `https://owner-y.example/s/${CODE}` }));
      expect(down.status).toBe(502);
      expect(await down.json()).toEqual({ error: 'unreachable', host: 'owner-y.example' });
      // final review 6: protocol names the host and keeps the detail; a garbled answer is its own code.
      owner.claim = { ok: false, failure: 'protocol', detail: 'local_older' };
      const old = await listRoute.POST(req('/api/remote', 'POST', { link: `https://owner-z.example/s/${CODE}` }));
      expect(old.status).toBe(409);
      expect(await old.json()).toEqual({ error: 'protocol', host: 'owner-z.example', detail: 'local_older' });
      owner.claim = { ok: false, failure: 'bad_response', detail: 'json' };
      const odd = await listRoute.POST(req('/api/remote', 'POST', { link: `https://owner-w.example/s/${CODE}` }));
      expect(odd.status).toBe(502);
      expect(await odd.json()).toEqual({ error: 'bad_response', host: 'owner-w.example' });
    });

    it('removing ejects a hidden disk from the drive before deleting it', async () => {
      const id = await addLibrary();
      shareDisk(adf(3));
      expect((await mountRemote(id)).status).toBe(200);
      const v = (await deviceRow()).desiredVersion;
      await libRoute.DELETE(req(`/api/remote/${id}`, 'DELETE'), params({ id }));
      const d = await deviceRow();
      expect(d.desiredDiskId).toBeNull();
      expect(d.desiredVersion).toBe(v + 1);
      expect(await getDb().select().from(disks).where(eq(disks.orgId, ORG))).toEqual([]);
    });
  });

  describe('browsing', () => {
    it('proxies titles with only the documented parameters, cached for 60 s', async () => {
      const id = await addLibrary();
      const page = { titles: [{ id: T1, title: 'Turrican II' }], nextCursor: null };
      owner.json.set('titles?collection=c1&q=tur', { ok: true, value: page });
      const get = () => titlesRoute.GET(req(`/api/remote/${id}/titles?q=tur&collection=c1&evil=1`), params({ id }));
      const a = await get();
      expect(a.status).toBe(200);
      expect(await a.json()).toEqual(page);
      expect(await (await get()).json()).toEqual(page);
      expect(client.getJson).toHaveBeenCalledTimes(1);
      expect(client.getJson).toHaveBeenCalledWith(expect.objectContaining({ token: TOKEN }), 'titles?collection=c1&q=tur');
    });

    it('proxies the library, a title and a disk\'s files', async () => {
      const id = await addLibrary();
      owner.json.set('library', { ok: true, value: { name: 'Rob', collections: [], titles: 1, disks: 1 } });
      shareDisk(adf(1));
      owner.json.set(`disks/${D1}/files`, { ok: true, value: { unreadable: 'not_dos' } });
      expect(await (await libraryRoute.GET(req('/x'), params({ id }))).json()).toMatchObject({ name: 'Rob' });
      expect(await (await titleRoute.GET(req('/x'), params({ id, titleId: T1 }))).json()).toMatchObject({ title: { id: T1 } });
      expect(await (await filesRoute.GET(req('/x'), params({ id, diskId: D1 }))).json()).toEqual({ unreadable: 'not_dos' });
    });

    it('maps the owner\'s failures to HTTP, and a 401 ends the library', async () => {
      const id = await addLibrary();
      const cases: [R, number, unknown][] = [
        [{ ok: false, failure: 'not_found' }, 404, { error: 'not_found' }],
        [{ ok: false, failure: 'rate_limited' }, 429, { error: 'rate_limited' }],
        [{ ok: false, failure: 'unreachable', detail: 'dns' }, 502, { error: 'unreachable', host: `owner${n}.example` }],
        [{ ok: false, failure: 'protocol', detail: 'local_older' }, 409, { error: 'protocol', host: `owner${n}.example`, detail: 'local_older' }],
        [{ ok: false, failure: 'bad_response', detail: 'json' }, 502, { error: 'bad_response', host: `owner${n}.example` }],
      ];
      for (const [answer, status, body] of cases) {
        owner.json.set('library', answer);
        const res = await libraryRoute.GET(req('/x'), params({ id }));
        expect(res.status).toBe(status);
        expect(await res.json()).toEqual(body);
      }
      owner.json.set('library', { ok: false, failure: 'ended' });
      const res = await libraryRoute.GET(req('/x'), params({ id }));
      expect(res.status).toBe(410);
      expect(await res.json()).toEqual({ error: 'ended' });
      expect((await store.listRemoteLibraries(ORG))[0].status).toBe('ended');
      // An ended library is never called again.
      client.getJson.mockClear();
      expect((await titlesRoute.GET(req('/x'), params({ id }))).status).toBe(410);
      expect(client.getJson).not.toHaveBeenCalled();
    });

    it('proxies a cover as an image the browser keeps for an hour; refuses non-image bytes', async () => {
      const id = await addLibrary();
      owner.bytes.set(`covers/${T1}`, { ok: true, value: PNG, etag: 'c1' });
      const res = await coversRoute.GET(req('/x'), params({ id, titleId: T1 }));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('cache-control')).toBe('private, max-age=3600');
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
      owner.bytes.set(`covers/${T1}`, { ok: true, value: new TextEncoder().encode('<html>'), etag: 'c1' });
      const odd = await coversRoute.GET(req('/x'), params({ id, titleId: T1 }));
      expect(odd.status).toBe(502);
      expect(await odd.json()).toEqual({ error: 'bad_response', host: expect.any(String) });
    });
  });

  describe('disk actions', () => {
    it('mount materialises a hidden row and points the board at it', async () => {
      const id = await addLibrary();
      const b = adf(5);
      shareDisk(b);
      const res = await mountRemote(id);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ version: 1, undo: { diskId: null } });
      const [row] = await getDb().select().from(disks).where(eq(disks.id, hiddenId(id)));
      expect(row).toMatchObject({ remoteLibraryId: id, remoteDiskId: D1, sha256: hex(b) });
      const d = await deviceRow();
      expect(d.desiredDiskId).toBe(hiddenId(id));
      expect(d.desiredSha256).toBe(hex(b));
    });

    it('mount of a disk no longer in the title answers not_shared and mounts nothing', async () => {
      const id = await addLibrary();
      shareDisk(adf(5));
      owner.json.set(`titles/${T1}`, titleDetail(adf(5), ['cccccccc-0000-4000-8000-000000000009']));
      const res = await mountRemote(id);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_shared' });
      expect((await deviceRow()).desiredDiskId).toBeNull();
    });

    it('mount after a revoke answers ended', async () => {
      const id = await addLibrary();
      owner.json.set(`titles/${T1}`, { ok: false, failure: 'ended' });
      const res = await mountRemote(id);
      expect(res.status).toBe(410);
      expect(await res.json()).toEqual({ error: 'ended' });
    });

    it('mount refuses a board that is not this team\'s before fetching anything', async () => {
      const id = await addLibrary();
      shareDisk(adf(5));
      await addDevice('dev-other', OTHER);
      const res = await mountRemote(id, { deviceId: 'dev-other' });
      expect(res.status).toBe(404);
      expect(client.getBytes).not.toHaveBeenCalled();
    });

    it('send materialises and queues the whole disk', async () => {
      const id = await addLibrary();
      const b = adf(6);
      shareDisk(b);
      const res = await sendRoute.POST(req('/x', 'POST', { titleId: T1, deviceId: DEV }), params({ id, diskId: D1 }));
      expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
      const rows = await getDb().select().from(transfers).where(eq(transfers.deviceId, DEV));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ blobSha256: hex(b), path: 'Disk 1.adf', sizeBytes: ADF_BYTES });
    });

    it('send to an unknown board answers no_device without fetching', async () => {
      const id = await addLibrary();
      shareDisk(adf(6));
      const res = await sendRoute.POST(req('/x', 'POST', { titleId: T1, deviceId: 'nope' }), params({ id, diskId: D1 }));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'no_device' });
      expect(client.getJson).not.toHaveBeenCalled();
    });

    it('download returns the checked bytes as an attachment and keeps no disk row', async () => {
      const id = await addLibrary();
      const b = adf(7);
      shareDisk(b);
      const res = await downloadRoute.GET(req(`/x?titleId=${T1}`), params({ id, diskId: D1 }));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toContain('filename="Turrican II - Disk 1.adf"');
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(b);
      expect(await getDb().select().from(disks).where(eq(disks.orgId, ORG))).toEqual([]);
      expect(stored.size).toBe(0);
    });

    it('download refuses bytes that do not match their ETag', async () => {
      const id = await addLibrary();
      shareDisk(adf(7));
      owner.bytes.set(`disks/${D1}/bytes`, { ok: true, value: adf(8), etag: hex(adf(7)) });
      const res = await downloadRoute.GET(req(`/x?titleId=${T1}`), params({ id, diskId: D1 }));
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'mismatch' });
    });

    it('download of a disk not in the title answers not_shared', async () => {
      const id = await addLibrary();
      shareDisk(adf(7));
      const other = 'dddddddd-0000-4000-8000-000000000001';
      const res = await downloadRoute.GET(req(`/x?titleId=${T1}`), params({ id, diskId: other }));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_shared' });
    });
  });

  it('another team\'s remote library id is 404 everywhere, and calls no owner', async () => {
    const id = await addLibrary();
    shareDisk(adf(9));
    client.getJson.mockClear();
    session = { orgId: OTHER, userId: 'u2', email: 'c@d.test' };
    await addDevice('dev-o2', OTHER);
    const answers = [
      await libRoute.DELETE(req('/x', 'DELETE'), params({ id })),
      await libraryRoute.GET(req('/x'), params({ id })),
      await titlesRoute.GET(req('/x'), params({ id })),
      await titleRoute.GET(req('/x'), params({ id, titleId: T1 })),
      await filesRoute.GET(req('/x'), params({ id, diskId: D1 })),
      await coversRoute.GET(req('/x'), params({ id, titleId: T1 })),
      await mountRoute.POST(req('/x', 'POST', { titleId: T1, deviceId: 'dev-o2' }), params({ id, diskId: D1 })),
      await sendRoute.POST(req('/x', 'POST', { titleId: T1, deviceId: 'dev-o2' }), params({ id, diskId: D1 })),
      await downloadRoute.GET(req(`/x?titleId=${T1}`), params({ id, diskId: D1 })),
    ];
    for (const a of answers) {
      expect(a.status).toBe(404);
      expect(await a.json()).toEqual({ error: 'not_found' });
    }
    expect(client.getJson).not.toHaveBeenCalled();
    expect(client.getBytes).not.toHaveBeenCalled();
    expect((await listRoute.GET().then((r) => r.json())).libraries).toEqual([]);
    session = { orgId: ORG, userId: 'u1', email: 'a@b.test' };
    expect(await store.listRemoteLibraries(ORG)).toHaveLength(1);
  });

  describe('R-7: the hidden row vanishing before the mount', () => {
    it('answers ended when the hidden disk is gone, not_found for a local one', async () => {
      const r = await mountDiskResponse(ORG, DEV, 'gone-hidden-disk', 'df0', { hidden: true });
      expect(r.status).toBe(410);
      expect(await r.json()).toEqual({ error: 'ended' });
      const l = await mountDiskResponse(ORG, DEV, 'gone-local-disk', 'df0');
      expect(l.status).toBe(404);
      const d1 = await mountDiskResponse(ORG, DEV, 'gone-hidden-disk', 'df1', { hidden: true });
      expect(d1.status).toBe(410);
    });

    it('an unknown board is still not_found for a hidden disk that exists', async () => {
      const id = await addLibrary();
      shareDisk(adf(4));
      await mountRemote(id);
      const r = await mountDiskResponse(ORG, 'no-such-board', hiddenId(id), 'df0', { hidden: true });
      expect(r.status).toBe(404);
    });
  });

  describe('R-6a: Re-insert / Undo and NFC tap of a hidden disk', () => {
    const reinsert = (diskId: string) => localMount.POST(req(`/api/devices/${DEV}/mount`, 'POST', { diskId }), params({ id: DEV }));

    it('re-insert asks the owner again and mounts while it is still shared', async () => {
      const id = await addLibrary();
      shareDisk(adf(2));
      await mountRemote(id);
      await getDb().update(devices).set({ desiredDiskId: null, desiredSha256: null }).where(eq(devices.id, DEV));
      client.getJson.mockClear();
      const res = await reinsert(hiddenId(id));
      expect(res.status).toBe(200);
      expect(client.getJson).toHaveBeenCalledWith(expect.anything(), `titles/${T1}`);
      expect((await deviceRow()).desiredDiskId).toBe(hiddenId(id));
    });

    it('re-insert of a disk the owner no longer shares answers not_shared and mounts nothing', async () => {
      const id = await addLibrary();
      shareDisk(adf(2));
      await mountRemote(id);
      await getDb().update(devices).set({ desiredDiskId: null, desiredSha256: null }).where(eq(devices.id, DEV));
      owner.json.set(`titles/${T1}`, { ok: false, failure: 'not_found' });
      const res = await reinsert(hiddenId(id));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_shared' });
      expect((await deviceRow()).desiredDiskId).toBeNull();
    });

    it('re-insert after a revoke answers ended and the hidden row is gone', async () => {
      const id = await addLibrary();
      shareDisk(adf(2));
      await mountRemote(id);
      owner.json.set(`titles/${T1}`, { ok: false, failure: 'ended' });
      const res = await reinsert(hiddenId(id));
      expect(res.status).toBe(410);
      expect(await getDb().select().from(disks).where(eq(disks.id, hiddenId(id)))).toEqual([]);
    });

    it('re-insert of a local disk is untouched (no owner call)', async () => {
      const db = getDb();
      const b = adf(11);
      stored.set(hex(b), b);
      await db.insert(blobs).values({ sha256: hex(b), sizeBytes: ADF_BYTES, storageKey: `adf/${hex(b)}` }).onConflictDoNothing();
      await db.insert(entitlements).values({ orgId: ORG, sha256: hex(b), sourceFilename: 'local.adf' });
      await db.insert(games).values({ id: 'g-local', orgId: ORG, title: 'Local', sortTitle: 'local' });
      await db.insert(disks).values({ id: 'd-local', gameId: 'g-local', orgId: ORG, diskNo: 1, sha256: hex(b), sizeBytes: ADF_BYTES });
      const res = await reinsert('d-local');
      expect(res.status).toBe(200);
      expect(client.getJson).not.toHaveBeenCalled();
    });

    it('an NFC tap never mounts a hidden disk', async () => {
      const id = await addLibrary();
      shareDisk(adf(2));
      await mountRemote(id);
      await getDb().update(devices).set({ desiredDiskId: null, desiredSha256: null }).where(eq(devices.id, DEV));
      const v = (await deviceRow()).desiredVersion;
      const r = await tapDevice(DEV, ORG, hiddenId(id), new Date());
      expect(r.outcome).toBe('not_found');
      const d = await deviceRow();
      expect(d.desiredDiskId).toBeNull();
      expect(d.desiredVersion).toBe(v);
    });
  });

  describe('R-6b: local routes answer 404 for hidden ids', () => {
    it('every disk and game route refuses a hidden id and changes nothing', async () => {
      const id = await addLibrary();
      shareDisk(adf(12));
      await mountRemote(id);
      const dId = hiddenId(id);
      const gId = hiddenGame(id);
      const before = await getDb().select().from(disks).where(eq(disks.id, dId));
      const gBefore = await getDb().select().from(games).where(eq(games.id, gId));
      const sha = hex(adf(12));

      const d = (p: Record<string, string> = {}) => params({ id: dId, ...p });
      const g = (p: Record<string, string> = {}) => params({ id: gId, ...p });
      const json = (body: unknown, method = 'POST') => req('/x', method, body);
      const imp = (p: string) => import(/* @vite-ignore */ p);

      // The destructive ones last, so a missing guard on them cannot hide another route's.
      const calls: [string, () => Promise<Response>][] = [
        ['GET disks/[id]/adf', async () => (await imp('@/app/api/disks/[id]/adf/route')).GET(req('/x'), d())],
        ['PATCH disks/[id]', async () => (await imp('@/app/api/disks/[id]/route')).PATCH(json({ writeProtected: true }, 'PATCH'), d())],
        ['POST disks/[id]/extract', async () => (await imp('@/app/api/disks/[id]/extract/route')).POST(req('/x', 'POST'), d())],
        ['POST disks/[id]/files', async () => (await imp('@/app/api/disks/[id]/files/route')).POST(json({}), d())],
        ['GET disks/[id]/files/zip', async () => (await imp('@/app/api/disks/[id]/files/zip/route')).GET(req('/x'), d())],
        ['GET disks/[id]/files/[block]', async () => (await imp('@/app/api/disks/[id]/files/[block]/route')).GET(req('/x'), d({ block: '880' }))],
        ['PATCH disks/[id]/files/[block]', async () => (await imp('@/app/api/disks/[id]/files/[block]/route')).PATCH(json({ name: 'x' }, 'PATCH'), d({ block: '880' }))],
        ['DELETE disks/[id]/files/[block]', async () => (await imp('@/app/api/disks/[id]/files/[block]/route')).DELETE(req('/x', 'DELETE'), d({ block: '880' }))],
        ['POST disks/[id]/files/batch', async () => (await imp('@/app/api/disks/[id]/files/batch/route')).POST(json({}), d())],
        ['POST disks/[id]/files/bulk', async () => (await imp('@/app/api/disks/[id]/files/bulk/route')).POST(json({}), d())],
        ['POST disks/[id]/move-out', async () => (await imp('@/app/api/disks/[id]/move-out/route')).POST(req('/x', 'POST'), d())],
        ['POST disks/[id]/undo-move', async () => (await imp('@/app/api/disks/[id]/undo-move/route')).POST(json({ snapshot: { diskIds: [dId] } }), d())],
        ['POST disks/[id]/restore', async () => (await imp('@/app/api/disks/[id]/restore/route')).POST(json({ versionId: 'v' }), d())],
        ['PATCH disks/[id]/volume-name', async () => (await imp('@/app/api/disks/[id]/volume-name/route')).PATCH(json({ name: 'X' }, 'PATCH'), d())],
        ['PATCH games/[id]', async () => (await imp('@/app/api/games/[id]/route')).PATCH(json({ title: 'Mine' }, 'PATCH'), g())],
        ['POST games/[id]/reset', async () => (await imp('@/app/api/games/[id]/reset/route')).POST(json({ groups: ['title'] }), g())],
        ['PUT games/[id]/cover', async () => (await imp('@/app/api/games/[id]/cover/route')).PUT(req('/x', 'PUT'), g())],
        ['DELETE games/[id]/cover', async () => (await imp('@/app/api/games/[id]/cover/route')).DELETE(req('/x', 'DELETE'), g())],
        ['GET games/[id]/cover/[sha256]', async () => (await imp('@/app/api/games/[id]/cover/[sha256]/route')).GET(req('/x'), g({ sha256: sha }))],
        ['POST games/[id]/demozoo', async () => (await imp('@/app/api/games/[id]/demozoo/route')).POST(json({ productionId: 1 }), g())],
        ['DELETE games/[id]/demozoo', async () => (await imp('@/app/api/games/[id]/demozoo/route')).DELETE(req('/x', 'DELETE'), g())],
        ['POST games/[id]/demozoo/dismiss', async () => (await imp('@/app/api/games/[id]/demozoo/dismiss/route')).POST(json({ productionId: 1 }), g())],
        ['PUT games/[id]/disk-order', async () => (await imp('@/app/api/games/[id]/disk-order/route')).PUT(json({ diskIds: [dId] }, 'PUT'), g())],
        ['POST games/[id]/disks', async () => (await imp('@/app/api/games/[id]/disks/route')).POST(json({ diskIds: [dId] }), g())],
        ['POST transfers/from-disk (whole)', async () => (await imp('@/app/api/transfers/from-disk/route')).POST(json({ deviceId: DEV, diskId: dId, whole: true }))],
        ['POST transfers/from-disk (blocks)', async () => (await imp('@/app/api/transfers/from-disk/route')).POST(json({ deviceId: DEV, diskId: dId, blocks: [880] }))],
        ['DELETE disks/[id]', async () => (await imp('@/app/api/disks/[id]/route')).DELETE(req('/x', 'DELETE'), d())],
        ['DELETE games/[id]', async () => (await imp('@/app/api/games/[id]/route')).DELETE(req('/x', 'DELETE'), g())],
      ];
      for (const [name, call] of calls) {
        const res = await call();
        expect.soft(res.status, name).toBe(404);
      }
      expect(await getDb().select().from(disks).where(eq(disks.id, dId))).toEqual(before);
      expect(await getDb().select().from(games).where(eq(games.id, gId))).toEqual(gBefore);
      expect(await getDb().select().from(transfers)).toEqual([]);
    });

    it('the device-facing image route still serves a hidden disk to the board', async () => {
      const id = await addLibrary();
      const b = adf(13);
      shareDisk(b);
      await mountRemote(id);
      const { hashDeviceToken } = await import('@/lib/device-token');
      const token = 'wadf_' + 't'.repeat(43);
      await getDb().update(devices).set({ tokenHash: hashDeviceToken(token) }).where(eq(devices.id, DEV));
      const { GET } = await import('@/app/api/device/image/[sha256]/route');
      const res = await GET(new Request(`http://test/api/device/image/${hex(b)}`, { headers: { authorization: `Bearer ${token}` } }),
        params({ sha256: hex(b) }));
      expect(res.status).toBe(200);
    });
  });
});
