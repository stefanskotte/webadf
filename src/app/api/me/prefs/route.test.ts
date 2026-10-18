import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/session', () => ({ requireOrg: () => Promise.resolve({ orgId: 'org-1', userId: 'user-1', email: 'a@b.test' }) }));
const getUserPrefs = vi.fn();
const setUserPrefs = vi.fn();
vi.mock('@/lib/user-prefs', () => ({
  getUserPrefs: (...a: unknown[]) => getUserPrefs(...a), setUserPrefs: (...a: unknown[]) => setUserPrefs(...a),
}));
const { DEFAULT_PREFS } = await import('@/lib/user-prefs-schema');

const patch = (body: string) => new Request('http://test/api/me/prefs', { method: 'PATCH', body });

beforeEach(() => {
  vi.clearAllMocks();
  getUserPrefs.mockResolvedValue(DEFAULT_PREFS);
  setUserPrefs.mockImplementation(async (_u, p) => ({ ...DEFAULT_PREFS, ...p }));
});

describe('/api/me/prefs', () => {
  it("GET returns the session user's own prefs", async () => {
    const { GET } = await import('./route');
    const res = await GET();
    expect(await res.json()).toEqual(DEFAULT_PREFS);
    expect(getUserPrefs).toHaveBeenCalledWith('user-1');
  });

  it('PATCH saves a valid patch for the session user and returns the result', async () => {
    const { PATCH } = await import('./route');
    const res = await PATCH(patch(JSON.stringify({ startPage: 'devices' })));
    expect(res.status).toBe(200);
    expect((await res.json()).startPage).toBe('devices');
    expect(setUserPrefs).toHaveBeenCalledWith('user-1', { startPage: 'devices' });
  });

  it('PATCH refuses bad JSON, unknown settings and bad values without saving', async () => {
    const { PATCH } = await import('./route');
    for (const body of ['{', JSON.stringify({ userId: 'someone-else' }), JSON.stringify({ startPage: 'admin' })]) {
      expect((await PATCH(patch(body))).status).toBe(400);
    }
    expect(setUserPrefs).not.toHaveBeenCalled();
  });
});
