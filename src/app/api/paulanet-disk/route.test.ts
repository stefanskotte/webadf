// GET /api/paulanet-disk: the driver disk for a person. Final review m6: the URL carries no digest, so a rebuilt
// disk must never be served stale from a year-long immutable cache -- revalidated on its ETag (the digest).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PAULANET_DISK_PREVIOUS, PAULANET_DISK_SHA256 } from '@/lib/paulanet-disk';

const requireOrg = vi.fn(async () => ({ orgId: 'org-1' }));
vi.mock('@/lib/session', () => ({ requireOrg: () => requireOrg() }));
const read = vi.fn<(sha: string) => Promise<Uint8Array>>();
vi.mock('@/lib/storage', () => ({ diskStore: { read: (sha: string) => read(sha) } }));

const call = async (headers: Record<string, string> = {}, qs = '') => {
  const { GET } = await import('./route');
  return GET(new Request(`http://test/api/paulanet-disk${qs}`, { headers }));
};

beforeEach(() => {
  vi.clearAllMocks();
  read.mockResolvedValue(new Uint8Array(901_120));
});

describe('GET /api/paulanet-disk', () => {
  it('is revalidated on every use, never cached as immutable, with the digest as its ETag', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).toBe('private, no-cache');
    expect(cc).not.toContain('immutable');
    expect(res.headers.get('etag')).toBe(`"${PAULANET_DISK_SHA256}"`);
    expect((await res.arrayBuffer()).byteLength).toBe(901_120);
  });

  it('answers 304 without reading the store when the browser already holds this digest', async () => {
    const res = await call({ 'if-none-match': `"${PAULANET_DISK_SHA256}"` });
    expect(res.status).toBe(304);
    expect(res.headers.get('etag')).toBe(`"${PAULANET_DISK_SHA256}"`);
    expect(read).not.toHaveBeenCalled();
  });

  it('serves the disk when the browser holds an older one', async () => {
    const res = await call({ 'if-none-match': `"${'0'.repeat(64)}"` });
    expect(res.status).toBe(200);
    expect(read).toHaveBeenCalledWith(PAULANET_DISK_SHA256);
  });

  it('serves the older driver disk by its digest (R16), with that digest as its ETag; the default stays the new one', async () => {
    const res = await call({}, `?sha256=${PAULANET_DISK_PREVIOUS}`);
    expect(res.status).toBe(200);
    expect(read).toHaveBeenCalledWith(PAULANET_DISK_PREVIOUS);
    expect(res.headers.get('etag')).toBe(`"${PAULANET_DISK_PREVIOUS}"`);
    expect((await call({ 'if-none-match': `"${PAULANET_DISK_PREVIOUS}"` }, `?sha256=${PAULANET_DISK_PREVIOUS}`)).status).toBe(304);
    // The old ETag no longer matches the default (new) disk: a browser holding the old one gets the new one.
    expect((await call({ 'if-none-match': `"${PAULANET_DISK_PREVIOUS}"` })).status).toBe(200);
    expect(read).toHaveBeenLastCalledWith(PAULANET_DISK_SHA256);
  });

  it('answers 404 for any other digest, without reading the store', async () => {
    for (const sha of ['a'.repeat(64), 'nope', PAULANET_DISK_SHA256.toUpperCase()]) {
      const res = await call({}, `?sha256=${sha}`);
      expect(res.status).toBe(404);
    }
    expect(read).not.toHaveBeenCalled();
  });
});
