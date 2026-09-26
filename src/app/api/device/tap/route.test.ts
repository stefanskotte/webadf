import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TapOutcome } from '@/lib/nfc/rules';

const requireDevice = vi.fn<(r: Request) => Promise<{ deviceId: string; orgId: string }>>(
  async () => ({ deviceId: 'dev-1', orgId: 'org-1' }),
);
vi.mock('@/lib/device-auth', () => ({
  requireDevice: (r: Request) => requireDevice(r),
  deviceAuthResponse: () => null,
}));
const tapDevice = vi.fn<
  (deviceId: string, orgId: string, diskId: string, now: Date) => Promise<{ outcome: TapOutcome; title?: string }>
>(async () => ({ outcome: 'mounting', title: 'Turrican II' }));
vi.mock('@/lib/nfc/store', () => ({ tapDevice }));

const ID = 'a1b2c3d4-e5f6-5a7b-8c9d-0e1f2a3b4c5d';
const post = (body: unknown) => new Request('http://test/api/device/tap', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(() => vi.clearAllMocks());

describe('POST /api/device/tap', () => {
  it('passes the token org, never a body org, to the store', async () => {
    const { POST } = await import('./route');
    const res = await POST(post({ diskId: ID, orgId: 'org-EVIL' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: 'mounting', title: 'Turrican II' });
    expect(tapDevice).toHaveBeenCalledWith('dev-1', 'org-1', ID, expect.any(Date));
  });
  it.each([{}, { diskId: 'nope' }, { diskId: ID.toUpperCase() }, null])(
    'refuses a malformed body %j with 400 before the store', async (body) => {
      const { POST } = await import('./route');
      expect((await POST(post(body))).status).toBe(400);
      expect(tapDevice).not.toHaveBeenCalled();
    });
  it('answers not_found as a 200 outcome, never a 404', async () => {
    tapDevice.mockResolvedValueOnce({ outcome: 'not_found' });
    const { POST } = await import('./route');
    const res = await POST(post({ diskId: ID }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: 'not_found' });
  });
});
