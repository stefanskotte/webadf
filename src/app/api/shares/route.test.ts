import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/session', () => ({ requireOrg: async () => ({ orgId: 'org-1', userId: 'user-1' }) }));
const createShare = vi.fn();
vi.mock('@/lib/share/store', () => ({ createShare: (...a: unknown[]) => createShare(...a), listShares: async () => [] }));
const publicOrigin = vi.fn((): string => 'https://me.example');
vi.mock('@/lib/share/instance', () => ({
  publicOrigin: () => publicOrigin(),
  localRootPinState: async () => ({ pin: null, error: null }),
  shareLink: (code: string) => `https://me.example/s/${code}`,
}));
vi.mock('@/lib/share/view', () => ({ toShareView: (s: unknown) => s }));

const { POST } = await import('./route');
const req = () => new Request('http://x/api/shares', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'Rob', everything: true }),
});

beforeEach(() => {
  createShare.mockReset();
  publicOrigin.mockReset();
  publicOrigin.mockReturnValue('https://me.example');
});

describe('POST /api/shares (final review 9)', () => {
  it('a server that does not know its own address answers 503 and creates no share', async () => {
    publicOrigin.mockImplementation(() => { throw new Error('BETTER_AUTH_URL is not set'); });
    const res = await POST(req());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'no_public_address' });
    expect(createShare).not.toHaveBeenCalled();
  });

  it('otherwise creates the share and answers its link', async () => {
    createShare.mockResolvedValue({ ok: true, share: { id: 's1' }, code: 'wfsc_x' });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ share: { id: 's1' }, link: 'https://me.example/s/wfsc_x' });
    expect(createShare).toHaveBeenCalledWith('org-1', 'user-1', { label: 'Rob', everything: true, collectionIds: [] });
  });
});
