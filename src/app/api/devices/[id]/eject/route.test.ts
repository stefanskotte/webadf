import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/session', () => ({ requireOrg: async () => ({ orgId: 'org-1' }) }));
const clearDesired = vi.fn();
vi.mock('@/lib/mount', () => ({ clearDesired: (...a: unknown[]) => clearDesired(...a) }));
const ejectDf1 = vi.fn();
vi.mock('@/lib/df1-store', () => ({ ejectDf1: (...a: unknown[]) => ejectDf1(...a) }));

const post = async (init: RequestInit) => {
  const { POST } = await import('./route');
  return POST(new Request('http://test/api/devices/dev-1/eject', { method: 'POST', ...init }),
    { params: Promise.resolve({ id: 'dev-1' }) });
};

beforeEach(() => { vi.clearAllMocks(); });

describe('POST /api/devices/[id]/eject -- drive', () => {
  it('no body ejects DF0, as every existing caller sends it', async () => {
    clearDesired.mockResolvedValue(4);
    const res = await post({});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 4 });
    expect(ejectDf1).not.toHaveBeenCalled();
  });
  it('{"drive":"df1"} ejects DF1 only', async () => {
    ejectDf1.mockResolvedValue(6);
    const res = await post({ headers: { 'content-type': 'application/json' }, body: JSON.stringify({ drive: 'df1' }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 6 });
    expect(ejectDf1).toHaveBeenCalledWith('org-1', 'dev-1');
    expect(clearDesired).not.toHaveBeenCalled();
  });
  it('DF1 eject of a board that is not this org\'s is a 404', async () => {
    ejectDf1.mockResolvedValue(null);
    const res = await post({ headers: { 'content-type': 'application/json' }, body: JSON.stringify({ drive: 'df1' }) });
    expect(res.status).toBe(404);
  });
});
