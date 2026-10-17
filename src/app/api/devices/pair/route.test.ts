import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/session', () => ({ requireOrg: () => Promise.resolve({ orgId: 'org-1', userId: 'user-1', email: 'a@b.test' }) }));
let inserted: Record<string, unknown>[] = [];
vi.mock('@/db', () => ({ getDb: () => ({
  insert: () => ({ values: (v: Record<string, unknown>) => { inserted.push(v); return {
    onConflictDoNothing: () => ({ returning: async () => [{ code: v.code }] }) }; } }),
}) }));

const post = (body: unknown) => new Request('http://test/api/devices/pair', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => { inserted = []; });

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
