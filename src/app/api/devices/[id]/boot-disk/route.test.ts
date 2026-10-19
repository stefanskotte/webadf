// PATCH /api/devices/[id]/boot-disk (Disk at startup, 2026-10-19).
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/session', () => ({ requireOrg: async () => ({ orgId: 'org-1' }) }));
const saveBootDisk = vi.fn<(orgId: string, id: string, mode: string) => Promise<'ok' | 'not_found' | 'firmware_too_old'>>();
vi.mock('@/lib/boot-disk-store', () => ({
  saveBootDisk: (orgId: string, id: string, mode: string) => saveBootDisk(orgId, id, mode),
}));

const patch = (body: unknown) => new Request('http://test/api/devices/dev-1/boot-disk', {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const ctx = { params: Promise.resolve({ id: 'dev-1' }) };

beforeEach(() => { vi.clearAllMocks(); saveBootDisk.mockResolvedValue('ok'); });

describe('PATCH /api/devices/[id]/boot-disk', () => {
  it('saves the mode for the session org', async () => {
    const { PATCH } = await import('./route');
    const res = await PATCH(patch({ mode: 'empty' }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: 'empty' });
    expect(saveBootDisk).toHaveBeenCalledWith('org-1', 'dev-1', 'empty');
  });
  it('refuses No disk for a board whose firmware cannot do it, with 409 and the version it needs', async () => {
    saveBootDisk.mockResolvedValue('firmware_too_old');
    const { PATCH } = await import('./route');
    const res = await PATCH(patch({ mode: 'empty' }), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'firmware_too_old', reason: 'Needs firmware 1.18.1 or newer' });
  });
  it('is 404 for a board outside the org, and 400 for anything but last or empty', async () => {
    saveBootDisk.mockResolvedValue('not_found');
    const { PATCH } = await import('./route');
    expect((await PATCH(patch({ mode: 'last' }), ctx)).status).toBe(404);
    expect((await PATCH(patch({ mode: 'df0' }), ctx)).status).toBe(400);
    expect((await PATCH(patch({}), ctx)).status).toBe(400);
  });
});
