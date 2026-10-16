// Route tests for the board's send routes (PaulaNET Phase 4, spec 2026-10-16 §3-4): the queue text, file chunks
// (offset = progress), and the outcome.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/device-auth', () => ({
  requireDevice: async () => ({ deviceId: 'd1', orgId: 'o1' }),
  deviceAuthResponse: () => null,
}));
vi.mock('@/db', () => ({ getDb: () => ({}) }));
const sendQueueText = vi.fn<(db: unknown, deviceId: string) => Promise<string>>();
const recordChunk = vi.fn();
const finishTransfer = vi.fn();
vi.mock('@/lib/transfers', () => ({
  SEND_CHUNK_MAX: 16_384,
  sendQueueText: (db: unknown, id: string) => sendQueueText(db, id),
  recordChunk: (...a: unknown[]) => recordChunk(...a),
  finishTransfer: (...a: unknown[]) => finishTransfer(...a),
}));
const readRange = vi.fn();
vi.mock('@/lib/storage', () => ({ diskStore: { readRange: (...a: unknown[]) => readRange(...a) } }));

const { GET: queueGET } = await import('./queue/route');
const { GET: chunkGET } = await import('./[id]/route');
const { POST: donePOST } = await import('./[id]/done/route');
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const bytes = async (r: Response) => new Uint8Array(await r.arrayBuffer());

beforeEach(() => { vi.clearAllMocks(); });

describe('GET /api/device/send/queue', () => {
  it('answers the queue text as Latin-1 bytes, uncached', async () => {
    sendQueueText.mockResolvedValue('NEXT -\nLIST 1\nab 3 8:Café.txt\n');
    const r = await queueGET(new Request('http://x/api/device/send/queue'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/plain; charset=iso-8859-1');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const b = await bytes(r);
    expect(b.includes(0xe9)).toBe(true);
    expect(b.length).toBe(Buffer.byteLength('NEXT -\nLIST 1\nab 3 8:Café.txt\n', 'latin1'));
    // The board reads to content-length; production would otherwise stream it chunked.
    expect(r.headers.get('content-length')).toBe(String(b.length));
    expect(sendQueueText).toHaveBeenCalledWith(expect.anything(), 'd1');
  });
});

describe('GET /api/device/send/<id>', () => {
  const file = new Uint8Array(20_000).map((_, i) => i & 0xff);
  beforeEach(() => {
    recordChunk.mockResolvedValue({ ok: true, sha256: 'a'.repeat(64), sizeBytes: 20_000 });
    readRange.mockImplementation(async (_s: string, o: number, n: number) => file.slice(o, o + n));
  });
  const get = (qs: string) => chunkGET(new Request(`http://x/api/device/send/t1?${qs}`), params('t1'));
  it('returns the chunk and records the offset as progress', async () => {
    const r = await get('offset=0&length=16384');
    expect(r.status).toBe(200);
    expect((await bytes(r)).length).toBe(16_384);
    // The board takes a chunk only when content-length is exactly the length it asked for (1.14.0 bench: without
    // it, production streamed the body chunked and every file failed "chunk -1").
    expect(r.headers.get('content-length')).toBe('16384');
    expect(recordChunk).toHaveBeenCalledWith(expect.anything(), 'd1', 't1', 0);
  });
  it('clamps the last chunk to the file', async () => {
    const r = await get('offset=16384&length=16384');
    expect(r.headers.get('content-length')).toBe(String(20_000 - 16_384));
    expect([...(await bytes(r))]).toEqual([...file.slice(16_384)]);
  });
  it('refuses bad ranges', async () => {
    for (const qs of ['offset=0&length=16385', 'offset=-1&length=10', 'offset=0&length=0', 'length=10'])
      expect((await get(qs)).status, qs).toBe(400);
    recordChunk.mockResolvedValueOnce({ ok: false, status: 400 });   // an offset past the end, judged by recordChunk
    expect((await get('offset=20000&length=10')).status).toBe(400);
  });
  it('answers 409 for a row no longer active and 404 for another board', async () => {
    recordChunk.mockResolvedValueOnce({ ok: false, status: 409 });
    expect((await get('offset=0&length=10')).status).toBe(409);
    recordChunk.mockResolvedValueOnce({ ok: false, status: 404 });
    expect((await get('offset=0&length=10')).status).toBe(404);
  });
});

describe('POST /api/device/send/<id>/done', () => {
  const post = (body: unknown) => donePOST(new Request('http://x/api/device/send/t1/done', { method: 'POST', body: JSON.stringify(body) }), params('t1'));
  it('records a delivery', async () => {
    finishTransfer.mockResolvedValue(true);
    expect((await post({ ok: true, savedAs: 'Café.txt' })).status).toBe(204);
    expect(finishTransfer).toHaveBeenCalledWith(expect.anything(), 'd1', 't1', { ok: true, savedAs: 'Café.txt' });
  });
  it('records a failure', async () => {
    finishTransfer.mockResolvedValue(true);
    expect((await post({ ok: false, code: 'space', text: 'not enough space' })).status).toBe(204);
  });
  it('refuses a bad body, and says 409 when already finished', async () => {
    expect((await post({})).status).toBe(400);
    finishTransfer.mockResolvedValue(false);
    expect((await post({ ok: true, savedAs: 'x' })).status).toBe(409);
  });
});
