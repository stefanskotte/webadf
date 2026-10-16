import { describe, it, expect, vi, beforeEach } from 'vitest';

const expireTransfers = vi.fn(async () => ({ expired: 2, deleted: 5 }));
vi.mock('@/lib/transfers', () => ({ expireTransfers: () => expireTransfers() }));
vi.mock('@/db', () => ({ getDb: () => ({}) }));
const { GET } = await import('./route');
const call = (auth?: string) => GET(new Request('http://x/api/cron/transfers', auth ? { headers: { authorization: auth } } : {}));

beforeEach(() => { vi.clearAllMocks(); process.env.CRON_SECRET = 's3cret'; });

describe('GET /api/cron/transfers', () => {
  it('refuses without the cron secret, and fails closed when none is set', async () => {
    expect((await call()).status).toBe(401);
    expect((await call('Bearer wrong')).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await call('Bearer undefined')).status).toBe(401);
    expect(expireTransfers).not.toHaveBeenCalled();
  });
  it('expires and deletes, and reports the counts', async () => {
    const r = await call('Bearer s3cret');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ expired: 2, deleted: 5 });
  });
});
