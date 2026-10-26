// POST /api/admin/users/[id]/password: an admin sets a new, generated password on another account. The admin's OWN
// current password is required (the step-up gate, same throttle as the firmware update): a stolen admin cookie alone
// must not be able to take over every account on the server.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const requireSuperAdmin = vi.fn(async () => ({ userId: 'admin-1', email: 'admin@x.test' }));
vi.mock('@/lib/superadmin', () => ({ requireSuperAdmin: () => requireSuperAdmin() }));
const stepUpGate = vi.fn<(u: string, p: string) => Promise<Response | null>>(async () => null);
vi.mock('@/lib/step-up-gate', () => ({ stepUpGate: (u: string, p: string) => stepUpGate(u, p) }));
vi.mock('@/lib/auth', () => ({ auth: {} }));
const resetUserPassword = vi.fn<(id: string, pw: string) => Promise<'ok' | 'unknown' | 'no_password'>>(async () => 'ok');
vi.mock('@/lib/admin-password-reset', async (orig) => ({
  ...(await orig<typeof import('@/lib/admin-password-reset')>()),
  resetUserPassword: (id: string, pw: string) => resetUserPassword(id, pw),
}));

const post = (body: unknown) => new Request('http://test/api/admin/users/u-2/password', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
});
const params = (id = 'u-2') => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  stepUpGate.mockResolvedValue(null);
  resetUserPassword.mockResolvedValue('ok');
});

describe('admin resets a user password', () => {
  it('needs the admin to be a super-admin (the check throws before anything else)', async () => {
    requireSuperAdmin.mockRejectedValueOnce(new Error('NEXT_NOT_FOUND'));
    const { POST } = await import('./route');
    await expect(POST(post({ password: 'x' }), params())).rejects.toThrow();
    expect(stepUpGate).not.toHaveBeenCalled();
    expect(resetUserPassword).not.toHaveBeenCalled();
  });

  it('a missing current password is a 400, not a guess', async () => {
    const { POST } = await import('./route');
    for (const body of [{}, { password: '' }, 'not json', { password: 'x', extra: 1 }]) {
      const res = await POST(post(body), params());
      expect(res.status).toBe(400);
    }
    expect(stepUpGate).not.toHaveBeenCalled();
    expect(resetUserPassword).not.toHaveBeenCalled();
  });

  it("checks the ADMIN's own password through the step-up gate, and a refusal changes nothing", async () => {
    stepUpGate.mockResolvedValue(Response.json({ error: 'bad_password' }, { status: 401 }));
    const { POST } = await import('./route');
    const res = await POST(post({ password: 'wrong' }), params());
    expect(stepUpGate).toHaveBeenCalledWith('admin-1', 'wrong');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'bad_password' });
    expect(resetUserPassword).not.toHaveBeenCalled();
  });

  it('refuses the admin\'s own account: that is Settings › Account, with the current password', async () => {
    const { POST } = await import('./route');
    const res = await POST(post({ password: 'right' }), params('admin-1'));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'self' });
    expect(resetUserPassword).not.toHaveBeenCalled();
  });

  it('the right password sets a fresh generated password and returns it once', async () => {
    const { POST } = await import('./route');
    const res = await POST(post({ password: 'right' }), params());
    expect(res.status).toBe(200);
    const { password } = await res.json() as { password: string };
    expect(password).toMatch(/^[A-HJ-NP-Za-km-z2-9]{4}(-[A-HJ-NP-Za-km-z2-9]{4}){3}$/);
    expect(resetUserPassword).toHaveBeenCalledWith('u-2', password);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('an unknown user is 404 and an account without a password is 409', async () => {
    const { POST } = await import('./route');
    resetUserPassword.mockResolvedValueOnce('unknown');
    expect((await POST(post({ password: 'right' }), params())).status).toBe(404);
    resetUserPassword.mockResolvedValueOnce('no_password');
    const res = await POST(post({ password: 'right' }), params());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'no_password' });
  });
});

describe('generateTempPassword', () => {
  it('is 4 groups of 4 unambiguous characters, and never repeats', async () => {
    const { generateTempPassword } = await import('@/lib/admin-password-reset');
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = generateTempPassword();
      expect(p).toMatch(/^[A-HJ-NP-Za-km-z2-9]{4}(-[A-HJ-NP-Za-km-z2-9]{4}){3}$/);
      seen.add(p);
    }
    expect(seen.size).toBe(200);
  });
});
