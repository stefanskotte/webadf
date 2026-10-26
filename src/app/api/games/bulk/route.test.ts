import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/games/bulk (spec 2026-10-26 library multi-select §3.1, §3.4): validation, the session's org, and the
// mapping to the two library functions (their org scoping is tested against Postgres in library-bulk.db.test.ts).
vi.mock('@/lib/session', () => ({
  requireOrg: () => Promise.resolve({ orgId: 'org-1', userId: 'user-1', email: 'a@b.test' }),
}));
vi.mock('@/lib/clock', () => ({ nowMs: () => 1_000 }));
const moveGamesToCollection = vi.fn();
const deleteGames = vi.fn();
vi.mock('@/lib/collections', () => ({ moveGamesToCollection: (...a: unknown[]) => moveGamesToCollection(...a) }));
vi.mock('@/lib/disk-delete', () => ({ deleteGames: (...a: unknown[]) => deleteGames(...a) }));

const { POST } = await import('./route');
const req = (body: unknown) => new Request('http://x/api/games/bulk', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const MOVED = { added: 2, alreadyThere: 0, removedFrom: 0, missing: [] };

beforeEach(() => { moveGamesToCollection.mockReset(); deleteGames.mockReset(); });

describe('POST /api/games/bulk', () => {
  it('move: the session org, the ids deduplicated in first order, to and from; 200 with the result', async () => {
    moveGamesToCollection.mockResolvedValue(MOVED);
    const res = await POST(req({ op: 'move', gameIds: ['a', 'b', 'a'], to: 'c1', from: 'c0' }));
    expect(moveGamesToCollection).toHaveBeenCalledWith('org-1', ['a', 'b'], 'c1', 'c0');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(MOVED);
  });

  it('move without from passes undefined', async () => {
    moveGamesToCollection.mockResolvedValue(MOVED);
    await POST(req({ op: 'move', gameIds: ['a'], to: 'c1' }));
    expect(moveGamesToCollection).toHaveBeenCalledWith('org-1', ['a'], 'c1', undefined);
  });

  it("a collection this org does not own is 404 not_found", async () => {
    moveGamesToCollection.mockResolvedValue(null);
    const res = await POST(req({ op: 'move', gameIds: ['a'], to: 'theirs' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('to === from is 400 same_collection, and nothing is called', async () => {
    const res = await POST(req({ op: 'move', gameIds: ['a'], to: 'c1', from: 'c1' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'same_collection' });
    expect(moveGamesToCollection).not.toHaveBeenCalled();
  });

  it('delete with dryRun previews, with the request clock', async () => {
    deleteGames.mockResolvedValue({ deletable: { titles: 1, disks: 1 }, titles: [], kept: [], missing: [] });
    const res = await POST(req({ op: 'delete', gameIds: ['a', 'a', 'b'], dryRun: true }));
    expect(deleteGames).toHaveBeenCalledWith('org-1', ['a', 'b'], { dryRun: true, now: 1_000 });
    expect(res.status).toBe(200);
  });

  it('delete without dryRun deletes', async () => {
    deleteGames.mockResolvedValue({ deleted: ['a'], diskIds: [], kept: [], missing: [], ejected: [], releasedSha256: [] });
    const res = await POST(req({ op: 'delete', gameIds: ['a'] }));
    expect(deleteGames).toHaveBeenCalledWith('org-1', ['a'], { now: 1_000 });
    expect(await res.json()).toMatchObject({ deleted: ['a'] });
  });

  it('a body that is not JSON is 400 invalid_json', async () => {
    const res = await POST(req('{'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
  });

  it.each([
    ['an empty list', { op: 'delete', gameIds: [] }],
    ['1,001 ids', { op: 'delete', gameIds: Array.from({ length: 1001 }, (_, i) => `g${i}`) }],
    ['an unknown op', { op: 'archive', gameIds: ['a'] }],
    ['a move with no target', { op: 'move', gameIds: ['a'] }],
    ['an empty id', { op: 'delete', gameIds: [''] }],
    ['a non-string id', { op: 'delete', gameIds: [7] }],
    ['an unknown key', { op: 'delete', gameIds: ['a'], orgId: 'evil' }],
    ['dryRun on a move', { op: 'move', gameIds: ['a'], to: 'c1', dryRun: true }],
  ])('%s is 400 invalid_body, and nothing is called', async (_n, body) => {
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_body');
    expect(moveGamesToCollection).not.toHaveBeenCalled();
    expect(deleteGames).not.toHaveBeenCalled();
  });
});
