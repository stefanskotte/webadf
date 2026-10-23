// DELETE /api/me/account: a person deleting their own account (A2). Password-checked through the same throttled gate
// as the firmware update, DELETE typed out, and refused when anyone else shares the organization -- the cascade
// removes the whole library, which would be theirs too.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/session', () => ({ requireOrg: () => Promise.resolve({ orgId: 'org-1', userId: 'user-1', email: 'a@b.test' }) }));
const stepUpGate = vi.fn<(u: string, p: string) => Promise<Response | null>>();
vi.mock('@/lib/step-up-gate', () => ({ stepUpGate: (u: string, p: string) => stepUpGate(u, p) }));
const otherMemberCount = vi.fn<(u: string) => Promise<number>>();
const deleteUserCascade = vi.fn();
vi.mock('@/lib/admin-delete', () => ({
  otherMemberCount: (u: string) => otherMemberCount(u),
  deleteUserCascade: (u: string) => deleteUserCascade(u),
}));

const del = (body: unknown) => new Request('http://test/api/me/account', {
  method: 'DELETE', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  stepUpGate.mockResolvedValue(null);
  otherMemberCount.mockResolvedValue(0);
  deleteUserCascade.mockResolvedValue({ orgId: 'org-1', games: 3, disks: 4, devices: 1, orgsRemoved: 1 });
});

describe('deleting your own account', () => {
  it('needs DELETE typed exactly, before the password is even checked', async () => {
    const { DELETE } = await import('./route');
    for (const confirm of [undefined, '', 'delete', 'DELETE ']) {
      const res = await DELETE(del({ password: 'right', confirm }));
      expect(res.status).toBe(400);
    }
    expect(stepUpGate).not.toHaveBeenCalled();
    expect(deleteUserCascade).not.toHaveBeenCalled();
  });

  it('a refused password (wrong, or locked out) is answered as the gate answers, and deletes nothing', async () => {
    stepUpGate.mockResolvedValue(Response.json({ error: 'bad_password' }, { status: 401 }));
    const { DELETE } = await import('./route');
    const res = await DELETE(del({ password: 'nope', confirm: 'DELETE' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'bad_password' });
    expect(stepUpGate).toHaveBeenCalledWith('user-1', 'nope');
    expect(deleteUserCascade).not.toHaveBeenCalled();
  });

  it('is refused while anyone else is a member of the organization', async () => {
    otherMemberCount.mockResolvedValue(1);
    const { DELETE } = await import('./route');
    const res = await DELETE(del({ password: 'right', confirm: 'DELETE' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'shared_organization' });
    expect(deleteUserCascade).not.toHaveBeenCalled();
  });

  it('deletes the signed-in user and their library', async () => {
    const { DELETE } = await import('./route');
    const res = await DELETE(del({ password: 'right', confirm: 'DELETE' }));
    expect(res.status).toBe(200);
    expect(deleteUserCascade).toHaveBeenCalledWith('user-1');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('a body that is not JSON is a 400', async () => {
    const { DELETE } = await import('./route');
    expect((await DELETE(del('not json'))).status).toBe(400);
  });
});
