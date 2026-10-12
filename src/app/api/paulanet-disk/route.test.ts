// GET /api/paulanet-disk: the driver disk for a person. Final review m6: the URL carries no digest, so a rebuilt
// disk must never be served stale from a year-long immutable cache -- revalidated on its ETag (the digest).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PAULANET_DISK_SHA256 } from '@/lib/paulanet-disk';

const requireOrg = vi.fn(async () => ({ orgId: 'org-1' }));
vi.mock('@/lib/session', () => ({ requireOrg: () => requireOrg() }));
const read = vi.fn<(sha: string) => Promise<Uint8Array>>();
vi.mock('@/lib/storage', () => ({ diskStore: { read: (sha: string) => read(sha) } }));

const call = async (headers: Record<string, string> = {}) => {
  const { GET } = await import('./route');
  return GET(new Request('http://test/api/paulanet-disk', { headers }));
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
});
