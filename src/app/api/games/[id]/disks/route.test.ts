import { beforeEach, describe, expect, it, vi } from 'vitest';
// The hidden-id guard (R-6b) is covered against a real database in src/app/api/remote/remote-api.db.test.ts.
vi.mock('@/lib/remote-hidden', async (orig) => ({ ...(await orig<typeof import('@/lib/remote-hidden')>()), refuseHidden: async () => null }));

vi.mock('@/lib/session', () => ({
  requireOrg: () => Promise.resolve({ orgId: 'org-1', userId: 'user-1', email: 'a@b.test' }),
}));
const addDisksToSet = vi.fn();
vi.mock('@/lib/disk-set-store', async () => {
  class NotFound extends Error {}
  return { addDisksToSet: (...a: unknown[]) => addDisksToSet(...a), NotFound };
});

const { POST } = await import('./route');
const { NotFound } = await import('@/lib/disk-set-store');
const { PlanError } = await import('@/lib/disk-set');

const ctx = { params: Promise.resolve({ id: 'G' }) };
const req = (body: unknown) => new Request('http://x/api/games/G/disks', {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
});

beforeEach(() => { addDisksToSet.mockReset(); });

describe('POST /api/games/[id]/disks', () => {
  it('calls the store with the session org and the parsed body, and returns the undo', async () => {
    const undo = [{ diskIds: ['s1'], title: 'T', sortTitle: 't', year: null, publisher: null, metadataSource: null, hadExtras: false }];
    addDisksToSet.mockResolvedValue({ undo });
    const res = await POST(req({ diskIds: ['s1', 's2'], rename: 'Lemmings' }), ctx);
    expect(addDisksToSet).toHaveBeenCalledWith('org-1', 'G', ['s1', 's2'], 'Lemmings');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ undo });
  });

  it('passes no rename when none is given', async () => {
    addDisksToSet.mockResolvedValue({ undo: [] });
    await POST(req({ diskIds: ['s1'] }), ctx);
    expect(addDisksToSet).toHaveBeenCalledWith('org-1', 'G', ['s1'], undefined);
  });

  it('accepts {sourceGameIds, rename} and passes it to the store as a title pick', async () => {
    addDisksToSet.mockResolvedValue({ undo: [] });
    const res = await POST(req({ sourceGameIds: ['B'], rename: 'Set' }), ctx);
    expect(res.status).toBe(200);
    expect(addDisksToSet).toHaveBeenCalledWith('org-1', 'G', { sourceGameIds: ['B'] }, 'Set');
  });

  it('NotFound is 404', async () => {
    addDisksToSet.mockRejectedValue(new NotFound());
    const res = await POST(req({ diskIds: ['s1'] }), ctx);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it.each(['same_title', 'nothing_to_add'] as const)('PlanError %s is 400', async (code) => {
    addDisksToSet.mockRejectedValue(new PlanError(code));
    const res = await POST(req({ diskIds: ['s1'] }), ctx);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: code });
  });

  it.each([
    ['not json', '{'],
    ['empty list', { diskIds: [] }],
    ['too many', { diskIds: Array.from({ length: 65 }, (_, i) => `d${i}`) }],
    ['empty rename', { diskIds: ['s1'], rename: '' }],
    ['long rename', { diskIds: ['s1'], rename: 'x'.repeat(81) }],
    ['wrong type', { diskIds: 's1' }],
    ['both shapes at once', { diskIds: ['s1'], sourceGameIds: ['B'] }],
    ['neither shape', { rename: 'x' }],
    ['empty sourceGameIds', { sourceGameIds: [] }],
    ['too many sourceGameIds', { sourceGameIds: Array.from({ length: 17 }, (_, i) => `g${i}`) }],
    ['sourceGameIds wrong type', { sourceGameIds: 'B' }],
  ])('a malformed body (%s) is 400 and never reaches the store', async (_n, body) => {
    const res = await POST(req(body), ctx);
    expect(res.status).toBe(400);
    expect(addDisksToSet).not.toHaveBeenCalled();
  });
});
