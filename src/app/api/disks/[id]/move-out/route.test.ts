import { beforeEach, describe, expect, it, vi } from 'vitest';
// The hidden-id guard (R-6b) is covered against a real database in src/app/api/remote/remote-api.db.test.ts.
vi.mock('@/lib/remote-hidden', async (orig) => ({ ...(await orig<typeof import('@/lib/remote-hidden')>()), refuseHidden: async () => null }));

vi.mock('@/lib/session', () => ({
  requireOrg: () => Promise.resolve({ orgId: 'org-1', userId: 'user-1', email: 'a@b.test' }),
}));
const moveDiskOut = vi.fn();
vi.mock('@/lib/disk-set-store', async () => {
  class NotFound extends Error {}
  return { moveDiskOut: (...a: unknown[]) => moveDiskOut(...a), NotFound };
});

const { POST } = await import('./route');
const { NotFound } = await import('@/lib/disk-set-store');
const { PlanError } = await import('@/lib/disk-set');

const ctx = { params: Promise.resolve({ id: 'd1' }) };
const req = () => new Request('http://x/api/disks/d1/move-out', { method: 'POST' });

beforeEach(() => { moveDiskOut.mockReset(); });

describe('POST /api/disks/[id]/move-out', () => {
  it('calls the store with the session org and the disk id; returns the new gameId', async () => {
    moveDiskOut.mockResolvedValue({ gameId: 'NEW' });
    const res = await POST(req(), ctx);
    expect(moveDiskOut).toHaveBeenCalledWith('org-1', 'd1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ gameId: 'NEW' });
  });

  it('NotFound is 404', async () => {
    moveDiskOut.mockRejectedValue(new NotFound());
    const res = await POST(req(), ctx);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('a lone disk (not_in_a_set) is 400', async () => {
    moveDiskOut.mockRejectedValue(new PlanError('not_in_a_set'));
    const res = await POST(req(), ctx);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'not_in_a_set' });
  });

  it('an over-long id is 400 and never reaches the store', async () => {
    const res = await POST(req(), { params: Promise.resolve({ id: 'x'.repeat(200) }) });
    expect(res.status).toBe(400);
    expect(moveDiskOut).not.toHaveBeenCalled();
  });
});
