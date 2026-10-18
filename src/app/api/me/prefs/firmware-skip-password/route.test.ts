// POST /api/me/prefs/firmware-skip-password: the only way to turn the
// firmware password prompt off, so it must check the password exactly as the
// firmware route does -- the same throttle, the same answers.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/session', () => ({ requireOrg: () => Promise.resolve({ orgId: 'org-1', userId: 'user-1', email: 'a@b.test' }) }));
const verifyPassword = vi.fn(async (_p: string) => false);
vi.mock('@/lib/step-up', () => ({ verifyPassword: (p: string) => verifyPassword(p) }));
const lockoutRemaining = vi.fn(async (_u: string) => 0);
const recordFailure = vi.fn(async (_u: string) => 0);
const clearFailures = vi.fn(async (_u: string) => undefined);
vi.mock('@/lib/step-up-throttle', () => ({
  lockoutRemaining: (u: string) => lockoutRemaining(u),
  recordFailure: (u: string) => recordFailure(u),
  clearFailures: (u: string) => clearFailures(u),
}));
const setUserPrefs = vi.fn();
vi.mock('@/lib/user-prefs', () => ({ setUserPrefs: (...a: unknown[]) => setUserPrefs(...a), getUserPrefs: vi.fn() }));
const { DEFAULT_PREFS } = await import('@/lib/user-prefs-schema');

const post = (body: unknown) => new Request('http://test/api/me/prefs/firmware-skip-password', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  verifyPassword.mockResolvedValue(false);
  lockoutRemaining.mockResolvedValue(0);
  recordFailure.mockResolvedValue(0);
  setUserPrefs.mockImplementation(async (_u, p) => ({ ...DEFAULT_PREFS, ...p }));
});

describe('turning on "no firmware password"', () => {
  it('a wrong password is refused, counted, and stores nothing', async () => {
    const { POST } = await import('./route');
    const res = await POST(post({ password: 'nope' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'bad_password' });
    expect(verifyPassword).toHaveBeenCalledWith('nope');
    expect(recordFailure).toHaveBeenCalledWith('user-1');
    expect(clearFailures).not.toHaveBeenCalled();
    expect(setUserPrefs).not.toHaveBeenCalled();
  });

  it('the wrong password that trips the lockout answers 429 with the wait', async () => {
    recordFailure.mockResolvedValue(900_000);
    const { POST } = await import('./route');
    const res = await POST(post({ password: 'nope' }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'too_many_attempts', retryAfterMs: 900_000 });
    expect(setUserPrefs).not.toHaveBeenCalled();
  });

  it('honours a lockout before the password is even checked', async () => {
    lockoutRemaining.mockResolvedValue(60_000);
    verifyPassword.mockResolvedValue(true);
    const { POST } = await import('./route');
    const res = await POST(post({ password: 'right' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(await res.json()).toEqual({ error: 'too_many_attempts', retryAfterMs: 60_000 });
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(setUserPrefs).not.toHaveBeenCalled();
  });

  it('the right password clears the count and stores skipPassword: true', async () => {
    verifyPassword.mockResolvedValue(true);
    const { POST } = await import('./route');
    const res = await POST(post({ password: 'right' }));
    expect(res.status).toBe(200);
    expect((await res.json()).firmware).toEqual({ skipPassword: true });
    expect(clearFailures).toHaveBeenCalledWith('user-1');
    expect(setUserPrefs).toHaveBeenCalledWith('user-1', { firmware: { skipPassword: true } });
  });

  it('a missing or empty password is a 400, not a counted failure', async () => {
    const { POST } = await import('./route');
    for (const body of ['{', {}, { password: '' }, { password: 3 }]) {
      expect((await POST(post(body))).status).toBe(400);
    }
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(recordFailure).not.toHaveBeenCalled();
    expect(setUserPrefs).not.toHaveBeenCalled();
  });
});
