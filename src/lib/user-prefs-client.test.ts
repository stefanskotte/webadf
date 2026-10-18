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
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('never has two saves in flight: B is sent only after A settles, and the last request carries B', async () => {
    const calls = fakeFetch();
    const s = latestSaver();
    const a = s.save({ startPage: 'devices' });
    const b = s.save({ startPage: 'upload' });
    await flush();
    // A may already be on the server; sending B now could let A commit last.
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ startPage: 'devices' });
    calls[0].resolve(ok());
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toEqual({ startPage: 'upload' });
    calls[1].resolve(ok());
    expect(await a).toBe('stale');
    expect(await b).toBe('saved');
  });

  it('only the newest pending choice is sent; the ones it replaced are never sent', async () => {
    const calls = fakeFetch();
    const s = latestSaver();
    const a = s.save({ startPage: 'devices' });
    const b = s.save({ startPage: 'upload' });
    const c = s.save({ startPage: 'library' });
    expect(await b).toBe('stale');
    calls[0].resolve(ok());
    await flush();
    expect(calls.map((x) => x.body)).toEqual([{ startPage: 'devices' }, { startPage: 'library' }]);
    calls[1].resolve(ok());
    expect(await a).toBe('stale');
    expect(await c).toBe('saved');
  });

  it('a pending choice equal to the one just saved is not sent again', async () => {
    const calls = fakeFetch();
    const s = latestSaver();
    const a = s.save({ startPage: 'devices' });
    const b = s.save({ startPage: 'upload' });
    const c = s.save({ startPage: 'devices' });
    calls[0].resolve(ok());
    expect(await c).toBe('saved');
    expect(await a).toBe('stale');
    expect(await b).toBe('stale');
    expect(calls).toHaveLength(1);
  });

  it('a failed latest save throws, so the picker can say so; a failure before a newer choice still sends it', async () => {
    const calls = fakeFetch();
    const s = latestSaver();
    const a = s.save({ startPage: 'devices' });
    calls[0].resolve(new Response('{}', { status: 500 }));
    await expect(a).rejects.toThrow(/500/);

    const b = s.save({ startPage: 'upload' });
    const c = s.save({ startPage: 'library' });
    calls[1].resolve(new Response('{}', { status: 500 }));
    await flush();
    expect(calls[2].body).toEqual({ startPage: 'library' });
    calls[2].resolve(ok());
    expect(await b).toBe('stale');
    expect(await c).toBe('saved');
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
