import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/session', () => ({
  requireOrg: () => Promise.resolve({ orgId: 'org-1', userId: 'user-1', email: 'a@b.test' }),
}));
type Out = { seq: number } | 'not_found' | 'firmware_too_old' | 'not_saved' | 'in_use' | 'only_one' | 'nothing_to_cancel';
const requestWifi = vi.fn<(o: string, i: string, a: string, s: string | null) => Promise<Out>>();
vi.mock('@/lib/wifi-networks-store', () => ({
  requestWifi: (o: string, i: string, a: string, s: string | null) => requestWifi(o, i, a, s),
}));

const req = (body: unknown) => new Request('http://test/api/devices/dev-1/wifi', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => { vi.clearAllMocks(); });

describe('POST /api/devices/[id]/wifi', () => {
  it('asks the board to open its setup page, and answers the new cursor', async () => {
    const { POST } = await import('./route');
    requestWifi.mockResolvedValue({ seq: 5 });
    const res = await POST(req({ action: 'open' }), ctx('dev-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ seq: 5 });
    expect(requestWifi).toHaveBeenCalledWith('org-1', 'dev-1', 'open', null);
  });
  it('removes a network named in the board\'s hex', async () => {
    const { POST } = await import('./route');
    requestWifi.mockResolvedValue({ seq: 6 });
    expect((await POST(req({ action: 'remove', ssid: '486f6d65' }), ctx('dev-1'))).status).toBe(200);
    expect(requestWifi).toHaveBeenCalledWith('org-1', 'dev-1', 'remove', '486f6d65');
  });
  it('takes close and cancel, with no name', async () => {
    const { POST } = await import('./route');
    requestWifi.mockResolvedValue({ seq: 7 });
    await POST(req({ action: 'close' }), ctx('dev-1'));
    await POST(req({ action: 'cancel', ssid: '41' }), ctx('dev-1'));
    expect(requestWifi).toHaveBeenNthCalledWith(1, 'org-1', 'dev-1', 'close', null);
    expect(requestWifi).toHaveBeenNthCalledWith(2, 'org-1', 'dev-1', 'cancel', null);
  });
  it('refuses a remove with no name, a bad name, an unknown action, a password, and bad JSON', async () => {
    const { POST } = await import('./route');
    expect((await POST(req({ action: 'remove' }), ctx('dev-1'))).status).toBe(400);
    expect((await POST(req({ action: 'remove', ssid: 'Home' }), ctx('dev-1'))).status).toBe(400);
    expect((await POST(req({ action: 'remove', ssid: '4100' }), ctx('dev-1'))).status).toBe(400);
    expect((await POST(req({ action: 'add', ssid: '41', pass: 'secret' }), ctx('dev-1'))).status).toBe(400);
    const bad = new Request('http://test/x', { method: 'POST', body: '{' });
    expect((await POST(bad, ctx('dev-1'))).status).toBe(400);
    expect(requestWifi).not.toHaveBeenCalled();
  });
  it('says why a request is refused', async () => {
    const { POST } = await import('./route');
    for (const [why, words] of [
      ['firmware_too_old', /Update the firmware/],
      ['in_use', /on that network now/],
      ['only_one', /only saved network/],
      ['not_saved', /does not have that network/],
      ['nothing_to_cancel', /already handled/],
    ] as const) {
      requestWifi.mockResolvedValue(why);
      const res = await POST(req({ action: 'remove', ssid: '41' }), ctx('dev-1'));
      expect(res.status).toBe(409);
      const j = await res.json() as { error: string; reason: string };
      expect(j.error).toBe(why);
      expect(j.reason).toMatch(words);
    }
  });
  it('404s an unknown device', async () => {
    const { POST } = await import('./route');
    requestWifi.mockResolvedValue('not_found');
    expect((await POST(req({ action: 'open' }), ctx('nope'))).status).toBe(404);
  });
});
