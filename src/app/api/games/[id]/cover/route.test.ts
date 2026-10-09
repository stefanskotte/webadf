import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/lib/session', () => ({
  requireOrg: () => Promise.resolve({ orgId: 'org-1', userId: 'user-1', email: 'a@b.test' }),
}));
const getCoverOverride = vi.fn();
const setCoverOverride = vi.fn();
vi.mock('@/lib/cover-override', () => ({
  getCoverOverride: (...a: unknown[]) => getCoverOverride(...a),
  setCoverOverride: (...a: unknown[]) => setCoverOverride(...a),
}));
const put = vi.fn(async () => ({ key: 'cover/x' }));
const read = vi.fn();
vi.mock('@/lib/storage', () => ({ coverStore: { put: (...a: unknown[]) => put(...(a as [])), read: (...a: unknown[]) => read(...a) } }));

const { PUT, DELETE } = await import('./route');
const { GET } = await import('./[sha256]/route');

const PNG = new Uint8Array(readFileSync(join(__dirname, '../../../../../lib/__fixtures__/cover/cover.png')));
const PNG_SHA = createHash('sha256').update(PNG).digest('hex');
const ctx = { params: Promise.resolve({ id: 'G' }) };
const putReq = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request('http://x/api/games/G/cover', { method: 'PUT', body, headers });

beforeEach(() => {
  getCoverOverride.mockReset(); setCoverOverride.mockReset(); put.mockClear(); read.mockReset();
});

describe('PUT /api/games/[id]/cover', () => {
  it('stores a valid image under its digest, with the type its bytes declare, and names it on the title', async () => {
    getCoverOverride.mockResolvedValue({ sha256: null });
    setCoverOverride.mockResolvedValue(true);
    // The browser claims text/plain; the bytes are a PNG, and the PNG wins.
    const res = await PUT(putReq(PNG, { 'content-type': 'text/plain' }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      url: `/api/games/G/cover/${PNG_SHA}`, type: 'image/png', width: 40, height: 50,
    });
    expect(put).toHaveBeenCalledWith(PNG_SHA, expect.any(Uint8Array), 'image/png');
    expect(setCoverOverride).toHaveBeenCalledWith('org-1', 'G', PNG_SHA);
  });

  it('strips Exif GPS before storing, and the digest is of the stored bytes', async () => {
    getCoverOverride.mockResolvedValue({ sha256: null });
    setCoverOverride.mockResolvedValue(true);
    const gps = Buffer.from('Exif\0\0GPSLATITUDE');
    const seg = Buffer.concat([Buffer.from([0xff, 0xe1, 0, gps.length + 2]), gps]);
    const jpg = new Uint8Array(readFileSync(join(__dirname, '../../../../../lib/__fixtures__/cover/cover.jpg')));
    const dirty = Buffer.concat([Buffer.from(jpg.subarray(0, 2)), seg, Buffer.from(jpg.subarray(2))]);
    const res = await PUT(putReq(dirty), ctx);
    expect(res.status).toBe(200);
    const [sha, stored] = put.mock.calls[0] as unknown as [string, Uint8Array, string];
    expect(Buffer.from(stored).includes(Buffer.from('GPSLATITUDE'))).toBe(false);
    expect(sha).toBe(createHash('sha256').update(stored).digest('hex'));
    expect(setCoverOverride).toHaveBeenCalledWith('org-1', 'G', sha);
  });

  it('a title that is not this org\'s is 404, and nothing is stored', async () => {
    getCoverOverride.mockResolvedValue(undefined);
    const res = await PUT(putReq(PNG), ctx);
    expect(res.status).toBe(404);
    expect(getCoverOverride).toHaveBeenCalledWith('org-1', 'G');
    expect(put).not.toHaveBeenCalled();
    expect(setCoverOverride).not.toHaveBeenCalled();
  });

  it('a body that is not an image is 415 and is never stored', async () => {
    getCoverOverride.mockResolvedValue({ sha256: null });
    const res = await PUT(putReq('<svg xmlns="http://www.w3.org/2000/svg"/>', { 'content-type': 'image/png' }), ctx);
    expect(res.status).toBe(415);
    expect((await res.json()).error).toBe('not_an_image');
    expect(put).not.toHaveBeenCalled();
  });

  it('an empty body is refused', async () => {
    getCoverOverride.mockResolvedValue({ sha256: null });
    const res = await PUT(putReq(null), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('empty');
  });

  it('a declared length over 2 MB is 413 before anything else', async () => {
    const res = await PUT(putReq(PNG, { 'content-length': String(3 * 1024 * 1024) }), ctx);
    expect(res.status).toBe(413);
    expect(getCoverOverride).not.toHaveBeenCalled();
  });

  it('a body over 2 MB with no honest length is cut off at the cap: 413', async () => {
    getCoverOverride.mockResolvedValue({ sha256: null });
    const big = new Uint8Array(2 * 1024 * 1024 + 10);
    big.set(PNG);
    const stream = new ReadableStream<Uint8Array>({
      start(c) { for (let i = 0; i < big.length; i += 65536) c.enqueue(big.slice(i, i + 65536)); c.close(); },
    });
    const req = new Request('http://x/api/games/G/cover', {
      method: 'PUT', body: stream, duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const res = await PUT(req, ctx);
    expect(res.status).toBe(413);
    expect(put).not.toHaveBeenCalled();
  });

  it('a title deleted between the check and the write is 404', async () => {
    getCoverOverride.mockResolvedValue({ sha256: null });
    setCoverOverride.mockResolvedValue(false);
    expect((await PUT(putReq(PNG), ctx)).status).toBe(404);
  });
});

describe('DELETE /api/games/[id]/cover (Revert to default)', () => {
  it('clears the override for this org\'s title: 204', async () => {
    setCoverOverride.mockResolvedValue(true);
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), ctx);
    expect(res.status).toBe(204);
    expect(setCoverOverride).toHaveBeenCalledWith('org-1', 'G', null);
  });
  it('another org\'s title is 404', async () => {
    setCoverOverride.mockResolvedValue(false);
    expect((await DELETE(new Request('http://x', { method: 'DELETE' }), ctx)).status).toBe(404);
  });
});

describe('GET /api/games/[id]/cover/[sha256]', () => {
  const getCtx = (sha256: string) => ({ params: Promise.resolve({ id: 'G', sha256 }) });

  it('streams the title\'s current cover, private and immutable, with nosniff', async () => {
    getCoverOverride.mockResolvedValue({ sha256: PNG_SHA });
    read.mockResolvedValue({ bytes: PNG, contentType: 'image/png' });
    const res = await GET(new Request('http://x'), getCtx(PNG_SHA));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect(getCoverOverride).toHaveBeenCalledWith('org-1', 'G');
  });

  it('another org\'s title is 404 even with the right digest', async () => {
    getCoverOverride.mockResolvedValue(undefined);
    const res = await GET(new Request('http://x'), getCtx(PNG_SHA));
    expect(res.status).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });

  it('a digest the title does not name now (an old cover, or after Revert) is 404', async () => {
    getCoverOverride.mockResolvedValue({ sha256: 'c'.repeat(64) });
    expect((await GET(new Request('http://x'), getCtx(PNG_SHA))).status).toBe(404);
    getCoverOverride.mockResolvedValue({ sha256: null });
    expect((await GET(new Request('http://x'), getCtx(PNG_SHA))).status).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });

  it('a malformed digest is 400 and never reaches the store', async () => {
    const res = await GET(new Request('http://x'), getCtx('../adf/' + 'a'.repeat(58)));
    expect(res.status).toBe(400);
    expect(getCoverOverride).not.toHaveBeenCalled();
  });

  it('a missing object is 404', async () => {
    getCoverOverride.mockResolvedValue({ sha256: PNG_SHA });
    read.mockResolvedValue(null);
    expect((await GET(new Request('http://x'), getCtx(PNG_SHA))).status).toBe(404);
  });
});
