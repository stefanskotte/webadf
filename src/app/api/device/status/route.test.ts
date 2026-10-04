import { describe, it, expect, vi, beforeEach } from 'vitest';

const requireDevice = vi.fn<(r: Request) => Promise<{ deviceId: string; orgId: string }>>(
  async () => ({ deviceId: 'dev-1', orgId: 'org-1' }),
);
vi.mock('@/lib/device-auth', () => ({
  requireDevice: (r: Request) => requireDevice(r),
  deviceAuthResponse: () => null,
}));

type RecordStatusArg = {
  preload?: { sha256: string; state: 'loading' | 'ready' } | null;
  displayLayouts?: boolean; displayVersion?: number; displayError?: string | null;
};
const recordStatus = vi.fn<(deviceId: string, s: RecordStatusArg) => Promise<void>>(
  async () => undefined,
);
vi.mock('@/lib/mount', () => ({
  recordStatus: (deviceId: string, s: RecordStatusArg) => recordStatus(deviceId, s),
}));

const SHA = 'a'.repeat(64);
const post = (body: unknown) => new Request('http://test/api/device/status', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(() => vi.clearAllMocks());

// Task 7 (multi-disk spec §3.5): the board's idle-slot preload is telemetry,
// like trackMaxBytes/playsHd -- dropped when malformed, never a 400 (the same
// rule the comment above updateProtocol in route.ts states for the other
// four fields).
describe('POST /api/device/status -- preload', () => {
  it('passes preload {sha256, state} through to recordStatus', async () => {
    const { POST } = await import('./route');
    const res = await POST(post({ mountedSha256: null, preload: { sha256: SHA, state: 'ready' } }));
    expect(res.status).toBe(204);
    expect(recordStatus).toHaveBeenCalledTimes(1);
    const call = recordStatus.mock.calls[0]!;
    expect(call[0]).toBe('dev-1');
    expect(call[1].preload).toEqual({ sha256: SHA, state: 'ready' });
  });

  it('passes preload: null through to recordStatus', async () => {
    const { POST } = await import('./route');
    const res = await POST(post({ mountedSha256: null, preload: null }));
    expect(res.status).toBe(204);
    expect(recordStatus.mock.calls[0]![1].preload).toBeNull();
  });

  it('drops a malformed preload silently -- never a 400 -- and reports preload: undefined', async () => {
    const { POST } = await import('./route');
    const res = await POST(post({ mountedSha256: null, preload: { sha256: 'x' } }));
    expect(res.status).toBe(204);
    expect(recordStatus).toHaveBeenCalledTimes(1);
    expect(recordStatus.mock.calls[0]![1].preload).toBeUndefined();
  });
});

// OLED layouts spec §7: capability, the board's ack, and its rejection reason.
describe('POST /api/device/status -- display', () => {
  it('passes displayLayouts, displayVersion and displayError through', async () => {
    const { POST } = await import('./route');
    const res = await POST(post({
      mountedSha256: null, displayLayouts: true, displayVersion: 4, displayError: 'title: w below 12',
    }));
    expect(res.status).toBe(204);
    const s = recordStatus.mock.calls[0]![1];
    expect(s).toMatchObject({ displayLayouts: true, displayVersion: 4, displayError: 'title: w below 12' });
  });

  it('passes displayError: null (applied) through as null', async () => {
    const { POST } = await import('./route');
    await POST(post({ mountedSha256: null, displayLayouts: true, displayVersion: 4, displayError: null }));
    expect(recordStatus.mock.calls[0]![1].displayError).toBeNull();
  });

  it('drops malformed display telemetry -- never a 400', async () => {
    const { POST } = await import('./route');
    const res = await POST(post({
      mountedSha256: null, displayLayouts: 'yes', displayVersion: 4294967295, displayError: 'x'.repeat(81),
    }));
    expect(res.status).toBe(204);
    const s = recordStatus.mock.calls[0]![1];
    expect(s.displayLayouts).toBeUndefined();
    expect(s.displayVersion).toBeUndefined();
    expect(s.displayError).toBeUndefined();
  });
});
