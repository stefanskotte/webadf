import { describe, it, expect, vi, afterEach } from 'vitest';
import type { DroppedItem } from '@/lib/drop-reader';
import type { OpItem } from '@/lib/files/driver';
import { uploadToStash } from './use-stash-upload';

/**
 * uploadToStash against a fetch that answers like the three STASH: routes and the blob store: presign gives a URL for
 * every sha asked, a PUT answers 200 unless told otherwise, and each commit takes its answer from `commits` in turn
 * (by default every top is written).
 */
type Entry = { path: string; kind: 'file' | 'dir'; sha256?: string; sizeBytes: number };
type CommitAnswer = (entries: Entry[]) => { status: number; body: unknown };

const NOT_WHOLE = 'upload did not arrive whole';
const topsOf = (entries: Entry[]) => [...new Set(entries.map((e) => e.path.split('/')[0]))];
const allOk: CommitAnswer = (entries) => ({ status: 200, body: { items: topsOf(entries).map((source) => ({ source, ok: true })) } });

function server({ commits = [], presigns = [], putStatus = () => 200 }: {
  commits?: CommitAnswer[]; presigns?: ({ status: number; body: unknown } | null)[]; putStatus?: (url: string) => number;
} = {}) {
  const log = { presign: [] as string[][], put: [] as string[], commit: [] as Entry[][] };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'PUT') {
      log.put.push(url);
      return new Response('', { status: putStatus(url) });
    }
    const body = JSON.parse(String(init.body));
    if (url === '/api/files/stash/presign') {
      const shas = (body.files as { sha256: string }[]).map((f) => f.sha256);
      log.presign.push(shas);
      const forced = presigns.shift();
      if (forced) return Response.json(forced.body, { status: forced.status });
      return Response.json({ uploads: shas.map((sha256) => ({ sha256, url: `put://${sha256}` })) });
    }
    if (url === '/api/files/stash/commit') {
      log.commit.push(body.entries);
      const a = (commits.shift() ?? allOk)(body.entries);
      return Response.json(a.body, { status: a.status });
    }
    throw new Error(`unexpected ${url}`);
  }));
  return log;
}

const file = (path: string, content: string): DroppedItem => {
  const f = new File([content], path.split('/').pop()!);
  return { path, kind: 'file', file: f, sizeBytes: f.size };
};
/** `n` one-byte files: 200 to a commit, so 450 make three batches (200, 200, 50). */
const many = (n: number) => Array.from({ length: n }, (_, i) => file(`f${i}`, 'x'));
const notWhole = (source: string): OpItem => ({ source, ok: false, refusal: { code: 'failed', detail: NOT_WHOLE } });

afterEach(() => vi.unstubAllGlobals());

describe('uploadToStash', () => {
  it('sends a top the server found not whole once more, and takes the second answer', async () => {
    const log = server({ commits: [
      () => ({ status: 200, body: { items: [notWhole('a'), { source: 'b', ok: true }] } }),
      () => ({ status: 200, body: { items: [{ source: 'a', ok: true }] } }),
    ] });
    const r = await uploadToStash('STASH:', [file('a', 'aaa'), file('b', 'bbb')], 'ask');
    expect(r.items).toEqual([{ source: 'a', ok: true }, { source: 'b', ok: true }]);
    expect(r.stopped).toBeNull();
    expect(log.commit.map(topsOf)).toEqual([['a', 'b'], ['a']]);
    expect(log.presign).toHaveLength(2);
    expect(log.put).toHaveLength(3);   // a, b, then a again
  });

  it('tries only once: not whole twice stays refused', async () => {
    const log = server({ commits: [
      () => ({ status: 200, body: { items: [notWhole('a')] } }),
      () => ({ status: 200, body: { items: [notWhole('a')] } }),
    ] });
    const r = await uploadToStash('STASH:', [file('a', 'aaa')], 'ask');
    expect(r.items).toEqual([notWhole('a')]);
    expect(log.commit).toHaveLength(2);
  });

  it('keeps the first commit\'s answers when the retry\'s presign is refused', async () => {
    server({
      commits: [() => ({ status: 200, body: { items: [notWhole('a'), { source: 'b', ok: true }] } })],
      presigns: [null, { status: 503, body: { error: 'blob store rate limited, retry this batch' } }],
    });
    const r = await uploadToStash('STASH:', [file('a', 'aaa'), file('b', 'bbb')], 'ask');
    expect(r.items).toEqual([notWhole('a'), { source: 'b', ok: true }]);
    expect(r.stopped).toBe('Something went wrong.');
  });

  it('a clash mid-way returns what is done, the clashes, and every item not yet written', async () => {
    const clashes = [{ source: 'f200', name: 'f200', dest: 'STASH:' }];
    const log = server({ commits: [allOk, () => ({ status: 409, body: { error: 'clashes', clashes } })] });
    const r = await uploadToStash('STASH:', many(450), 'ask');
    expect(r.items).toHaveLength(200);
    expect(r.clashes).toEqual(clashes);
    expect(r.rest!.map((i) => i.path)).toEqual(many(450).slice(200).map((i) => i.path));
    expect(log.commit).toHaveLength(2);
    expect(log.put).toHaveLength(2);   // one sha: one PUT a batch
  });

  it('a top whose PUT failed is left out of the commit and said', async () => {
    const files = [file('a', 'aaa'), file('D/b', 'bbb'), file('D/c', 'ccc')];
    let bad = '';
    const log = server({ putStatus: (url) => (url === bad ? 500 : 200) });
    const { hashBlob } = await import('@/lib/browser-hash');
    bad = `put://${await hashBlob(files[2].file!)}`;
    const r = await uploadToStash('STASH:', files, 'ask');
    expect(log.commit.map(topsOf)).toEqual([['a']]);
    expect(r.items).toEqual([{ source: 'a', ok: true }]);
    expect(r.refused).toEqual([{ path: 'D', why: 'the upload failed' }]);
  });

  it('a refusal that stops the drop lists every top it left unwritten', async () => {
    server({ commits: [allOk, () => ({ status: 409, body: { error: 'stash_full' } })] });
    const r = await uploadToStash('STASH:', many(450), 'ask');
    expect(r.items).toHaveLength(200);
    expect(r.stopped).toBe('STASH: holds 500 files / 256 MB; delete some first.');
    expect(r.refused.map((x) => x.path)).toEqual(many(450).slice(200).map((i) => i.path));
    expect(new Set(r.refused.map((x) => x.why))).toEqual(new Set(['not sent — the drop stopped']));
  });

  it('presigns only non-empty files, once per sha; an empty file and a folder go straight to the commit', async () => {
    const log = server();
    const r = await uploadToStash('STASH:', [file('README', ''), { path: 'Empty', kind: 'dir', sizeBytes: 0 },
      file('a', 'same'), file('b', 'same')], 'ask');
    expect(log.presign).toHaveLength(1);
    expect(log.presign[0]).toHaveLength(1);
    expect(log.commit[0].find((e) => e.path === 'README')).toEqual({ path: 'README', kind: 'file', sizeBytes: 0, lastModified: expect.any(Number) });
    expect(r.items.map((i) => i.source)).toEqual(['README', 'Empty', 'a', 'b']);
  });
});
