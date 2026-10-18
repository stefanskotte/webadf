import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { formatVolume } from '@/lib/adffs/format';
import { addFile, makeDirectory, readVolume } from '@/lib/adffs';

vi.mock('@/lib/session', () => ({ requireOrg: () => Promise.resolve({ orgId: 'org-1', userId: 'user-1', email: 'a@b.test' }) }));
vi.mock('@/db', () => ({ getDb: () => ({}) }));
const store = new Map<string, Uint8Array>();
vi.mock('@/lib/storage', () => ({ diskStore: {
  stat: async (s: string) => (store.has(s) ? { sizeBytes: store.get(s)!.byteLength } : null),
  put: async (s: string, b: Uint8Array) => { store.set(s, b); return { key: `adf/${s}` }; },
  read: async (s: string) => { const b = store.get(s); if (!b) throw new Error('missing'); return b; },
} }));
const findSendTarget = vi.fn();
const loadSendDisk = vi.fn();
vi.mock('@/lib/send-targets', () => ({
  findSendTarget: (...a: unknown[]) => findSendTarget(...a), loadSendDisk: (...a: unknown[]) => loadSendDisk(...a),
}));
const queueTransferFromBlob = vi.fn();
const cancelTransfer = vi.fn();
const retryTransfer = vi.fn();
const queueLoad = vi.fn();
const listTransfers = vi.fn();
const clearFinishedTransfers = vi.fn();
vi.mock('@/lib/transfers', () => ({
  queueTransferFromBlob: (...a: unknown[]) => queueTransferFromBlob(...a), cancelTransfer: (...a: unknown[]) => cancelTransfer(...a),
  retryTransfer: (...a: unknown[]) => retryTransfer(...a), queueLoad: (...a: unknown[]) => queueLoad(...a),
  listTransfers: (...a: unknown[]) => listTransfers(...a), clearFinishedTransfers: (...a: unknown[]) => clearFinishedTransfers(...a),
  cleanAmigaPath: (p: string) => realCleanAmigaPath(p),
}));
const { cleanAmigaPath: realCleanAmigaPath } = await vi.importActual<typeof import('@/lib/transfers')>('@/lib/transfers');

const TARGET = { id: 'dev-1', name: 'Bench', macAddress: null, defaultName: false, online: true, lastSeenAt: 1, network: true, rx: 'c', rxAt: 1 };
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
let n = 0;
beforeEach(() => {
  vi.clearAllMocks(); store.clear(); n = 0;
  findSendTarget.mockImplementation(async (_db, _org, id) => (id === 'dev-1' ? TARGET : null));
  queueTransferFromBlob.mockImplementation(async () => ({ ok: true, id: `t${++n}` }));
  queueLoad.mockResolvedValue({ files: 0, bytes: 0 });
});

describe('POST /api/transfers (a file from the computer)', () => {
  const post = (qs: string, body: Uint8Array) =>
    new Request(`http://test/api/transfers${qs}`, { method: 'POST', body: body as unknown as BodyInit });

  it('stores the bytes by sha-256 and queues them for the board, under the session org', async () => {
    const { POST } = await import('./route');
    const res = await POST(post('?deviceId=dev-1&name=Caf%C3%A9.lha', new Uint8Array([1, 2, 3])));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ids: ['t1'] });
    const sha = createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex');
    expect(store.has(sha)).toBe(true);
    expect(queueTransferFromBlob).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ orgId: 'org-1', deviceId: 'dev-1', userId: 'user-1', path: 'Café.lha', sha256: sha }));
  });
  it('refuses a board that cannot take files: another org\'s, or old firmware (Review Focus 1)', async () => {
    const { POST } = await import('./route');
    const res = await POST(post('?deviceId=old-board&name=a', new Uint8Array([1])));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no_device' });
    expect(queueTransferFromBlob).not.toHaveBeenCalled();
  });
  it('refuses an empty file, and one over 4 MB, without storing either', async () => {
    const { POST } = await import('./route');
    expect((await POST(post('?deviceId=dev-1&name=a', new Uint8Array(0)))).status).toBe(400);
    const big = await POST(post('?deviceId=dev-1&name=a', new Uint8Array(4_194_305)));
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: 'too_large' });
    expect(store.size).toBe(0);
    expect(queueTransferFromBlob).not.toHaveBeenCalled();
  });
  it('stops reading a streamed body with no content-length once it passes 4 MB, and stores nothing', async () => {
    const { POST } = await import('./route');
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) { if (pulled >= 64) { c.close(); return; } pulled++; c.enqueue(new Uint8Array(1_048_576)); },
    });
    const req = new Request('http://test/api/transfers?deviceId=dev-1&name=a', {
      method: 'POST', body, duplex: 'half' } as RequestInit & { duplex: 'half' });
    expect(req.headers.get('content-length')).toBeNull();
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'too_large' });
    expect(pulled).toBeLessThan(10);
    expect(store.size).toBe(0);
    expect(queueTransferFromBlob).not.toHaveBeenCalled();
  });
  it('passes a full queue and a bad name through as their own answers', async () => {
    const { POST } = await import('./route');
    queueTransferFromBlob.mockResolvedValueOnce({ ok: false, reason: 'queue_full' });
    expect((await POST(post('?deviceId=dev-1&name=a', new Uint8Array([1])))).status).toBe(409);
    queueTransferFromBlob.mockResolvedValueOnce({ ok: false, reason: 'bad_name' });
    expect((await POST(post('?deviceId=dev-1&name=..', new Uint8Array([1])))).status).toBe(400);
  });
});

describe('GET /api/transfers', () => {
  it('returns the board, its rows as views, and the server clock; an expired-in-waiting row reads expired', async () => {
    const { GET } = await import('./route');
    const now = Date.now();
    listTransfers.mockResolvedValue([{ id: 't1', path: 'A', sizeBytes: 5, status: 'queued', bytesSent: 0, savedAs: null,
      errorCode: null, errorText: null, createdAt: new Date(now - 90_000_000), finishedAt: null, expiresAt: new Date(now - 1) }]);
    const res = await GET(new Request('http://test/api/transfers?deviceId=dev-1'));
    const body = await res.json();
    expect(body.target.id).toBe('dev-1');
    expect(body.transfers[0]).toMatchObject({ id: 't1', status: 'expired', createdAt: now - 90_000_000 });
    expect(listTransfers).toHaveBeenCalledWith(expect.anything(), 'org-1', 'dev-1');
  });
  it('404s a board that is not a target', async () => {
    const { GET } = await import('./route');
    expect((await GET(new Request('http://test/api/transfers?deviceId=nope'))).status).toBe(404);
  });
});

describe('DELETE /api/transfers (Clear finished)', () => {
  const del = (qs: string) => new Request(`http://test/api/transfers${qs}`, { method: 'DELETE' });
  it('deletes the board\'s finished rows under the session org and says how many', async () => {
    clearFinishedTransfers.mockResolvedValue(49);
    const { DELETE } = await import('./route');
    const res = await DELETE(del('?deviceId=dev-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 49 });
    expect(findSendTarget).toHaveBeenCalledWith(expect.anything(), 'org-1', 'dev-1', expect.any(Number));
    expect(clearFinishedTransfers).toHaveBeenCalledWith(expect.anything(), 'org-1', 'dev-1', expect.any(Date));
  });
  it('400s without a deviceId', async () => {
    const { DELETE } = await import('./route');
    const res = await DELETE(del(''));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_query' });
    expect(clearFinishedTransfers).not.toHaveBeenCalled();
  });
  it('404s an unknown board or another org\'s, and deletes nothing', async () => {
    const { DELETE } = await import('./route');
    const res = await DELETE(del('?deviceId=other-org-board'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no_device' });
    expect(clearFinishedTransfers).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/transfers/[id] and retry', () => {
  it('cancels a waiting or moving row; a finished one is 409 "not_waiting" (Review Focus 2)', async () => {
    const { DELETE } = await import('./[id]/route');
    cancelTransfer.mockResolvedValueOnce(true);
    expect((await DELETE(new Request('http://test', { method: 'DELETE' }), ctx('t1'))).status).toBe(200);
    expect(cancelTransfer).toHaveBeenCalledWith(expect.anything(), 'org-1', 't1');
    cancelTransfer.mockResolvedValueOnce(false);
    const late = await DELETE(new Request('http://test', { method: 'DELETE' }), ctx('t1'));
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ error: 'not_waiting' });
  });
  it('retries into a new row, and says why when it cannot', async () => {
    const { POST } = await import('./[id]/retry/route');
    retryTransfer.mockResolvedValueOnce({ ok: true, id: 't9' });
    const ok = await POST(new Request('http://test', { method: 'POST' }), ctx('t1'));
    expect(ok.status).toBe(201);
    expect(await ok.json()).toEqual({ ids: ['t9'] });
    retryTransfer.mockResolvedValueOnce({ ok: false, reason: 'not_finished' });
    expect((await POST(new Request('http://test', { method: 'POST' }), ctx('t1'))).status).toBe(409);
    retryTransfer.mockResolvedValueOnce({ ok: false, reason: 'not_found' });
    expect((await POST(new Request('http://test', { method: 'POST' }), ctx('t1'))).status).toBe(404);
    retryTransfer.mockResolvedValueOnce({ ok: false, reason: 'no_blob' });
    expect((await POST(new Request('http://test', { method: 'POST' }), ctx('t1'))).status).toBe(410);
  });
});

describe('POST /api/transfers/from-disk', () => {
  // A real FFS disk: mods/a.txt (protection s, 0x40) and top.txt.
  function disk() {
    let adf = formatVolume({ filesystem: 'FFS', volumeName: 'SendTest' });
    const mk = makeDirectory(adf, 880, 'mods'); if (!mk.ok) throw new Error(mk.reason); adf = mk.adf;
    const vol = readVolume(adf); if (!vol.ok) throw new Error('no volume');
    const mods = vol.root.find((e) => e.name === 'mods')!.block;
    const a = addFile(adf, mods, 'a.txt', new TextEncoder().encode('hello'), 0x40); if (!a.ok) throw new Error(a.reason); adf = a.adf;
    const b = addFile(adf, 880, 'top.txt', new TextEncoder().encode('top')); if (!b.ok) throw new Error(b.reason); adf = b.adf;
    const sha = createHash('sha256').update(adf).digest('hex');
    store.set(sha, adf);
    loadSendDisk.mockResolvedValue({ sha256: sha, imageFormat: 'adf', tosecName: null, sourceFilename: 'SendTest.dms', diskNo: 1 });
    return { sha, mods };
  }
  const post = (body: unknown) => new Request('http://test/api/transfers/from-disk', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('queues every file of a folder with its relative path, protection and its own blob (R4, R5)', async () => {
    const { mods } = disk();
    const { POST } = await import('./from-disk/route');
    const res = await POST(post({ deviceId: 'dev-1', diskId: 'k1', blocks: [mods] }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ids: ['t1'] });
    const call = queueTransferFromBlob.mock.calls[0][1];
    expect(call).toMatchObject({ path: 'mods/a.txt', protection: 0x40, comment: '' });
    expect(store.get(call.sha256)).toEqual(new TextEncoder().encode('hello'));
  });
  it('sends the whole disk as <name>.adf on the disk\'s own blob', async () => {
    const { sha } = disk();
    const { POST } = await import('./from-disk/route');
    expect((await POST(post({ deviceId: 'dev-1', diskId: 'k1', whole: true }))).status).toBe(201);
    expect(queueTransferFromBlob.mock.calls[0][1]).toMatchObject({ path: 'SendTest.adf', sha256: sha });
  });
  it('refuses the lot when it would overflow the board\'s queue, and queues nothing (Review Focus 3)', async () => {
    disk();
    queueLoad.mockResolvedValue({ files: 31, bytes: 0 });
    const { POST } = await import('./from-disk/route');
    const vol = readVolume(store.values().next().value!); if (!vol.ok) throw new Error('x');
    const res = await POST(post({ deviceId: 'dev-1', diskId: 'k1', blocks: vol.root.map((e) => e.block) }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'queue_full' });
    expect(queueTransferFromBlob).not.toHaveBeenCalled();
  });
  it('refuses the lot when one picked path is too long for the Amiga, and queues nothing (final review m1)', async () => {
    let { sha } = disk();
    let adf = store.get(sha)!;
    let parent = 880;
    for (let i = 0; i < 9; i++) {
      const mk = makeDirectory(adf, parent, `Folder${i}`.padEnd(30, 'x')); if (!mk.ok) throw new Error(mk.reason); adf = mk.adf;
      const v = readVolume(adf); if (!v.ok) throw new Error('no volume');
      let dir = v.root;
      let found = 0;
      for (let j = 0; j <= i; j++) { const e = dir.find((x) => x.name === `Folder${j}`.padEnd(30, 'x'))!; found = e.block; dir = e.children ?? []; }
      parent = found;
    }
    const f = addFile(adf, parent, 'deep.txt', new TextEncoder().encode('deep')); if (!f.ok) throw new Error(f.reason); adf = f.adf;
    sha = createHash('sha256').update(adf).digest('hex');
    store.set(sha, adf);
    loadSendDisk.mockResolvedValue({ sha256: sha, imageFormat: 'adf', tosecName: null, sourceFilename: 'SendTest.dms', diskNo: 1 });
    const vol = readVolume(adf); if (!vol.ok) throw new Error('x');
    const { POST } = await import('./from-disk/route');
    const res = await POST(post({ deviceId: 'dev-1', diskId: 'k1', blocks: vol.root.map((e) => e.block) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'bad_name' });
    expect(queueTransferFromBlob).not.toHaveBeenCalled();
  });
  it('refuses an HFE sent whole, an unknown disk, and a block that is not on the disk', async () => {
    disk();
    const { POST } = await import('./from-disk/route');
    loadSendDisk.mockResolvedValueOnce({ sha256: 'x', imageFormat: 'hfe', tosecName: null, sourceFilename: null, diskNo: 1 });
    expect((await POST(post({ deviceId: 'dev-1', diskId: 'k1', whole: true }))).status).toBe(400);
    loadSendDisk.mockResolvedValueOnce(null);
    expect((await POST(post({ deviceId: 'dev-1', diskId: 'nope', whole: true }))).status).toBe(404);
    expect((await POST(post({ deviceId: 'dev-1', diskId: 'k1', blocks: [999] }))).status).toBe(404);
    expect((await POST(post({ deviceId: 'old-board', diskId: 'k1', whole: true }))).status).toBe(404);
    expect((await POST(post({ deviceId: 'dev-1', diskId: 'k1' }))).status).toBe(400);
  });
});

describe('toView', () => {
  const row = (status: string, expiresAt: Date) => ({ id: 't1', path: 'A', sizeBytes: 5, status, bytesSent: 0, savedAs: null,
    errorCode: null, errorText: null, createdAt: new Date(1000), finishedAt: null, expiresAt }) as never;
  it('reads a queued or sending row past its expiry as expired, and one not yet due as itself', async () => {
    const { toView } = await import('@/lib/send-http');
    expect(toView(row('queued', new Date(500)), 1000).status).toBe('expired');
    expect(toView(row('sending', new Date(500)), 1000).status).toBe('expired');
    expect(toView(row('queued', new Date(2000)), 1000).status).toBe('queued');
    expect(toView(row('sending', new Date(2000)), 1000).status).toBe('sending');
    expect(toView(row('delivered', new Date(500)), 1000).status).toBe('delivered');
  });
});

describe('the upload routes share one store step', () => {
  it('stores the sha-256 of exactly the bytes it queues, for a file and for a disk file alike', async () => {
    const { storeSendBytes } = await import('@/lib/send-http');
    const sha = await storeSendBytes(new Uint8Array([9, 9]));
    expect(sha).toBe(createHash('sha256').update(new Uint8Array([9, 9])).digest('hex'));
    expect(store.get(sha)).toEqual(new Uint8Array([9, 9]));
  });
});
