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
const tapNext = vi.fn<
  (deviceId: string, orgId: string, now: Date) => Promise<{ outcome: TapOutcome; diskNo?: number; diskCount?: number }>
>(async () => ({ outcome: 'mounting', diskNo: 2, diskCount: 3 }));
vi.mock('@/lib/nfc/store', () => ({ tapDevice, tapNext }));
const noteBoot = vi.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);
vi.mock('@/lib/boot-disk-store', () => ({ noteBoot: (...a: unknown[]) => noteBoot(...a) }));

const ID = 'a1b2c3d4-e5f6-5a7b-8c9d-0e1f2a3b4c5d';
const post = (body: unknown, qs = '') => new Request(`http://test/api/device/tap${qs}`, {
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

describe('POST /api/device/tap {action:"next"}', () => {
  it('advances through the store with the token org', async () => {
    const { POST } = await import('./route');
    const res = await POST(post({ action: 'next', orgId: 'org-EVIL' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: 'mounting', diskNo: 2, diskCount: 3 });
    expect(tapNext).toHaveBeenCalledWith('dev-1', 'org-1', expect.any(Date));
    expect(tapDevice).not.toHaveBeenCalled();
  });
  it('answers single and nothing_mounted as 200 outcomes', async () => {
    const { POST } = await import('./route');
    tapNext.mockResolvedValueOnce({ outcome: 'single' });
    expect(await (await POST(post({ action: 'next' }))).json()).toEqual({ outcome: 'single' });
    tapNext.mockResolvedValueOnce({ outcome: 'nothing_mounted' });
    expect(await (await POST(post({ action: 'next' }))).json()).toEqual({ outcome: 'nothing_mounted' });
  });
  it.each([{ action: 'prev' }, { action: 'next', diskId: ID }])('refuses %j with 400', async (body) => {
    const { POST } = await import('./route');
    expect((await POST(post(body))).status).toBe(400);
    expect(tapNext).not.toHaveBeenCalled();
  });
});

// Disk at startup (2026-10-19): a tag tapped at the Kickstart screen reaches the server before the boot's first
// poll, so the tap names the boot too -- and the boot is decided FIRST, or "No disk" would empty the tapped disk.
describe('POST /api/device/tap -- the boot', () => {
  it('decides the boot before the tap mounts', async () => {
    const order: string[] = [];
    noteBoot.mockImplementation(async () => { order.push('boot'); });
    tapDevice.mockImplementation(async () => { order.push('tap'); return { outcome: 'mounting' }; });
    const { POST } = await import('./route');
    expect((await POST(post({ diskId: ID }, '?boot=1a2b3c4d'))).status).toBe(200);
    expect(noteBoot).toHaveBeenCalledWith('dev-1', { id: '1a2b3c4d', ota: false });
    expect(order).toEqual(['boot', 'tap']);
  });
  it('for Next disk as well, and not at all without a boot', async () => {
    const { POST } = await import('./route');
    await POST(post({ action: 'next' }, '?boot=deadbeef&ota=1'));
    expect(noteBoot).toHaveBeenCalledWith('dev-1', { id: 'deadbeef', ota: true });
    noteBoot.mockClear();
    await POST(post({ diskId: ID }));
    expect(noteBoot).not.toHaveBeenCalled();
  });
});
