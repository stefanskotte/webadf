import { describe, it, expect, vi, afterEach } from 'vitest';

// A pooled client that errors while idle (Neon recycling it, a Postgres
// restart) is re-emitted by pg-pool as the pool's 'error' event. Without a
// listener Node throws it as an uncaught exception and the process dies.
describe('getDb pool', () => {
  afterEach(async () => {
    const { closeDb } = await import('./index');
    await closeDb();
    vi.unstubAllEnvs();
  });

  it('survives an idle client error instead of crashing the process', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://u:p@127.0.0.1:1/none');
    const { getDb } = await import('./index');
    const pool = (getDb() as unknown as { $client: import('pg').Pool }).$client;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => pool.emit('error', new Error('terminating connection due to administrator command'))).not.toThrow();
    expect(log).toHaveBeenCalled();
  });
});
