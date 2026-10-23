// The staging routes (spec 2026-10-23 upload staging): thin, org-scoped wrappers over the server staging list.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const requireOrg = vi.fn(() => Promise.resolve({ orgId: 'org-1', userId: 'user-1', email: 'a@b.test' }));
vi.mock('@/lib/session', () => ({ requireOrg: () => requireOrg() }));
const db = { tag: 'db' };
vi.mock('@/db', () => ({ getDb: () => db }));
const listStaging = vi.fn();
const clearStaging = vi.fn();
vi.mock('@/lib/staging-server', () => ({
  listStaging: (...a: unknown[]) => listStaging(...a), clearStaging: (...a: unknown[]) => clearStaging(...a),
}));
const listSendTargets = vi.fn();
vi.mock('@/lib/send-targets', () => ({ listSendTargets: (...a: unknown[]) => listSendTargets(...a) }));

const { GET } = await import('./route');
const { POST } = await import('./clear/route');

const post = (body: unknown) => new Request('http://x/api/staging/clear', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
});
const keys = (n: number) => Array.from({ length: n }, (_, i) => `k${i}`);

beforeEach(() => { vi.clearAllMocks(); });

describe('GET /api/staging', () => {
  it('passes the session org to both libs with one shared now and returns their answers', async () => {
    listStaging.mockResolvedValue([{ key: 'a' }]);
    listSendTargets.mockResolvedValue([{ deviceId: 'dev-1' }]);
    const res = await GET();
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.rows).toEqual([{ key: 'a' }]);
    expect(body.targets).toEqual([{ deviceId: 'dev-1' }]);
    expect(typeof body.now).toBe('number');
    const [sDb, sOrg, sNow] = listStaging.mock.calls[0];
    const [tDb, tOrg, tNow] = listSendTargets.mock.calls[0];
    expect([sDb, sOrg, tDb, tOrg]).toEqual([db, 'org-1', db, 'org-1']);
    expect(sNow).toBeInstanceOf(Date);
    expect(tNow).toBe((sNow as Date).getTime());
    expect(body.now).toBe(tNow);
  });
});

describe('POST /api/staging/clear', () => {
  it.each([1, 1000])('clears %i keys and answers the count', async (n) => {
    clearStaging.mockResolvedValue(n);
    const res = await POST(post({ keys: keys(n) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cleared: n });
    expect(clearStaging).toHaveBeenCalledWith(db, 'org-1', keys(n));
  });

  it.each([
    ['no keys', { keys: [] }],
    ['1001 keys', { keys: keys(1001) }],
    ['a non-string key', { keys: ['a', 3] }],
    ['an empty key', { keys: [''] }],
    ['a key over 200 chars', { keys: ['x'.repeat(201)] }],
    ['no keys field', {}],
    ['non-JSON', 'not json{'],
  ])('rejects %s with 400 and never clears', async (_n, body) => {
    const res = await POST(post(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_body' });
    expect(clearStaging).not.toHaveBeenCalled();
  });
});
