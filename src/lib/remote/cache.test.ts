import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cached, forgetCached, clearCacheForTests, cacheSizeForTests } from './cache';

describe('remote listing cache', () => {
  beforeEach(() => { clearCacheForTests(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-28T12:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('serves a hit until it expires', async () => {
    const load = vi.fn(async () => ({ ok: true, value: 1 }));
    await cached('k', 60_000, load);
    await cached('k', 60_000, load);
    expect(load).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 61_000);
    await cached('k', 60_000, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('never keeps a failure', async () => {
    const load = vi.fn(async () => ({ ok: false, failure: 'unreachable' }));
    await cached('k', 60_000, load);
    await cached('k', 60_000, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('holds at most 500 entries, dropping the oldest', async () => {
    for (let i = 0; i < 501; i++) await cached(`k${i}`, 60_000, async () => ({ ok: true }));
    expect(cacheSizeForTests()).toBe(500);
    const load = vi.fn(async () => ({ ok: true }));
    await cached('k0', 60_000, load);
    expect(load).toHaveBeenCalledTimes(1);
    await cached('k500', 60_000, load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('forgets by prefix', async () => {
    await cached('lib1 a', 60_000, async () => ({ ok: true }));
    await cached('lib2 a', 60_000, async () => ({ ok: true }));
    forgetCached('lib1 ');
    const load = vi.fn(async () => ({ ok: true }));
    await cached('lib1 a', 60_000, load);
    await cached('lib2 a', 60_000, load);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
