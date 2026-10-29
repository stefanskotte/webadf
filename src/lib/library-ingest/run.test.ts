import { describe, it, expect, vi } from 'vitest';
import { runLibraryIngest, suggestSet, type IngestIo, type IngestOutcome } from './run';
import type { LibRow, LibState } from './rows';

const file = (name: string, size = 901_120) => new File([new Uint8Array(size)], name);
/** A fake server: `missing` says which hashes /check reports missing; `complete` answers /complete; PUTs per url. */
function server(opts: { missing: string[]; complete?: (body: unknown) => Response; put?: (url: string) => Response | Promise<Response> }) {
  const calls: string[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url); calls.push(`${init?.method ?? 'GET'} ${u.startsWith('/api') ? u : 'blob'}`);
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    if (u === '/api/ingest/check') return Response.json({ missing: opts.missing });
    if (u === '/api/ingest/presign') return Response.json({ uploads: (body.files as Array<{ sha256: string }>).map((f) => ({ sha256: f.sha256, url: `https://blob/${f.sha256}` })) });
    if (u === '/api/ingest/complete') return opts.complete ? opts.complete(body) : Response.json({ titles: {} });
    return opts.put ? opts.put(u) : new Response(null, { status: 200 });
  });
  return { calls, fetch: f as unknown as typeof fetch };
}
const io = (fetch: typeof globalThis.fetch): IngestIo => ({
  fetch, hash: async (b) => `h${(b as File).name}`,
  toAdf: (async (name: string, bytes: Uint8Array) => ({ ok: true, from: 'adf', name, bytes, note: undefined })) as never,
  inspectHfe: (() => ({ ok: true })) as never,
});
function collect() {
  let rows: LibRow[] = [];
  return { emit: (fn: (r: LibRow[]) => LibRow[]) => { rows = fn(rows); }, rows: () => rows };
}

describe('runLibraryIngest', () => {
  it('checks, presigns and uploads only the missing disk, completes both, and settles each row', async () => {
    const s = server({ missing: ['hA.adf'] });
    const c = collect();
    const out = await runLibraryIngest([file('A.adf'), file('B.adf'), file('notes.txt')], io(s.fetch), c.emit);
    expect(s.calls).toEqual(['POST /api/ingest/check', 'POST /api/ingest/presign', 'PUT blob', 'POST /api/ingest/complete']);
    expect(c.rows().map((r) => [r.name, r.state])).toEqual([['A.adf', 'done'], ['B.adf', 'deduped']]);
    expect(out.shas).toEqual(['hA.adf', 'hB.adf']);
    expect([...out.final]).toEqual([['hB.adf', 'deduped'], ['hA.adf', 'done']]);
  });
  it('a 409 /complete with rejectedReasons fails that row with its note and keeps the others', async () => {
    const s = server({ missing: [], complete: () => Response.json({ created: 0, rejectedReasons: { 'hA.adf': 'not a disk' } }, { status: 409 }) });
    const c = collect();
    await runLibraryIngest([file('A.adf'), file('B.adf')], io(s.fetch), c.emit);
    expect(c.rows().map((r) => [r.name, r.state, r.note ?? null])).toEqual([['A.adf', 'failed', 'not a disk'], ['B.adf', 'deduped', null]]);
  });
  it('a PUT that throws fails only that file; a 403 PUT asks for a fresh URL once', async () => {
    let n = 0;
    const s = server({ missing: ['hA.adf', 'hB.adf'], put: (u) => {
      if (u.endsWith('hA.adf')) throw new Error('network');
      return new Response(null, { status: n++ === 0 ? 403 : 200 });
    } });
    const c = collect();
    await runLibraryIngest([file('A.adf'), file('B.adf')], io(s.fetch), c.emit);
    expect(c.rows().map((r) => [r.name, r.state])).toEqual([['A.adf', 'failed'], ['B.adf', 'done']]);
    expect(s.calls.filter((x) => x === 'POST /api/ingest/presign')).toHaveLength(2);
  });
  it('a file of an unuploadable size fails before batching, with the words, and a /check failure fails the group', async () => {
    const c = collect();
    await runLibraryIngest([file('Empty.adf', 0)], io(server({ missing: [] }).fetch), c.emit);
    expect(c.rows()[0]).toMatchObject({ state: 'failed', note: expect.any(String) });
    const broken = vi.fn(async () => new Response('no', { status: 500 })) as unknown as typeof fetch;
    const d = collect();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await runLibraryIngest([file('A.adf')], io(broken), d.emit);
    expect(d.rows()[0].state).toBe('failed');
  });
  it('a disk toAdf cannot read is a failed row with its reason, keyed by filename, and never hashed', async () => {
    const s = server({ missing: [] });
    const c = collect();
    const refusing: IngestIo = { ...io(s.fetch), toAdf: (async () => ({ ok: false, reason: 'not a DMS' })) as never };
    const out = await runLibraryIngest([file('Bad.dms')], refusing, c.emit);
    expect(c.rows()).toMatchObject([{ key: 'lib:bad:Bad.dms', state: 'failed', note: 'not a DMS' }]);
    expect(out.shas).toEqual([]);
    expect(s.calls).toEqual([]);
  });
});

describe('suggestSet', () => {
  const outcome = (final: Array<[string, LibState]>, paths: Array<[string, string]> = []): IngestOutcome =>
    ({ shas: final.map(([s]) => s), paths: new Map(paths), final: new Map(final), since: '2026-10-29T00:00:00.000Z' });
  it('asks only for two or more settled disks, with their paths, and returns the route answer', async () => {
    const f = vi.fn(async () => Response.json({ suggestion: { name: 'Set', disks: [] } })) as unknown as typeof fetch;
    expect(await suggestSet(outcome([['a', 'done'], ['b', 'failed']]), { fetch: f })).toBeNull();
    expect(f).not.toHaveBeenCalled();
    const got = await suggestSet(outcome([['a', 'done'], ['b', 'deduped']], [['a', 'Set/a.adf']]), { fetch: f });
    expect(got).toEqual({ name: 'Set', disks: [] });
    const body = JSON.parse((f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1].body as string);
    expect(body).toEqual({ sha256s: ['a', 'b'], since: '2026-10-29T00:00:00.000Z', paths: { a: 'Set/a.adf' } });
  });
  it('sends at most 32 hashes, and a failed call or non-200 is no suggestion', async () => {
    const many = Array.from({ length: 40 }, (_, i) => [`s${i}`, 'done'] as [string, LibState]);
    const f = vi.fn(async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
    expect(await suggestSet(outcome(many), { fetch: f })).toBeNull();
    const body = JSON.parse((f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1].body as string);
    expect(body.sha256s).toHaveLength(32);
    const thrown = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await suggestSet(outcome(many), { fetch: thrown })).toBeNull();
  });
});
