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
  sel1Wired?: boolean; df1Seen?: boolean;
  server?: { custom: boolean; tls: 'verify' | 'noverify' };
  mountedSha256?: string | null;
  i2c?: number[];
  lastBoot?: unknown; nfcFail?: string;
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
      mountedSha256: null, displayLayouts: 'yes', displayVersion: 4294967295, displayError: 42,
    }));
    expect(res.status).toBe(204);
    const s = recordStatus.mock.calls[0]![1];
    expect(s.displayLayouts).toBeUndefined();
    expect(s.displayVersion).toBeUndefined();
    expect(s.displayError).toBeUndefined();
  });

  it('truncates a displayError over 80 characters (never drops it, or a rejection reads as applied)', async () => {
    const { POST } = await import('./route');
    const res = await POST(post({
      mountedSha256: null, displayLayouts: true, displayVersion: 5, displayError: 'y'.repeat(81) + 'z',
    }));
    expect(res.status).toBe(204);
    const s = recordStatus.mock.calls[0]![1];
    expect(s.displayError).toBe('y'.repeat(80));
    expect(s.displayVersion).toBe(5);
  });
});

describe('POST /api/device/status -- DF1 telemetry', () => {
  it('passes sel1Wired and df1Seen through, and drops malformed values instead of rejecting', async () => {
    const { POST } = await import('./route');
    let res = await POST(post({ mountedSha256: null, sel1Wired: true, df1Seen: false }));
    expect(res.status).toBe(204);
    expect(recordStatus).toHaveBeenLastCalledWith('dev-1', expect.objectContaining({ sel1Wired: true, df1Seen: false }));
    res = await POST(post({ mountedSha256: null, sel1Wired: 'yes', df1Seen: 3 }));
    expect(res.status).toBe(204);
    expect(recordStatus).toHaveBeenLastCalledWith('dev-1', expect.objectContaining({ sel1Wired: undefined, df1Seen: undefined }));
  });
});

describe('POST /api/device/status -- DF1 setting', () => {
  it('passes secondDrive, driveVersion and df1Sha256 through, and drops malformed values', async () => {
    const { POST } = await import('./route');
    const sha = 'a'.repeat(64);
    let res = await POST(post({ mountedSha256: null, secondDrive: 'df1', driveVersion: 3, df1Sha256: sha }));
    expect(res.status).toBe(204);
    expect(recordStatus).toHaveBeenLastCalledWith('dev-1', expect.objectContaining({ secondDrive: 'df1', driveVersion: 3, df1Sha256: sha }));
    res = await POST(post({ mountedSha256: null, secondDrive: 'df2', driveVersion: -1, df1Sha256: 'zz' }));
    expect(res.status).toBe(204);
    expect(recordStatus).toHaveBeenLastCalledWith('dev-1', expect.objectContaining({ secondDrive: undefined, driveVersion: undefined, df1Sha256: undefined }));
  });
});

describe('POST /api/device/status -- Network mode (Phase 3)', () => {
  it('passes secondDrive net and the net tail through', async () => {
    const { POST } = await import('./route');
    const net = { driver: 4, amigaIp: '172.16.10.231', framesIn: 12, framesOut: 30 };
    const res = await POST(post({ mountedSha256: null, secondDrive: 'net', driveVersion: 2, net }));
    expect(res.status).toBe(204);
    expect(recordStatus).toHaveBeenLastCalledWith('dev-1', expect.objectContaining({ secondDrive: 'net', net }));
  });
  it('drops a malformed net field by field, never the report', async () => {
    const { POST } = await import('./route');
    const res = await POST(post({ mountedSha256: null, secondDrive: 'net',
      net: { driver: -1, amigaIp: '999.1.1.1x', framesIn: 1.5, framesOut: 7 } }));
    expect(res.status).toBe(204);
    expect(recordStatus).toHaveBeenLastCalledWith('dev-1', expect.objectContaining({
      net: { driver: undefined, amigaIp: undefined, framesIn: undefined, framesOut: 7 } }));
    await POST(post({ mountedSha256: null, net: 'garbage' }));
    expect(recordStatus).toHaveBeenLastCalledWith('dev-1', expect.objectContaining({ net: undefined }));
  });
});

// Board server override (fw 1.13.0): telemetry, dropped when malformed, never a 400.
describe('POST /api/device/status -- server', () => {
  it('passes server {custom, tls} through to recordStatus', async () => {
    const { POST } = await import('./route');
    const res = await POST(post({ mountedSha256: null, server: { custom: true, tls: 'noverify' } }));
    expect(res.status).toBe(204);
    expect(recordStatus.mock.calls[0]![1].server).toEqual({ custom: true, tls: 'noverify' });
  });

  it('drops a malformed server but still records mountedSha256', async () => {
    const { POST } = await import('./route');
    const res = await POST(post({ mountedSha256: SHA, server: { custom: 'yes', tls: 'verify' } }));
    expect(res.status).toBe(204);
    const s = recordStatus.mock.calls[0]![1];
    expect(s.server).toBeUndefined();
    expect(s.mountedSha256).toBe(SHA);
  });

  it('drops a server whose tls is not verify/noverify', async () => {
    const { POST } = await import('./route');
    const res = await POST(post({ mountedSha256: null, server: { custom: true, tls: 'off' } }));
    expect(res.status).toBe(204);
    expect(recordStatus.mock.calls[0]![1].server).toBeUndefined();
  });
});

// The boot I2C scan (fw 1.17.0): telemetry, validated strictly and dropped -- never a 400 -- when malformed.
describe('POST /api/device/status -- i2c', () => {
  it('passes the scan through, the empty list included', async () => {
    const { POST } = await import('./route');
    expect((await POST(post({ mountedSha256: null, i2c: [40, 60] }))).status).toBe(204);
    expect(recordStatus.mock.calls[0]![1].i2c).toEqual([40, 60]);
    await POST(post({ mountedSha256: null, i2c: [] }));
    expect(recordStatus.mock.calls[1]![1].i2c).toEqual([]);
  });
  it('is undefined when absent (older firmware)', async () => {
    const { POST } = await import('./route');
    await POST(post({ mountedSha256: null }));
    expect(recordStatus.mock.calls[0]![1].i2c).toBeUndefined();
  });
  it('drops a malformed scan whole but still records mountedSha256', async () => {
    const { POST } = await import('./route');
    for (const bad of [[7], [0x78], [40.5], ['40'], [8, 9, 10, 11, 12, 13, 14, 15, 16], '40,60', null, { a: 1 }]) {
      recordStatus.mockClear();
      const res = await POST(post({ mountedSha256: SHA, i2c: bad }));
      expect(res.status).toBe(204);
      const s = recordStatus.mock.calls[0]![1];
      expect(s.i2c).toBeUndefined();
      expect(s.mountedSha256).toBe(SHA);
    }
  });
});

// The boot trail and the newest tag failure (fw 1.18.2): telemetry, dropped -- never a 400 -- when malformed.
describe('POST /api/device/status -- lastBoot and nfcFail', () => {
  it('passes them through', async () => {
    const { POST } = await import('./route');
    const lastBoot = { reset: 'watchdog', c0: 'i2c', up0: 0, c1: 'wifi', up1: 0, upd: 'i2c' };
    expect((await POST(post({ mountedSha256: null, lastBoot, nfcFail: 'locked:0x14@A2' }))).status).toBe(204);
    expect(recordStatus.mock.calls[0]![1].lastBoot).toEqual(lastBoot);
    expect(recordStatus.mock.calls[0]![1].nfcFail).toBe('locked:0x14@A2');
  });
  it('drops malformed ones whole but still records mountedSha256', async () => {
    const { POST } = await import('./route');
    for (const [lastBoot, nfcFail] of [[{ reset: 'meltdown' }, 'x'.repeat(40)], ['watchdog', 7], [null, null],
      [{ reset: 'glitch', c0: 'warp' }, 'locked\n[device x] forged log line'], [7, 'LOCKED:0x14@A2']]) {
      recordStatus.mockClear();
      expect((await POST(post({ mountedSha256: SHA, lastBoot, nfcFail }))).status).toBe(204);
      const s = recordStatus.mock.calls[0]![1];
      expect(s.lastBoot).toBeUndefined();
      expect(s.nfcFail).toBeUndefined();
      expect(s.mountedSha256).toBe(SHA);
    }
  });
});
