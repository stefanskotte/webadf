import { describe, it, expect, vi, beforeEach } from 'vitest';

const inserted: unknown[] = [];
let existing: Array<{ storageKey: string | null; failedAt: Date | null }> = [];
const put = vi.fn(async () => ({ key: 'oagd/x' }));

vi.mock('@/lib/storage', () => ({ imageStore: { put } }));
vi.mock('@/db', () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => existing }) }) }),
    insert: () => ({ values: (v: unknown) => { inserted.push(v); return { onConflictDoUpdate: async () => {} }; } }),
    delete: () => ({ where: async () => {} }),
  }),
}));

const { ensureDemozooImage, imageKeyFor } = await import('./images');
const shot = { id: 1, productionId: 89, standardUrl: 'https://media.demozoo.org/screens/s/9f.png', ordinal: 1 };
const noWait = async () => {};

beforeEach(() => { inserted.length = 0; existing = []; put.mockClear(); });

describe('ensureDemozooImage — politeness', () => {
  it('keys the image by sha1 of its URL, a 40-hex id the image route accepts', () => {
    expect(imageKeyFor(shot.standardUrl)).toMatch(/^[0-9a-f]{40}$/);
  });

  it('never re-fetches a stored image', async () => {
    existing = [{ storageKey: 'oagd/abc', failedAt: null }];
    const fetch = vi.fn();
    expect(await ensureDemozooImage(shot, { fetch, wait: noWait })).toEqual({ stored: false, bytes: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not retry a failure younger than 24 h', async () => {
    existing = [{ storageKey: null, failedAt: new Date() }];
    const fetch = vi.fn();
    await ensureDemozooImage(shot, { fetch, wait: noWait });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fetches once, with our User-Agent, and stores the bytes', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }));
    const r = await ensureDemozooImage(shot, { fetch, wait: noWait });
    expect(r).toEqual({ stored: true, bytes: 3 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(shot.standardUrl, { headers: { 'user-agent': expect.stringContaining('webadf') } });
    expect(put).toHaveBeenCalledWith(imageKeyFor(shot.standardUrl), expect.any(Uint8Array), 'image/png');
  });

  it('fetchWithinBudget stops at the rolling-hour budget and at the deadline', async () => {
    const { fetchWithinBudget } = await import('./images');
    const ensure = vi.fn(async () => ({ stored: true }));
    expect(await fetchWithinBudget([1, 2, 3, 4, 5], 3, () => false, ensure)).toEqual({ attempted: 3, stored: 3 });
    expect(ensure).toHaveBeenCalledTimes(3);
    ensure.mockClear();
    expect(await fetchWithinBudget([1, 2, 3], 10, () => true, ensure)).toEqual({ attempted: 0, stored: 0 });
    expect(ensure).not.toHaveBeenCalled();
  });

  it('fetchWithinBudget counts a throwing fetch against the budget', async () => {
    const { fetchWithinBudget } = await import('./images');
    const ensure = vi.fn(async () => { throw new Error('boom'); });
    expect(await fetchWithinBudget([1, 2, 3], 2, () => false, ensure)).toEqual({ attempted: 2, stored: 0 });
  });

  it('records a failed request instead of throwing', async () => {
    const fetch = vi.fn(async () => new Response('x', { status: 404 }));
    expect(await ensureDemozooImage(shot, { fetch, wait: noWait })).toEqual({ stored: false, bytes: 0 });
    expect(put).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(1);
  });
});
