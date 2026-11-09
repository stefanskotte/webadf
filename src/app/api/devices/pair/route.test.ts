import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/session', () => ({ requireOrg: () => Promise.resolve({ orgId: 'org-1', userId: 'user-1', email: 'a@b.test' }) }));
let inserted: Record<string, unknown>[] = [];
let selected: Record<string, unknown>[] = [];
vi.mock('@/db', () => ({ getDb: () => ({
  select: () => ({ from: () => ({ where: () => ({ limit: async () => selected }) }) }),
  insert: () => ({ values: (v: Record<string, unknown>) => { inserted.push(v); return {
    onConflictDoNothing: () => ({ returning: async () => [{ code: v.code }] }) }; } }),
}) }));

const post = (body: unknown) => new Request('http://test/api/devices/pair', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => { inserted = []; selected = []; });

describe('POST /api/devices/pair', () => {
  it('keeps the trimmed name on the code', async () => {
    const { POST } = await import('./route');
    const res = await POST(post({ name: '  A500 study ' }));
    expect(res.status).toBe(200);
    expect(inserted[0]).toMatchObject({ orgId: 'org-1', createdByUserId: 'user-1', name: 'A500 study' });
  });
  it('stores no name for an empty or missing one (the board then wears its MAC)', async () => {
    const { POST } = await import('./route');
    await POST(post({ name: '   ' }));
    await POST(post({}));
    expect(inserted.map((v) => v.name)).toEqual([null, null]);
  });
  it('refuses a name over 80 characters rather than cutting it', async () => {
    const { POST } = await import('./route');
    const res = await POST(post({ name: 'x'.repeat(81) }));
    expect(res.status).toBe(400);
    expect(inserted).toHaveLength(0);
  });
});

describe('code lifetime', () => {
  it('lasts 30 minutes (2026-11-09; was 10)', async () => {
    const { POST } = await import('./route');
    const before = Date.now();
    const body = await (await POST(post({}))).json();
    const ms = new Date(body.expiresAt).getTime() - before;
    expect(ms).toBeGreaterThan(29.9 * 60_000);
    expect(ms).toBeLessThanOrEqual(30 * 60_000 + 1000);
  });
});

describe('GET /api/devices/pair?code=', () => {
  const get = (code: string) => new Request(`http://test/api/devices/pair?code=${code}`);
  it('says paired once a board has used the code', async () => {
    const { GET } = await import('./route');
    selected = [{ consumedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) }];
    expect(await (await GET(get('ABC234'))).json()).toEqual({ state: 'paired' });
  });
  it('says waiting for a live unused code, expired for a lapsed one', async () => {
    const { GET } = await import('./route');
    selected = [{ consumedAt: null, expiresAt: new Date(Date.now() + 60_000) }];
    expect(await (await GET(get('ABC234'))).json()).toEqual({ state: 'waiting' });
    selected = [{ consumedAt: null, expiresAt: new Date(Date.now() - 1) }];
    expect(await (await GET(get('ABC234'))).json()).toEqual({ state: 'expired' });
  });
  it('says unknown for a code not in this organization, and refuses a malformed one', async () => {
    const { GET } = await import('./route');
    expect(await (await GET(get('ABC234'))).json()).toEqual({ state: 'unknown' });
    expect((await GET(get('abc;drop'))).status).toBe(400);
  });
});
