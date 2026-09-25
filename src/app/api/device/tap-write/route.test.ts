import { describe, it, expect, vi, beforeEach } from 'vitest';

const requireDevice = vi.fn<(r: Request) => Promise<{ deviceId: string; orgId: string }>>(
  async () => ({ deviceId: 'dev-1', orgId: 'org-1' }),
);
vi.mock('@/lib/device-auth', () => ({
  requireDevice: (r: Request) => requireDevice(r),
  deviceAuthResponse: () => null,
}));
const storeWriteResult = vi.fn<
  (deviceId: string, r: { seq: number; ok: boolean; uid: string; reason?: string }) => Promise<boolean>
>(async () => true);
vi.mock('@/lib/nfc/store', () => ({ storeWriteResult }));

const post = (body: unknown) => new Request('http://test/api/device/tap-write', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(() => vi.clearAllMocks());

describe('POST /api/device/tap-write', () => {
  it('stores a valid result and passes the token device id, never a body one', async () => {
    const { POST } = await import('./route');
    const res = await POST(post({ seq: 3, ok: true, uid: '24:19:b6:01' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stored: true });
    expect(storeWriteResult).toHaveBeenCalledWith('dev-1', { seq: 3, ok: true, uid: '24:19:b6:01' });
  });

  it('answers stored: false when the store declines it', async () => {
    storeWriteResult.mockResolvedValueOnce(false);
    const { POST } = await import('./route');
    const res = await POST(post({ seq: 3, ok: true, uid: '24:19:b6:01' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stored: false });
  });

  it.each([
    { seq: -1, ok: true, uid: '24:19:b6:01' },
    { seq: 3, uid: '24:19:b6:01' },
    { seq: 3, ok: true, uid: 'x'.repeat(33) },
    { seq: 3, ok: true, uid: '24:19:b6:01', reason: 'x'.repeat(65) },
  ])('refuses a malformed body %j with 400 before the store', async (body) => {
    const { POST } = await import('./route');
    expect((await POST(post(body))).status).toBe(400);
    expect(storeWriteResult).not.toHaveBeenCalled();
  });
});
