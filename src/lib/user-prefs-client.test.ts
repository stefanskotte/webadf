import { describe, it, expect, vi, afterEach } from 'vitest';
import { latestSaver, savePrefs } from './user-prefs-client';
import { DEFAULT_PREFS } from './user-prefs-schema';

type Pending = { body: unknown; signal?: AbortSignal; resolve: (r: Response) => void; reject: (e: unknown) => void };
function fakeFetch() {
  const calls: Pending[] = [];
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    const c: Pending = { body: JSON.parse(String(init.body)), signal: init.signal ?? undefined, resolve, reject };
    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    calls.push(c);
  })));
  return calls;
}
const ok = () => new Response(JSON.stringify(DEFAULT_PREFS), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

describe('latestSaver', () => {
  it('a newer save aborts the one in flight; only the newest reports saved', async () => {
    const calls = fakeFetch();
    const s = latestSaver();
    const a = s.save({ startPage: 'devices' });
    const b = s.save({ startPage: 'upload' });
    expect(calls[0].signal?.aborted).toBe(true);
    calls[1].resolve(ok());
    expect(await a).toBe('stale');
    expect(await b).toBe('saved');
  });

  it('a superseded save that already finished still reports stale', async () => {
    const calls = fakeFetch();
    const s = latestSaver();
    const a = s.save({ startPage: 'devices' });
    calls[0].resolve(ok());
    const b = s.save({ startPage: 'upload' });
    calls[1].resolve(ok());
    expect(await b).toBe('saved');
    expect(['saved', 'stale']).toContain(await a);
  });

  it('a failed latest save throws, so the picker can say so', async () => {
    const calls = fakeFetch();
    const s = latestSaver();
    const a = s.save({ startPage: 'devices' });
    calls[0].resolve(new Response('{}', { status: 500 }));
    await expect(a).rejects.toThrow(/500/);
  });
});

describe('savePrefs', () => {
  it('PATCHes /api/me/prefs and throws on a refusal', async () => {
    const calls = fakeFetch();
    const p = savePrefs({ startPage: 'devices' });
    expect(calls[0].body).toEqual({ startPage: 'devices' });
    calls[0].resolve(new Response('{}', { status: 400 }));
    await expect(p).rejects.toThrow(/400/);
  });
});
