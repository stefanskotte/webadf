import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/session', () => ({
  requireOrg: () => Promise.resolve({ orgId: 'org-1', userId: 'user-1', email: 'a@b.test' }),
}));
const deleteDevice = vi.fn<(o: string, i: string) => Promise<boolean>>();
vi.mock('@/lib/device-delete', () => ({ deleteDevice: (o: string, i: string) => deleteDevice(o, i) }));
vi.mock('@/lib/device-name', () => ({ renameDevice: vi.fn() }));

const req = () => new Request('http://test/api/devices/dev-1', { method: 'DELETE' });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => { vi.clearAllMocks(); });

describe('DELETE /api/devices/[id]', () => {
  it('deletes a device in the caller org', async () => {
    const { DELETE } = await import('./route');
    deleteDevice.mockResolvedValue(true);
    const res = await DELETE(req(), ctx('dev-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(deleteDevice).toHaveBeenCalledWith('org-1', 'dev-1');
  });

  it('scopes by the session org, never by anything in the request', async () => {
    const { DELETE } = await import('./route');
    deleteDevice.mockResolvedValue(true);
    await DELETE(new Request('http://test/api/devices/dev-1?orgId=org-2', { method: 'DELETE' }), ctx('dev-1'));
    expect(deleteDevice).toHaveBeenCalledWith('org-1', 'dev-1');
  });

  it('404s a foreign or unknown device with the same body', async () => {
    const { DELETE } = await import('./route');
    deleteDevice.mockResolvedValue(false);
    const foreign = await DELETE(req(), ctx('other-orgs-device'));
    const unknown = await DELETE(req(), ctx('nope'));
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await foreign.json()).toEqual(await unknown.json());
  });
});
