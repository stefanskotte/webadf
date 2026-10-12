// GET /api/device/image/net/<sha256> (pre-flight I3): the driver disk for a board's SLOT_NET, as a DD WFAD,
// without an entitlement -- and nothing else from this route.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PAULANET_DISK_SHA256 } from '@/lib/paulanet-disk';
import { ADF_BYTES } from '@/lib/adfmfm';

class FakeAuthError extends Error {}
const requireDevice = vi.fn<(r: Request) => Promise<{ deviceId: string; orgId: string }>>();
vi.mock('@/lib/device-auth', () => ({
  requireDevice: (r: Request) => requireDevice(r),
  deviceAuthResponse: (e: unknown) =>
    e instanceof FakeAuthError ? Response.json({ error: 'unauthorized' }, { status: 401 }) : null,
}));
const read = vi.fn<(sha: string) => Promise<Uint8Array>>();
vi.mock('@/lib/storage', () => ({ diskStore: { read: (sha: string) => read(sha) } }));
// The route must never look at entitlements or disks: any database access here fails the test.
vi.mock('@/db', () => ({ getDb: () => { throw new Error('the net route must not touch the database'); } }));

const call = async (sha: string) => {
  const { GET } = await import('./route');
  return GET(new Request(`http://test/api/device/image/net/${sha}`), { params: Promise.resolve({ sha256: sha }) });
};

beforeEach(() => {
  vi.clearAllMocks();
  requireDevice.mockResolvedValue({ deviceId: 'dev-1', orgId: 'org-1' });
});

describe('GET /api/device/image/net/<sha256>', () => {
  it('serves the driver disk as a DD WFAD (11 sectors), with no entitlement', async () => {
    const adf = new Uint8Array(ADF_BYTES).map((_, i) => (i * 7) & 0xff);
    read.mockResolvedValue(adf);
    const res = await call(PAULANET_DISK_SHA256);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(16 + ADF_BYTES));
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = new Uint8Array(await res.arrayBuffer());
    expect([...body.slice(0, 16)]).toEqual([0x57, 0x46, 0x41, 0x44, 1, 0, 0, 0, 0xa0, 0, 0, 0, 0x0b, 0, 0, 0]);
    expect(body.slice(16)).toEqual(adf);
    expect(read).toHaveBeenCalledWith(PAULANET_DISK_SHA256);
  });

  it('is 404 for any other digest, well-formed or not, and never reads the store', async () => {
    for (const sha of ['a'.repeat(64), 'nope', PAULANET_DISK_SHA256.toUpperCase()]) {
      const res = await call(sha);
      expect(res.status).toBe(404);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('needs the device to authenticate, like the library route', async () => {
    requireDevice.mockRejectedValue(new FakeAuthError());
    const res = await call(PAULANET_DISK_SHA256);
    expect(res.status).toBe(401);
    expect(read).not.toHaveBeenCalled();
  });

  it('is 503 when the store cannot be read, 422 when the object is not a DD ADF', async () => {
    read.mockRejectedValueOnce(new Error('down'));
    expect((await call(PAULANET_DISK_SHA256)).status).toBe(503);
    read.mockResolvedValueOnce(new Uint8Array(ADF_BYTES - 1));
    expect((await call(PAULANET_DISK_SHA256)).status).toBe(422);
  });
});
