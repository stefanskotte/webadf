import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/session', () => ({
  requireOrg: () => Promise.resolve({ orgId: 'org-1', userId: 'user-1', email: 'a@b.test' }),
}));
const searchCandidates = vi.fn();
vi.mock('@/lib/disk-set-search', () => ({ CANDIDATE_PAGE: 20, searchCandidates: (...a: unknown[]) => searchCandidates(...a) }));

const { GET } = await import('./route');

const get = (qs: string) => new Request(`http://x/api/disk-sets/candidates${qs}`);

beforeEach(() => { searchCandidates.mockReset(); });

describe('GET /api/disk-sets/candidates', () => {
  it('calls the store with the session org, q and exclude, and returns its titles', async () => {
    const titles = [{ gameId: 'g1', title: 'Lemmings', disks: [{ id: 'd1', diskNo: 1, sourceFilename: 'L.adf', tosecName: null }] }];
    searchCandidates.mockResolvedValue({ titles, more: true });
    const res = await GET(get('?q=lem&exclude=G-self'));
    expect(searchCandidates).toHaveBeenCalledWith('org-1', 'lem', 'G-self', 20);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ titles, more: true });
  });

  it('passes limit through for "Show more", and a junk limit is one page', async () => {
    searchCandidates.mockResolvedValue({ titles: [], more: false });
    await GET(get('?q=&limit=40'));
    expect(searchCandidates).toHaveBeenLastCalledWith('org-1', '', null, 40);
    await GET(get('?q=&limit=abc'));
    expect(searchCandidates).toHaveBeenLastCalledWith('org-1', '', null, 20);
  });

  it('an absent q is the empty string, not "null"', async () => {
    searchCandidates.mockResolvedValue({ titles: [], more: false });
    await GET(get('?exclude=G-self'));
    expect(searchCandidates).toHaveBeenCalledWith('org-1', '', 'G-self', 20);
  });

  it('an absent or blank exclude is null', async () => {
    searchCandidates.mockResolvedValue({ titles: [], more: false });
    await GET(get('?q=lem'));
    expect(searchCandidates).toHaveBeenCalledWith('org-1', 'lem', null, 20);

    searchCandidates.mockClear();
    await GET(get('?q=lem&exclude='));
    expect(searchCandidates).toHaveBeenCalledWith('org-1', 'lem', null, 20);
  });
});
