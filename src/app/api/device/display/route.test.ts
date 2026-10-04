// GET /api/device/display: binary, for the board (plan Global Constraints):
// [u32 big-endian version][u8 panel][u8 has_layout][blob if has_layout].

import { describe, it, expect, vi, beforeEach } from 'vitest';

class DeviceAuthError extends Error {}
const requireDevice = vi.fn<(r: Request) => Promise<{ deviceId: string; orgId: string }>>();
vi.mock('@/lib/device-auth', () => ({
  requireDevice: (r: Request) => requireDevice(r),
  deviceAuthResponse: (e: unknown) => (e instanceof DeviceAuthError
    ? Response.json({ error: 'unauthorized' }, { status: 401 }) : null),
}));
type Row = { version: number; panel: string; layout: Uint8Array | null };
const readDisplay = vi.fn<(id: string) => Promise<Row | null>>();
vi.mock('@/lib/display-store', () => ({ readDisplay: (id: string) => readDisplay(id) }));

const get = () => new Request('http://test/api/device/display', { headers: { authorization: 'Bearer x' } });
const bytes = async (r: Response) => new Uint8Array(await r.arrayBuffer());

beforeEach(() => {
  vi.clearAllMocks();
  requireDevice.mockResolvedValue({ deviceId: 'dev-1', orgId: 'org-1' });
});

describe('GET /api/device/display', () => {
  it('sends version (u32 BE), panel id, has_layout=1 and the blob', async () => {
    readDisplay.mockResolvedValue({ version: 0x01020304, panel: '128x64', layout: new Uint8Array([1, 1, 0, 0]) });
    const { GET } = await import('./route');
    const res = await GET(get());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(Array.from(await bytes(res))).toEqual([1, 2, 3, 4, 1, 1, 1, 1, 0, 0]);
    expect(readDisplay).toHaveBeenCalledWith('dev-1');
  });

  it('a null layout (the panel default) sends has_layout=0 and no blob', async () => {
    readDisplay.mockResolvedValue({ version: 5, panel: '128x32', layout: null });
    const { GET } = await import('./route');
    expect(Array.from(await bytes(await GET(get())))).toEqual([0, 0, 0, 5, 0, 0]);
  });

  it('401 without a valid device token, uncacheable', async () => {
    requireDevice.mockRejectedValue(new DeviceAuthError());
    const { GET } = await import('./route');
    const res = await GET(get());
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('404 when the row vanished after auth', async () => {
    readDisplay.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(get())).status).toBe(404);
  });
});
