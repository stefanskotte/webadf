import { describe, it, expect, beforeEach } from 'vitest';
import {
  publicOrigin, shareLink, localRootPin, localRootPinState, checkReachability, clearInstanceCacheForTests,
} from './instance';
import type { ShareTarget } from './client';

const ENV = { BETTER_AUTH_URL: 'https://floppy.lan:8443/some/path' };
const CODE = 'wfsc_' + 'A'.repeat(43);
const PIN = 'P'.repeat(43);

beforeEach(() => clearInstanceCacheForTests());

describe('publicOrigin', () => {
  it('is the origin of BETTER_AUTH_URL, path dropped', () => {
    expect(publicOrigin(ENV)).toBe('https://floppy.lan:8443');
  });
  it('throws a clear error when BETTER_AUTH_URL is missing', () => {
    expect(() => publicOrigin({})).toThrow(/BETTER_AUTH_URL/);
  });
});

describe('shareLink', () => {
  it('has no fragment without a pin', () => {
    expect(shareLink(CODE, null, ENV)).toBe(`https://floppy.lan:8443/s/${CODE}`);
  });
  it('carries #pin= with a pin', () => {
    expect(shareLink(CODE, PIN, ENV)).toBe(`https://floppy.lan:8443/s/${CODE}#pin=${PIN}`);
  });
});

describe('localRootPin', () => {
  it('asks for the pin at the public origin and caches it for an hour', async () => {
    let t = 1_000_000;
    const asked: string[] = [];
    const deps = { env: ENV, now: () => t, fetchPin: async (o: string) => { asked.push(o); return PIN; } };
    expect(await localRootPin(deps)).toBe(PIN);
    t += 59 * 60_000;
    expect(await localRootPin(deps)).toBe(PIN);
    expect(asked).toEqual(['https://floppy.lan:8443']);
    t += 2 * 60_000;
    expect(await localRootPin(deps)).toBe(PIN);
    expect(asked).toHaveLength(2);
  });

  it('a 404 (null: a publicly trusted certificate) is cached too', async () => {
    let n = 0;
    const deps = { env: ENV, now: () => 0, fetchPin: async () => { n++; return null; } };
    expect(await localRootPin(deps)).toBeNull();
    expect(await localRootPin(deps)).toBeNull();
    expect(n).toBe(1);
  });

  it('a throw is null with the reason kept, and is NOT cached', async () => {
    let n = 0;
    const deps = { env: ENV, now: () => 0, fetchPin: async () => { n++; throw new Error('root pin: dns'); } };
    expect(await localRootPinState(deps)).toEqual({ pin: null, error: 'root pin: dns' });
    expect(await localRootPin(deps)).toBeNull();
    expect(n).toBe(2);
  });
});

describe('checkReachability', () => {
  it('pings the public origin with the local pin; ok on protocol 1', async () => {
    const seen: ShareTarget[] = [];
    const r = await checkReachability({
      env: ENV, now: () => 0, fetchPin: async () => PIN,
      ping: async (t) => { seen.push(t); return { ok: true, value: { protocol: 1 } }; },
    });
    expect(r).toEqual({ ok: true, origin: 'https://floppy.lan:8443' });
    expect(seen).toEqual([{ origin: 'https://floppy.lan:8443', pin: PIN }]);
  });

  it('says why when the ping fails', async () => {
    const r = await checkReachability({
      env: ENV, now: () => 0, fetchPin: async () => null,
      ping: async () => ({ ok: false, failure: 'unreachable', detail: 'certificate' }),
    });
    expect(r.ok).toBe(false);
    expect(r.origin).toBe('https://floppy.lan:8443');
    expect(r.detail).toMatch(/certificate/);
  });

  it('a different protocol is a failure', async () => {
    const r = await checkReachability({
      env: ENV, now: () => 0, fetchPin: async () => null,
      ping: async () => ({ ok: true, value: { protocol: 2 } }),
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/version/i);
  });

  it('surfaces a root-pin failure in the detail', async () => {
    const r = await checkReachability({
      env: ENV, now: () => 0, fetchPin: async () => { throw new Error('root pin: status_500'); },
      ping: async () => ({ ok: false, failure: 'unreachable', detail: 'certificate' }),
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/status_500/);
  });

  it('a ping that throws is a failure, not an exception', async () => {
    const r = await checkReachability({
      env: ENV, now: () => 0, fetchPin: async () => null,
      ping: async () => { throw new Error('boom'); },
    });
    expect(r).toMatchObject({ ok: false, origin: 'https://floppy.lan:8443' });
  });
});
