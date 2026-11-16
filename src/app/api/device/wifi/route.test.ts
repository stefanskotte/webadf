// GET /api/device/wifi: the instruction behind the poll's wifi.v, for the board (wifi_ctl.h).
import { describe, it, expect, vi, beforeEach } from 'vitest';

class DeviceAuthError extends Error {}
const requireDevice = vi.fn<(r: Request) => Promise<{ deviceId: string; orgId: string }>>();
vi.mock('@/lib/device-auth', () => ({
  requireDevice: (r: Request) => requireDevice(r),
  deviceAuthResponse: (e: unknown) => (e instanceof DeviceAuthError
    ? Response.json({ error: 'unauthorized' }, { status: 401 }) : null),
}));
type Row = { wifiSeq: number; wifiOp: string; wifiOpSsid: string | null; wifiOpAt: Date | null; wifiAck: number | null };
const readWifiRow = vi.fn<(id: string) => Promise<Row | null>>();
vi.mock('@/lib/wifi-networks-store', () => ({ readWifiRow: (id: string) => readWifiRow(id) }));

const get = () => new Request('http://test/api/device/wifi', { headers: { authorization: 'Bearer x' } });

beforeEach(() => {
  vi.clearAllMocks();
  requireDevice.mockResolvedValue({ deviceId: 'dev-1', orgId: 'org-1' });
});

describe('GET /api/device/wifi', () => {
  it('sends the seq and the op, uncacheable', async () => {
    readWifiRow.mockResolvedValue({ wifiSeq: 3, wifiOp: 'remove', wifiOpSsid: '486f6d65', wifiOpAt: new Date(), wifiAck: 2 });
    const { GET } = await import('./route');
    const res = await GET(get());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ seq: 3, op: 'remove', ssid: '486f6d65' });
    expect(readWifiRow).toHaveBeenCalledWith('dev-1');
  });
  it('sends none for a seq the board already reported', async () => {
    readWifiRow.mockResolvedValue({ wifiSeq: 3, wifiOp: 'open', wifiOpSsid: null, wifiOpAt: new Date(), wifiAck: 3 });
    const { GET } = await import('./route');
    expect(await (await GET(get())).json()).toEqual({ seq: 3, op: 'none' });
  });
  it('401 without a valid device token, uncacheable', async () => {
    requireDevice.mockRejectedValue(new DeviceAuthError());
    const { GET } = await import('./route');
    const res = await GET(get());
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
  it('404 when the row vanished after auth', async () => {
    readWifiRow.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(get())).status).toBe(404);
  });
});
