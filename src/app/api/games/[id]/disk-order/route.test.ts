import { beforeEach, describe, expect, it, vi } from 'vitest';
// The hidden-id guard (R-6b) is covered against a real database in src/app/api/remote/remote-api.db.test.ts.
vi.mock('@/lib/remote-hidden', async (orig) => ({ ...(await orig<typeof import('@/lib/remote-hidden')>()), refuseHidden: async () => null }));

vi.mock('@/lib/session', () => ({
  requireOrg: () => Promise.resolve({ orgId: 'org-1', userId: 'user-1', email: 'a@b.test' }),
}));
const reorderSet = vi.fn();
vi.mock('@/lib/disk-set-store', async () => {
  class NotFound extends Error {}
  return { reorderSet: (...a: unknown[]) => reorderSet(...a), NotFound };
});

const { PUT } = await import('./route');
const { NotFound } = await import('@/lib/disk-set-store');
const { PlanError } = await import('@/lib/disk-set');

const ctx = { params: Promise.resolve({ id: 'G' }) };
const req = (body: unknown) => new Request('http://x/api/games/G/disk-order', {
  method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body),
});

beforeEach(() => { reorderSet.mockReset(); });

describe('PUT /api/games/[id]/disk-order', () => {
  it('calls the store with the session org and the parsed list; 204', async () => {
    reorderSet.mockResolvedValue(undefined);
    const res = await PUT(req({ diskIds: ['b', 'a'] }), ctx);
    expect(reorderSet).toHaveBeenCalledWith('org-1', 'G', ['b', 'a']);
    expect(res.status).toBe(204);
  });

  it('NotFound is 404', async () => {
    reorderSet.mockRejectedValue(new NotFound());
    const res = await PUT(req({ diskIds: ['a'] }), ctx);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('PlanError stale_order is 409 (Review Focus 4)', async () => {
    reorderSet.mockRejectedValue(new PlanError('stale_order'));
    const res = await PUT(req({ diskIds: ['a'] }), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'stale_order' });
  });

  it.each([
    ['not json', '{'],
    ['empty list', { diskIds: [] }],
    ['too many', { diskIds: Array.from({ length: 65 }, (_, i) => `d${i}`) }],
    ['missing', {}],
  ])('a malformed body (%s) is 400', async (_n, body) => {
    const res = await PUT(req(body), ctx);
    expect(res.status).toBe(400);
    expect(reorderSet).not.toHaveBeenCalled();
  });
});
