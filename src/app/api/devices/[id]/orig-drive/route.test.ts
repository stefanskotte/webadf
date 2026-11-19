import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/session', () => ({
  requireOrg: () => Promise.resolve({ orgId: 'org-1', userId: 'user-1', email: 'a@b.test' }),
}));
type Saved = { version: number } | 'not_found' | 'not_capable';
const saveOrigDrive = vi.fn<(o: string, i: string, m: string) => Promise<Saved>>();
vi.mock('@/lib/orig-drive-store', () => ({
  saveOrigDrive: (o: string, i: string, m: string) => saveOrigDrive(o, i, m),
}));

const req = (body: unknown) => new Request('http://test/api/devices/dev-1/orig-drive', {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => { vi.clearAllMocks(); });

describe('PATCH /api/devices/[id]/orig-drive', () => {
  it('saves Auto or Off for this org', async () => {
    const { PATCH } = await import('./route');
    saveOrigDrive.mockResolvedValue({ version: 2 });
    const res = await PATCH(req({ mode: 'off' }), ctx('dev-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 2 });
    expect(saveOrigDrive).toHaveBeenCalledWith('org-1', 'dev-1', 'off');
  });
  it('refuses a board without the expander, and says why', async () => {
    const { PATCH } = await import('./route');
    saveOrigDrive.mockResolvedValue('not_capable');
    const res = await PATCH(req({ mode: 'auto' }), ctx('dev-1'));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_capable', reason: 'This board has no original drive connector' });
  });
  it('404s a board that is not this org\'s', async () => {
    const { PATCH } = await import('./route');
    saveOrigDrive.mockResolvedValue('not_found');
    expect((await PATCH(req({ mode: 'auto' }), ctx('dev-x'))).status).toBe(404);
  });
  it('rejects anything but auto or off', async () => {
    const { PATCH } = await import('./route');
    for (const mode of ['on', 'df0', 1, null]) {
      expect((await PATCH(req({ mode }), ctx('dev-1'))).status).toBe(400);
    }
    expect(saveOrigDrive).not.toHaveBeenCalled();
  });
});
