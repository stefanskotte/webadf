// Route tests for POST /api/ingest/url: auth, org scoping, rate limiting and
// the refusal shape. The fetch/ingest pipeline itself is tested in
// src/lib/url-ingest.test.ts and src/lib/url-fetch.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const requireOrg = vi.fn();
vi.mock('@/lib/session', () => ({ requireOrg: () => requireOrg() }));

const ingestFromUrl = vi.fn();
vi.mock('@/lib/url-ingest', () => ({ ingestFromUrl: (...a: unknown[]) => ingestFromUrl(...a) }));

const takeUrlFetch = vi.fn();
vi.mock('@/lib/url-fetch-limit', () => ({ takeUrlFetch: (...a: unknown[]) => takeUrlFetch(...a) }));

const { POST } = await import('./route');

const call = (body: unknown) => POST(new Request('http://test/api/ingest/url', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
}));

beforeEach(() => {
  vi.clearAllMocks();
  requireOrg.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', email: 'a@b.test' });
  takeUrlFetch.mockReturnValue({ ok: true });
});

describe('POST /api/ingest/url', () => {
  it('fetches nothing without a session (requireOrg redirects)', async () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/sign-in;307;' });
    requireOrg.mockRejectedValue(redirect);
    await expect(call({ url: 'https://x.example/a.adf' })).rejects.toBe(redirect);
    expect(ingestFromUrl).not.toHaveBeenCalled();
    expect(takeUrlFetch).not.toHaveBeenCalled();
  });

  it('ingests into the session org, ignoring any org in the body', async () => {
    ingestFromUrl.mockResolvedValue({ ok: true, rows: [{ filename: 'a.adf', sizeBytes: 901120, sha256: 'a'.repeat(64), state: 'done' }] });
    const res = await call({ url: 'https://x.example/a.adf', orgId: 'org-EVIL' });
    expect(res.status).toBe(200);
    expect(ingestFromUrl).toHaveBeenCalledWith('org-1', 'https://x.example/a.adf');
    expect(takeUrlFetch).toHaveBeenCalledWith('user-1', 'org-1');
    expect((await res.json()).rows).toHaveLength(1);
  });

  it('400s a missing, non-string or malformed body without fetching', async () => {
    for (const b of [{}, { url: 42 }, { url: '' }, 'not json', { url: 'x'.repeat(3000) }]) {
      const res = await call(b);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_url' });
    }
    expect(ingestFromUrl).not.toHaveBeenCalled();
  });

  it('429s with retry-after when the limiter says no, without fetching', async () => {
    takeUrlFetch.mockReturnValue({ ok: false, retryAfterMs: 12_300 });
    const res = await call({ url: 'https://x.example/a.adf' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('13');
    expect(await res.json()).toEqual({ error: 'rate_limited', retryAfter: 13 });
    expect(ingestFromUrl).not.toHaveBeenCalled();
  });

  it.each([
    ['unsupported_scheme', 400], ['credentials_not_allowed', 400], ['port_not_allowed', 400],
    ['address_not_allowed', 400], ['invalid_url', 400], ['unreachable', 502], ['too_many_redirects', 502],
    ['too_large', 413], ['timeout', 504], ['not_a_disk_image', 422], ['no_disk_images', 422],
    ['too_many_images', 422], ['unsupported_archive', 422], ['store_busy', 503], ['ingest_failed', 500],
  ])('answers %s with %i and the code only', async (code, status) => {
    ingestFromUrl.mockResolvedValue({ ok: false, code });
    const res = await call({ url: 'https://x.example/a.adf' });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: code });
  });

  it('passes on only the status number of a public upstream refusal', async () => {
    ingestFromUrl.mockResolvedValue({ ok: false, code: 'upstream_status', status: 404 });
    const res = await call({ url: 'https://x.example/a.adf' });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream_status', status: 404 });
  });
});
