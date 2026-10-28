// The person's routes for the From the Amiga area (spec 2026-10-18 §4). The library is mocked; its db tests are Task 12's.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { DISK_IMAGE_PATTERN } from '@/lib/archive/disk-image';
import { LIBRARY_EXT, libraryEligible } from '@/lib/from-amiga-ui';

const requireOrg = vi.fn(() => Promise.resolve({ orgId: 'org-1', userId: 'user-1', email: 'a@b.test' }));
vi.mock('@/lib/session', () => ({ requireOrg: () => requireOrg() }));
// and/eq record their conditions, so the disks mock below answers only the rows the where clause really selects: dropping
// an org (or id / sha) condition from the route changes what the mock returns.
vi.mock('drizzle-orm', async (orig) => ({
  ...(await orig<typeof import('drizzle-orm')>()),
  and: (...c: unknown[]) => ({ and: c }),
  eq: (col: unknown, v: unknown) => ({ eq: [col, v] }),
}));
// Any other condition (the route's isNull(remote_library_id), library sharing spec §4.1) holds for every row here:
// the table models local disks only.
type Cond = { and: Cond[] } | { eq: [unknown, unknown] } | object | undefined;
const flat = (c: Cond): [unknown, unknown][] =>
  (!c ? [] : 'and' in c ? c.and.flatMap(flat) : 'eq' in c ? [c.eq] : []);
const diskTable: { id: string; gameId: string; orgId: string; sha256: string }[] = [];
const { disks: disksT } = await import('@/db/schema/catalog');
vi.mock('@/db', () => ({ getDb: () => ({
  select: () => ({ from: () => ({ where: (c: Cond) => ({ limit: async () => {
    const f = flat(c);
    const want = (col: unknown) => f.find(([k]) => k === col)?.[1];
    return diskTable.filter((d) => (['orgId', 'id', 'sha256'] as const).every((k) => { const w = want(disksT[k]); return w === undefined || d[k] === w; }))
      .map(({ id, gameId }) => ({ id, gameId }));
  } }) }) }),
}) }));
const store = new Map<string, Uint8Array>();
vi.mock('@/lib/storage', () => ({ diskStore: {
  stat: async (s: string) => (store.has(s) ? { sizeBytes: store.get(s)!.byteLength } : null),
  put: async (s: string, b: Uint8Array) => { store.set(s, b); return { key: `adf/${s}` }; },
  read: async (s: string) => { const b = store.get(s); if (!b) throw new Error('missing'); return b; },
} }));
const U = { listUploads: vi.fn(), uploadBoards: vi.fn(), getUpload: vi.fn(), deleteUpload: vi.fn(), stopUpload: vi.fn(), clearUploads: vi.fn(), setLibraryDisk: vi.fn() };
vi.mock('@/lib/amiga-uploads', async (orig) => ({
  ...(await orig<typeof import('@/lib/amiga-uploads')>()),
  listUploads: (...a: unknown[]) => U.listUploads(...a), uploadBoards: (...a: unknown[]) => U.uploadBoards(...a),
  getUpload: (...a: unknown[]) => U.getUpload(...a), deleteUpload: (...a: unknown[]) => U.deleteUpload(...a),
  stopUpload: (...a: unknown[]) => U.stopUpload(...a),
  clearUploads: (...a: unknown[]) => U.clearUploads(...a), setLibraryDisk: (...a: unknown[]) => U.setLibraryDisk(...a),
}));
const registerUploads = vi.fn();
vi.mock('@/lib/ingest-complete', () => ({ registerUploads: (...a: unknown[]) => registerUploads(...a) }));
const findSendTarget = vi.fn();
vi.mock('@/lib/send-targets', () => ({ findSendTarget: (...a: unknown[]) => findSendTarget(...a) }));
const queueTransferFromBlob = vi.fn();
vi.mock('@/lib/transfers', () => ({ queueTransferFromBlob: (...a: unknown[]) => queueTransferFromBlob(...a) }));

const { GET: listGET } = await import('./route');
const { POST: clearPOST } = await import('./clear/route');
const { DELETE: oneDELETE } = await import('./[id]/route');
const { GET: fileGET } = await import('./[id]/file/route');
const { POST: libraryPOST } = await import('./[id]/library/route');
const { POST: sendPOST } = await import('./[id]/send/route');
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const ADF = new Uint8Array(901_120).fill(0x44);
const stored = (over: Record<string, unknown> = {}) => ({
  id: 'up-1', orgId: 'org-1', deviceId: 'dev-1', deviceName: 'Bench', path: 'Games/Lemmings.adf', sizeBytes: ADF.byteLength,
  status: 'stored', blobSha256: sha(ADF), protection: 0x40, comment: 'note', libraryDiskId: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks(); store.clear(); store.set(sha(ADF), ADF);
  diskTable.length = 0; diskTable.push({ id: 'disk-9', gameId: 'game-9', orgId: 'org-1', sha256: sha(ADF) });
});

describe('GET /api/uploads', () => {
  it("lists the session org's area, filtered by ?board=, with the boards and the server's time", async () => {
    U.listUploads.mockResolvedValue([{ id: 'up-1' }]);
    U.uploadBoards.mockResolvedValue([{ id: 'dev-1', name: 'Bench', key: 'AB12', canUpload: true }]);
    const r = await listGET(new Request('http://x/api/uploads?board=dev-1'));
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const b = await r.json();
    expect(b.rows).toEqual([{ id: 'up-1' }]); expect(b.boards[0].key).toBe('AB12'); expect(typeof b.now).toBe('number');
    expect(U.listUploads).toHaveBeenCalledWith(expect.anything(), 'org-1', 'dev-1', expect.any(Date));
  });
});

describe('GET /api/uploads/<id>/file', () => {
  it('streams a stored file as an attachment that is never rendered', async () => {
    U.getUpload.mockResolvedValue(stored({ path: 'Web/évil page.html', sizeBytes: 3, blobSha256: sha(new Uint8Array([60, 104, 62])) }));
    store.set(sha(new Uint8Array([60, 104, 62])), new Uint8Array([60, 104, 62]));
    const r = await fileGET(new Request('http://x/api/uploads/up-1/file'), ctx('up-1'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-disposition')).toBe(`attachment; filename="_vil page.html"; filename*=UTF-8''%C3%A9vil%20page.html`);
    expect(r.headers.get('content-length')).toBe('3');
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array([60, 104, 62]));
    expect(U.getUpload).toHaveBeenCalledWith(expect.anything(), 'org-1', 'up-1');
  });
  it('names a Latin-1 file with an ASCII fallback and an RFC 5987 name', async () => {
    U.getUpload.mockResolvedValue(stored({ path: 'Docs/Café.txt', sizeBytes: 3 }));
    store.set(sha(ADF), new Uint8Array([1, 2, 3]));
    const r = await fileGET(new Request('http://x/api/uploads/up-1/file'), ctx('up-1'));
    expect(r.headers.get('content-disposition')).toBe(`attachment; filename="Caf_.txt"; filename*=UTF-8''Caf%C3%A9.txt`);
  });
  it('cannot be made to inject a header or a second parameter by a name with a quote, CR, LF or semicolon', async () => {
    U.getUpload.mockResolvedValue(stored({ path: 'x/a"b\r\nSet-Cookie z=1;\\q\'(*).txt', sizeBytes: 3 }));
    store.set(sha(ADF), new Uint8Array([1, 2, 3]));
    const r = await fileGET(new Request('http://x/api/uploads/up-1/file'), ctx('up-1'));
    expect(r.status).toBe(200);
    const cd = r.headers.get('content-disposition')!;
    expect(cd).not.toMatch(/[\r\n]/);
    expect(cd).toBe(`attachment; filename="a_bSet-Cookie z=1__q'(*).txt"; filename*=UTF-8''a%22bSet-Cookie%20z%3D1%3B%5Cq%27%28%2A%29.txt`);
    expect(r.headers.get('set-cookie')).toBeNull();
  });
  it('is 404 for a stored file past its 30 days', async () => {
    U.getUpload.mockResolvedValue(stored({ expiresAt: new Date(Date.now() - 1000) }));
    expect((await fileGET(new Request('http://x/api/uploads/up-1/file'), ctx('up-1'))).status).toBe(404);
  });
  it('is 404 for another org, a deleted, failed or receiving row', async () => {
    for (const row of [null, stored({ status: 'receiving', blobSha256: null }), stored({ status: 'failed', blobSha256: null })]) {
      U.getUpload.mockResolvedValueOnce(row);
      expect((await fileGET(new Request('http://x/api/uploads/up-1/file'), ctx('up-1'))).status).toBe(404);
    }
  });
});

describe('POST /api/uploads/<id>/library', () => {
  it('normalises the image, stores it under its own sha, registers it as an upload would, and records the disk', async () => {
    U.getUpload.mockResolvedValue(stored());
    registerUploads.mockResolvedValue(Response.json({ created: 1, disks: 1, rejected: 0, rejectedReasons: {} }));
    const r = await libraryPOST(new Request('http://x', { method: 'POST' }), ctx('up-1'));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ diskId: 'disk-9', gameId: 'game-9' });
    expect(registerUploads).toHaveBeenCalledWith('org-1', [{ sha256: sha(ADF), sizeBytes: 901_120, filename: 'Lemmings.adf' }]);
    expect(U.setLibraryDisk).toHaveBeenCalledWith(expect.anything(), 'org-1', 'up-1', 'disk-9');
  });
  it('answers the disk already added without registering again', async () => {
    U.getUpload.mockResolvedValue(stored({ libraryDiskId: 'disk-9' }));
    const r = await libraryPOST(new Request('http://x', { method: 'POST' }), ctx('up-1'));
    expect(await r.json()).toEqual({ diskId: 'disk-9', gameId: 'game-9' });
    expect(registerUploads).not.toHaveBeenCalled();
  });
  it("never reuses or answers another org's disk named by libraryDiskId", async () => {
    diskTable.length = 0;
    diskTable.push({ id: 'disk-x', gameId: 'game-x', orgId: 'org-other', sha256: sha(ADF) });
    U.getUpload.mockResolvedValue(stored({ libraryDiskId: 'disk-x' }));
    registerUploads.mockResolvedValue(Response.json({ created: 1, disks: 1, rejected: 0, rejectedReasons: {} }));
    const r = await libraryPOST(new Request('http://x', { method: 'POST' }), ctx('up-1'));
    // Not found in org-1 (neither by id nor by sha), so it is not handed out and nothing is recorded against it.
    expect(r.status).toBe(502);
    expect(U.setLibraryDisk).not.toHaveBeenCalled();
    expect(registerUploads).toHaveBeenCalledOnce();
  });
  it('answers JSON 500 server when the normaliser or the ingest throws', async () => {
    U.getUpload.mockResolvedValue(stored());
    registerUploads.mockRejectedValue(new Error('boom'));
    const r = await libraryPOST(new Request('http://x', { method: 'POST' }), ctx('up-1'));
    expect(r.status).toBe(500); expect(await r.json()).toEqual({ error: 'server' });
  });
  it('lets the sign-in redirect through: a signed-out request is never a 500', async () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/sign-in;307;' });
    requireOrg.mockRejectedValueOnce(redirect);
    await expect(libraryPOST(new Request('http://x', { method: 'POST' }), ctx('up-1'))).rejects.toBe(redirect);
  });
  it('refuses what is not a library disk image, and says why a refused one was refused', async () => {
    U.getUpload.mockResolvedValueOnce(stored({ path: 'Archive.lha' }));
    let r = await libraryPOST(new Request('http://x', { method: 'POST' }), ctx('up-1'));
    expect(r.status).toBe(422); expect((await r.json()).error).toBe('not_a_disk_image');
    U.getUpload.mockResolvedValueOnce(stored());
    registerUploads.mockResolvedValueOnce(Response.json({ created: 0, rejected: 1, rejectedReasons: { [sha(ADF)]: 'not a disk' } }, { status: 409 }));
    r = await libraryPOST(new Request('http://x', { method: 'POST' }), ctx('up-1'));
    expect(r.status).toBe(422); expect(await r.json()).toEqual({ error: 'refused', reason: 'not a disk' });
    U.getUpload.mockResolvedValueOnce(null);
    expect((await libraryPOST(new Request('http://x', { method: 'POST' }), ctx('up-1'))).status).toBe(404);
  });
});

describe('POST /api/uploads/<id>/send', () => {
  it("queues the stored bytes to one of the org's boards with the Amiga's name, protection and comment", async () => {
    U.getUpload.mockResolvedValue(stored());
    findSendTarget.mockResolvedValue({ id: 'dev-2' });
    queueTransferFromBlob.mockResolvedValue({ ok: true, id: 't1' });
    const r = await sendPOST(new Request('http://x', { method: 'POST', body: JSON.stringify({ deviceId: 'dev-2' }) }), ctx('up-1'));
    expect(r.status).toBe(201);
    expect(findSendTarget).toHaveBeenCalledWith(expect.anything(), 'org-1', 'dev-2');
    expect(queueTransferFromBlob).toHaveBeenCalledWith(expect.anything(), { orgId: 'org-1', deviceId: 'dev-2', userId: 'user-1',
      path: 'Games/Lemmings.adf', sha256: sha(ADF), protection: 0x40, comment: 'note' });
  });
  it('is 404 for a board that cannot take files', async () => {
    U.getUpload.mockResolvedValue(stored());
    findSendTarget.mockResolvedValue(null);
    const r = await sendPOST(new Request('http://x', { method: 'POST', body: JSON.stringify({ deviceId: 'dev-x' }) }), ctx('up-1'));
    expect(r.status).toBe(404);
  });
  it("is 404 and queues nothing for a board of another org (findSendTarget is asked with the session's org)", async () => {
    U.getUpload.mockResolvedValue(stored());
    findSendTarget.mockImplementation(async (_db: unknown, org: string, dev: string) => (org === 'org-2' && dev === 'dev-foreign' ? { id: dev } : null));
    const r = await sendPOST(new Request('http://x', { method: 'POST', body: JSON.stringify({ deviceId: 'dev-foreign' }) }), ctx('up-1'));
    expect(r.status).toBe(404);
    expect(findSendTarget).toHaveBeenCalledWith(expect.anything(), 'org-1', 'dev-foreign');
    expect(queueTransferFromBlob).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/uploads/<id> and POST /api/uploads/clear', () => {
  it('deletes one file of the org, 404 otherwise', async () => {
    U.deleteUpload.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await oneDELETE(new Request('http://x', { method: 'DELETE' }), ctx('up-1'))).status).toBe(204);
    expect((await oneDELETE(new Request('http://x', { method: 'DELETE' }), ctx('up-1'))).status).toBe(404);
    expect(U.deleteUpload).toHaveBeenCalledWith(expect.anything(), 'org-1', 'up-1');
  });
  it('only=receiving stops a receiving file, and answers 409 not_receiving once it finished (or 404)', async () => {
    U.stopUpload.mockResolvedValueOnce('stopped').mockResolvedValueOnce('not_receiving').mockResolvedValueOnce('not_found');
    const del = () => oneDELETE(new Request('http://x/api/uploads/up-1?only=receiving', { method: 'DELETE' }), ctx('up-1'));
    expect((await del()).status).toBe(204);
    const refused = await del();
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'not_receiving' });
    expect((await del()).status).toBe(404);
    expect(U.stopUpload).toHaveBeenCalledWith(expect.anything(), 'org-1', 'up-1');
    expect(U.deleteUpload).not.toHaveBeenCalled();
  });
  const CUR = '2026-10-20T10:00:00.000123Z';
  const post = (b: unknown) => clearPOST(new Request('http://x', { method: 'POST', body: JSON.stringify(b) }));
  it('clear passes the exact cursor the list gave and answers the count', async () => {
    U.clearUploads.mockResolvedValue(4);
    const r = await post({ cursor: CUR });
    expect(await r.json()).toEqual({ deleted: 4 });
    expect(U.clearUploads).toHaveBeenCalledWith(expect.anything(), 'org-1', CUR, null);
  });
  it('clear with a board passes it on, so only that board is cleared', async () => {
    U.clearUploads.mockResolvedValue(1);
    await post({ cursor: CUR, board: 'dev-1' });
    expect(U.clearUploads).toHaveBeenCalledWith(expect.anything(), 'org-1', CUR, 'dev-1');
  });
  it('clear answers 400 invalid for a missing, malformed or old-style cursor, never 500', async () => {
    for (const b of [{}, { cursor: 1_760_000_000_000 }, { cursor: '2026-10-20T10:00:00Z' }, { cursor: "x'; drop table t; --" },
      { cursor: CUR, board: '' }, { cursor: CUR, board: 5 }, null]) {
      const r = await post(b);
      expect(r.status).toBe(400); expect(await r.json()).toEqual({ error: 'invalid' });
    }
    expect((await clearPOST(new Request('http://x', { method: 'POST', body: 'not json' }))).status).toBe(400);
    expect(U.clearUploads).not.toHaveBeenCalled();
  });
});

describe('org scoping: a row id of another org is not found (getUpload is org-scoped and answers null)', () => {
  it('404 on file, library and send', async () => {
    U.getUpload.mockResolvedValue(null);
    expect((await fileGET(new Request('http://x'), ctx('other'))).status).toBe(404);
    expect((await libraryPOST(new Request('http://x', { method: 'POST' }), ctx('other'))).status).toBe(404);
    expect((await sendPOST(new Request('http://x', { method: 'POST', body: JSON.stringify({ deviceId: 'dev-2' }) }), ctx('other'))).status).toBe(404);
    for (const c of U.getUpload.mock.calls) expect(c[1]).toBe('org-1');
    expect(findSendTarget).not.toHaveBeenCalled();
  });
  it('send answers 400 for a body without a board', async () => {
    U.getUpload.mockResolvedValue(stored());
    expect((await sendPOST(new Request('http://x', { method: 'POST', body: '{}' }), ctx('up-1'))).status).toBe(400);
  });
});

describe('LIBRARY_EXT / libraryEligible', () => {
  it('is the browser upload set (DISK_IMAGE_PATTERN), so the two cannot drift', () => {
    expect(LIBRARY_EXT.source).toBe(DISK_IMAGE_PATTERN.source);
    expect(LIBRARY_EXT.flags).toBe(DISK_IMAGE_PATTERN.flags);
    for (const n of ['a.adf', 'A.ADF', 'a.dsk', 'a.adz', 'a.dms', 'a.dmz', 'a.hfe', 'x/y.Hfe']) expect(LIBRARY_EXT.test(n)).toBe(true);
    for (const n of ['a.lha', 'a.zip', 'adf', 'a.adf.txt', 'a.img']) expect(LIBRARY_EXT.test(n)).toBe(false);
  });
  it('offers library only within the sizes the library takes', () => {
    expect(libraryEligible('Games/A.adf', 901_120)).toBe(true);
    expect(libraryEligible('Games/A.adf', 0)).toBe(false);
    expect(libraryEligible('Games/A.adf', 2_621_441)).toBe(false);
    expect(libraryEligible('Games/A.dms', 3_000_000)).toBe(true);
    expect(libraryEligible('Games/A.dms', 4_194_305)).toBe(false);
    expect(libraryEligible('Games/A.txt', 10)).toBe(false);
  });
});
