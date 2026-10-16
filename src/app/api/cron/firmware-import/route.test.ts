import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const runner = vi.fn(async () => ({ status: 'ok' }));
vi.mock('@/lib/firmware-import', () => ({ runFirmwareImport: runner }));
const { GET } = await import('./route');

describe('cron firmware-import route', () => {
  const saved = process.env.CRON_SECRET;
  beforeEach(() => { runner.mockClear(); });
  afterEach(() => { if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved; });

  it('401s when CRON_SECRET is unset, without running', async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(new Request('http://x/', { headers: { authorization: 'Bearer undefined' } }));
    expect(res.status).toBe(401);
    expect(runner).not.toHaveBeenCalled();
  });
  it('401s with a wrong bearer, without running', async () => {
    process.env.CRON_SECRET = 's3cret';
    const res = await GET(new Request('http://x/', { headers: { authorization: 'Bearer nope' } }));
    expect(res.status).toBe(401);
    expect(runner).not.toHaveBeenCalled();
  });
  it('runs with the right bearer', async () => {
    process.env.CRON_SECRET = 's3cret';
    const res = await GET(new Request('http://x/', { headers: { authorization: 'Bearer s3cret' } }));
    expect(res.status).toBe(200);
    expect(runner).toHaveBeenCalledTimes(1);
  });
});
