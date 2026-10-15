import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/session', () => ({
  requireOrg: () => Promise.resolve({ orgId: 'org-1', userId: 'user-1', email: 'a@b.test' }),
}));
type Saved = { version: number } | 'not_found' | 'firmware_too_old' | 'df1_seen';
const saveSecondDrive = vi.fn<(o: string, i: string, m: string, ov: boolean) => Promise<Saved>>();
vi.mock('@/lib/second-drive-store', () => ({
  saveSecondDrive: (o: string, i: string, m: string, ov: boolean) => saveSecondDrive(o, i, m, ov),
}));

const req = (body: unknown) => new Request('http://test/api/devices/dev-1/second-drive', {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => { vi.clearAllMocks(); });

describe('PATCH /api/devices/[id]/second-drive', () => {
  it('refuses DF1 when a real DF1 was seen, and says why', async () => {
    const { PATCH } = await import('./route');
    saveSecondDrive.mockResolvedValue('df1_seen');
    const res = await PATCH(req({ mode: 'df1' }), ctx('dev-1'));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'df1_seen', reason: 'A drive already answers as DF1 on this Amiga' });
    expect(saveSecondDrive).toHaveBeenCalledWith('org-1', 'dev-1', 'df1', false);
  });
  it('passes an explicit override through', async () => {
    const { PATCH } = await import('./route');
    saveSecondDrive.mockResolvedValue({ version: 3 });
    const res = await PATCH(req({ mode: 'df1', override: true }), ctx('dev-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 3 });
    expect(saveSecondDrive).toHaveBeenCalledWith('org-1', 'dev-1', 'df1', true);
  });
  it('needs firmware 1.9.0', async () => {
    const { PATCH } = await import('./route');
    saveSecondDrive.mockResolvedValue('firmware_too_old');
    const res = await PATCH(req({ mode: 'df1' }), ctx('dev-1'));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'firmware_too_old', reason: 'Needs firmware 1.9.0 or newer' });
  });
  it('takes net, and names 1.11.0 when the board is too old for it', async () => {
    const { PATCH } = await import('./route');
    saveSecondDrive.mockResolvedValue('firmware_too_old');
    const res = await PATCH(req({ mode: 'net' }), ctx('dev-1'));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'firmware_too_old', reason: 'Needs firmware 1.11.0 or newer' });
    expect(saveSecondDrive).toHaveBeenCalledWith('org-1', 'dev-1', 'net', false);
  });
  it('passes the override through for net', async () => {
    const { PATCH } = await import('./route');
    saveSecondDrive.mockResolvedValue({ version: 4 });
    const res = await PATCH(req({ mode: 'net', override: true }), ctx('dev-1'));
    expect(res.status).toBe(200);
    expect(saveSecondDrive).toHaveBeenCalledWith('org-1', 'dev-1', 'net', true);
  });
  it('refuses a mode it does not know', async () => {
    const { PATCH } = await import('./route');
    expect((await PATCH(req({ mode: 'wifi' }), ctx('dev-1'))).status).toBe(400);
  });
  it('404s an unknown device', async () => {
    const { PATCH } = await import('./route');
    saveSecondDrive.mockResolvedValue('not_found');
    expect((await PATCH(req({ mode: 'off' }), ctx('nope'))).status).toBe(404);
  });
  it('rejects anything but off/df1/net', async () => {
    const { PATCH } = await import('./route');
    expect((await PATCH(req({ mode: 'df2' }), ctx('dev-1'))).status).toBe(400);
    expect(saveSecondDrive).not.toHaveBeenCalled();
  });
});
