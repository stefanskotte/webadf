import { describe, it, expect, vi, beforeEach } from 'vitest';

const inserted: unknown[] = [];
let existing: Array<{ storageKey: string | null; failedAt: Date | null }> = [];
const put = vi.fn(async () => ({ key: 'oagd/x' }));

vi.mock('@/lib/storage', () => ({ imageStore: { put } }));
vi.mock('@/db', () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => existing }) }) }),
    insert: () => ({ values: (v: unknown) => { inserted.push(v); return { onConflictDoUpdate: async () => {} }; } }),
    delete: () => ({ where: async () => {} }),
  }),
}));

const { ensureDemozooImage, imageKeyFor } = await import('./images');
const shot = { id: 1, productionId: 89, standardUrl: 'https://media.demozoo.org/screens/s/9f.png', ordinal: 1 };
const noWait = async () => {};

beforeEach(() => { inserted.length = 0; existing = []; put.mockClear(); });

describe('ensureDemozooImage — politeness', () => {
  it('keys the image by sha1 of its URL, a 40-hex id the image route accepts', () => {
    expect(imageKeyFor(shot.standardUrl)).toMatch(/^[0-9a-f]{40}$/);
  });

  it('never re-fetches a stored image', async () => {
    existing = [{ storageKey: 'oagd/abc', failedAt: null }];
    const fetch = vi.fn();
    expect(await ensureDemozooImage(shot, { fetch, wait: noWait })).toEqual({ stored: false, bytes: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not retry a failure younger than 24 h', async () => {
    existing = [{ storageKey: null, failedAt: new Date() }];
    const fetch = vi.fn();
    await ensureDemozooImage(shot, { fetch, wait: noWait });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fetches once, with our User-Agent and a 30 s timeout, and stores the bytes', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }));
    const r = await ensureDemozooImage(shot, { fetch, wait: noWait });
    expect(r).toEqual({ stored: true, bytes: 3 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(shot.standardUrl, {
      headers: { 'user-agent': expect.stringContaining('webadf') }, signal: expect.any(AbortSignal),
    });
    expect(timeout).toHaveBeenCalledWith(30_000);
    timeout.mockRestore();
    expect(put).toHaveBeenCalledWith(imageKeyFor(shot.standardUrl), expect.any(Uint8Array), 'image/png');
  });

  it('records a timed-out request as a failure like any thrown fetch', async () => {
    const fetch = vi.fn(async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); });
    expect(await ensureDemozooImage(shot, { fetch, wait: noWait })).toEqual({ stored: false, bytes: 0 });
    expect(put).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(1);
    expect((inserted[0] as { failedAt: Date }).failedAt).toBeInstanceOf(Date);
  });

  it('never requests a URL outside media.demozoo.org, and records it as failed so it is not retried every run', async () => {
    const fetch = vi.fn();
    const wait = vi.fn(async () => {});
    for (const standardUrl of ['https://evil.example/x.png', 'http://media.demozoo.org/x.png', 'https://media.demozoo.org.evil.example/x.png']) {
      inserted.length = 0;
      expect(await ensureDemozooImage({ ...shot, standardUrl }, { fetch, wait })).toEqual({ stored: false, bytes: 0 });
      expect(inserted).toHaveLength(1);
      expect((inserted[0] as { failedAt: Date }).failedAt).toBeInstanceOf(Date);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it('does not store an SVG (served same-origin, it could carry script)', async () => {
    const fetch = vi.fn(async () => new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { headers: { 'content-type': 'image/svg+xml' } }));
    expect(await ensureDemozooImage(shot, { fetch, wait: noWait })).toEqual({ stored: false, bytes: 0 });
    expect(put).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(1);
  });

  it('accepts a raster type with parameters, storing the bare type', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'IMAGE/JPEG; charset=binary' } }));
    expect(await ensureDemozooImage(shot, { fetch, wait: noWait })).toEqual({ stored: true, bytes: 1 });
    expect(put).toHaveBeenCalledWith(imageKeyFor(shot.standardUrl), expect.any(Uint8Array), 'image/jpeg');
  });

  it('fetchWithinBudget stops at the rolling-hour budget and at the deadline', async () => {
    const { fetchWithinBudget } = await import('./images');
    const ensure = vi.fn(async () => ({ stored: true }));
    expect(await fetchWithinBudget([1, 2, 3, 4, 5], 3, () => false, ensure)).toEqual({ attempted: 3, stored: 3 });
    expect(ensure).toHaveBeenCalledTimes(3);
    ensure.mockClear();
    expect(await fetchWithinBudget([1, 2, 3], 10, () => true, ensure)).toEqual({ attempted: 0, stored: 0 });
    expect(ensure).not.toHaveBeenCalled();
  });

  it('fetchWithinBudget counts a throwing fetch against the budget', async () => {
    const { fetchWithinBudget } = await import('./images');
    const ensure = vi.fn(async () => { throw new Error('boom'); });
    expect(await fetchWithinBudget([1, 2, 3], 2, () => false, ensure)).toEqual({ attempted: 2, stored: 0 });
  });

  it('records a failed request instead of throwing', async () => {
    const fetch = vi.fn(async () => new Response('x', { status: 404 }));
    expect(await ensureDemozooImage(shot, { fetch, wait: noWait })).toEqual({ stored: false, bytes: 0 });
    expect(put).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(1);
  });

  it('counts a thrown fetch against the rolling-hour budget instead of propagating', async () => {
    const fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    expect(await ensureDemozooImage(shot, { fetch, wait: noWait })).toEqual({ stored: false, bytes: 0 });
    expect(put).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(1);
    expect((inserted[0] as { failedAt: Date }).failedAt).toBeInstanceOf(Date);
  });

  it('does not store a 200 response that is not an image', async () => {
    const fetch = vi.fn(async () => new Response('<html>error</html>', { headers: { 'content-type': 'text/html' } }));
    expect(await ensureDemozooImage(shot, { fetch, wait: noWait })).toEqual({ stored: false, bytes: 0 });
    expect(put).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(1);
  });

  it('does not store a response with no content-type at all', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    expect(await ensureDemozooImage(shot, { fetch, wait: noWait })).toEqual({ stored: false, bytes: 0 });
    expect(put).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(1);
  });
});
