// The board's upload routes (spec 2026-10-18 §4): open, chunk, close. The library is mocked; its db tests are Task 12's.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/device-auth', () => ({
  requireDevice: async () => ({ deviceId: 'd1', orgId: 'o1' }),
  deviceAuthResponse: () => null,
}));
vi.mock('@/db', () => ({ getDb: () => ({}) }));
const openUpload = vi.fn();
const storeChunk = vi.fn();
const closeUpload = vi.fn();
vi.mock('@/lib/amiga-uploads', () => ({
  openUpload: (...a: unknown[]) => openUpload(...a), storeChunk: (...a: unknown[]) => storeChunk(...a),
  closeUpload: (...a: unknown[]) => closeUpload(...a),
}));
const placeFetched = vi.fn(async (...args: unknown[]) => { void args; });
vi.mock('@/lib/files/net-fetch', () => ({ placeFetched: (...a: unknown[]) => placeFetched(...a) }));
const recordSendRx = vi.fn(async (...args: unknown[]) => { void args; });
vi.mock('@/lib/transfers', () => ({ recordSendRx: (...a: unknown[]) => recordSendRx(...a) }));

const { POST: openPOST } = await import('./route');
const { POST: chunkPOST } = await import('./[id]/route');
const { POST: closePOST } = await import('./[id]/close/route');
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const json = (path: string, body: unknown) => new Request(`http://x${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const OPEN = { size: 5, date: '1.2.3', protection: 0, path: 'Café.txt', comment: '' };

beforeEach(() => { vi.clearAllMocks(); });

describe('POST /api/device/upload', () => {
  it('opens for the token\'s board and org, never the body\'s, and answers id and offset', async () => {
    openUpload.mockResolvedValue({ ok: true, id: 'u1', offset: 16384 });
    const r = await openPOST(json('/api/device/upload', { ...OPEN, orgId: 'evil' }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: 'u1', offset: 16384 });
    expect(openUpload).toHaveBeenCalledWith(expect.anything(), { deviceId: 'd1', orgId: 'o1' },
      { size: 5, date: '1.2.3', protection: 0, path: 'Café.txt', comment: '' });
  });
  it('passes a Latin-1 path and comment the board escaped as \\u00XX through once, undecoded again', async () => {
    openUpload.mockResolvedValue({ ok: true, id: 'u1', offset: 0 });
    // The firmware's as_json_escape writes 0xE9 as the six characters \u00e9.
    const raw = '{"size":5,"date":"1.2.3","protection":0,"path":"Caf\\u00e9.txt","comment":"na\\u00efve \\\\u00e9"}';
    const r = await openPOST(new Request('http://x/api/device/upload', { method: 'POST', body: raw }));
    expect(r.status).toBe(200);
    const a = openUpload.mock.calls[0][2] as { path: string; comment: string };
    expect(a.path).toBe('Caf\u00e9.txt');
    expect(a.path).toBe('Café.txt');
    expect(a.comment).toBe('na\u00efve \\u00e9');                  // an escaped backslash stays literal text
  });
  it('passes a fetched file\'s request (NET: volumes §4.5) on, and refuses a malformed one', async () => {
    openUpload.mockResolvedValue({ ok: true, id: 'u1', offset: 0 });
    expect((await openPOST(json('/api/device/upload', { ...OPEN, request: 'Ab_9-x' }))).status).toBe(200);
    expect(openUpload.mock.calls[0][2]).toMatchObject({ request: 'Ab_9-x' });
    expect((await openPOST(json('/api/device/upload', { ...OPEN, request: 'a b' }))).status).toBe(400);
  });
  it('maps refusals to their codes and statuses', async () => {
    for (const [code, status] of [['size', 413], ['full', 409], ['name', 400]] as const) {
      openUpload.mockResolvedValueOnce({ ok: false, code });
      const r = await openPOST(json('/api/device/upload', OPEN));
      expect(r.status).toBe(status);
      expect(await r.json()).toEqual({ code });
    }
  });
  it('refuses a malformed body with code server, before the library', async () => {
    for (const b of [{ ...OPEN, size: -1 }, { ...OPEN, date: 'yesterday' }, { ...OPEN, path: '' }, 'not json']) {
      const r = await openPOST(typeof b === 'string'
        ? new Request('http://x/api/device/upload', { method: 'POST', body: b }) : json('/api/device/upload', b));
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ code: 'server' });
    }
    expect(openUpload).not.toHaveBeenCalled();
  });
});

describe('POST /api/device/upload/<id>', () => {
  const post = (qs: string, body: Uint8Array) => chunkPOST(new Request(`http://x/api/device/upload/u1?${qs}`,
    { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: body as BodyInit }), params('u1'));
  it('stores the chunk at the offset, answers received, and keeps the receiver reading as running', async () => {
    storeChunk.mockResolvedValue({ ok: true, received: 16384 });
    const r = await post('offset=0', new Uint8Array(16384).fill(7));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ received: 16384 });
    const [, dev, id, off, data] = storeChunk.mock.calls[0];
    expect([dev, id, off, (data as Uint8Array).byteLength]).toEqual(['d1', 'u1', 0, 16384]);
    expect(recordSendRx).toHaveBeenCalledWith(expect.anything(), 'd1', 'c');
  });
  it('answers a gap with 409 and the stored count, a gone upload with 404, a bad request with 400', async () => {
    storeChunk.mockResolvedValueOnce({ ok: false, status: 409, received: 16384 });
    let r = await post('offset=32768', new Uint8Array(10));
    expect(r.status).toBe(409); expect(await r.json()).toEqual({ received: 16384 });
    storeChunk.mockResolvedValueOnce({ ok: false, status: 404 });
    r = await post('offset=0', new Uint8Array(10));
    expect(r.status).toBe(404); expect(await r.json()).toEqual({ code: 'gone' });
    r = await post('offset=x', new Uint8Array(10));
    expect(r.status).toBe(400);
    r = await post('offset=0', new Uint8Array(16385));
    expect(r.status).toBe(400);                                  // over 16 KB: refused before the library
    r = await post('offset=0', new Uint8Array(0));
    expect(r.status).toBe(400);
    expect(storeChunk).toHaveBeenCalledTimes(2);
  });
});

describe('POST /api/device/upload/<id>/close', () => {
  it('answers the stored name, or the refusal', async () => {
    closeUpload.mockResolvedValueOnce({ ok: true, name: 'Café.txt' });
    let r = await closePOST(json('/api/device/upload/u1/close', { crc32: 907060870 }), params('u1'));
    expect(r.status).toBe(200); expect(await r.json()).toEqual({ name: 'Café.txt' });
    expect(closeUpload).toHaveBeenCalledWith(expect.anything(), 'd1', 'u1', 907060870);
    // A stored close places the file a Files copy fetched (a no-op for a Transfer send); a refused one does not.
    expect(placeFetched).toHaveBeenCalledTimes(1);
    expect(placeFetched).toHaveBeenCalledWith(expect.anything(), 'u1');
    closeUpload.mockResolvedValueOnce({ ok: false, status: 409, code: 'crc' });
    r = await closePOST(json('/api/device/upload/u1/close', { crc32: 1 }), params('u1'));
    expect(r.status).toBe(409); expect(await r.json()).toEqual({ code: 'crc' });
    expect(placeFetched).toHaveBeenCalledTimes(1);
    r = await closePOST(json('/api/device/upload/u1/close', { crc32: -1 }), params('u1'));
    expect(r.status).toBe(400);
  });
  it('answers 404 gone when the row was deleted or expired mid-close, and 409 gone for a failed one', async () => {
    closeUpload.mockResolvedValueOnce({ ok: false, status: 404, code: 'gone' });
    let r = await closePOST(json('/api/device/upload/u1/close', { crc32: 5 }), params('u1'));
    expect(r.status).toBe(404); expect(await r.json()).toEqual({ code: 'gone' });
    closeUpload.mockResolvedValueOnce({ ok: false, status: 409, code: 'gone' });
    r = await closePOST(json('/api/device/upload/u1/close', { crc32: 5 }), params('u1'));
    expect(r.status).toBe(409); expect(await r.json()).toEqual({ code: 'gone' });
  });
});
