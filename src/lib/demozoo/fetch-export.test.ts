import { describe, it, expect, vi } from 'vitest';
import { fetchExport, EXPORT_URL, DEMOZOO_USER_AGENT } from './fetch-export';
import type { DemozooExportStore } from '@/lib/storage';

function fakeStore() {
  return { putStream: vi.fn(async () => {}), putBytes: vi.fn(async () => {}), readStream: vi.fn(async () => null) } satisfies DemozooExportStore;
}

describe('fetchExport — the only request to data.demozoo.org', () => {
  it('makes exactly one conditional request with our User-Agent, bounded by a 240 s timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetch = vi.fn(async () => new Response(null, { status: 304 }));
    const out = await fetchExport({ etag: '"abc"', lastModified: 'Mon, 14 Sep 2026 02:38:00 GMT' }, { fetch, store: fakeStore() });
    expect(out).toEqual({ status: 'unchanged' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(EXPORT_URL, {
      headers: {
        'user-agent': DEMOZOO_USER_AGENT,
        'if-none-match': '"abc"',
        'if-modified-since': 'Mon, 14 Sep 2026 02:38:00 GMT',
      },
      signal: expect.any(AbortSignal),
    });
    expect(timeout).toHaveBeenCalledWith(240_000);
    timeout.mockRestore();
  });

  it('streams a 200 into our store and returns the validators', async () => {
    const store = fakeStore();
    const fetch = vi.fn(async () => new Response('gz-bytes', { status: 200, headers: { etag: '"new"', 'last-modified': 'Sun, 20 Sep 2026 02:38:00 GMT' } }));
    const out = await fetchExport(null, { fetch, store });
    expect(out).toEqual({ status: 'stored', etag: '"new"', lastModified: 'Sun, 20 Sep 2026 02:38:00 GMT' });
    expect(store.putStream).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('throws on an error status and stores nothing', async () => {
    const store = fakeStore();
    const fetch = vi.fn(async () => new Response('nope', { status: 503 }));
    await expect(fetchExport(null, { fetch, store })).rejects.toThrow('503');
    expect(store.putStream).not.toHaveBeenCalled();
  });
});
