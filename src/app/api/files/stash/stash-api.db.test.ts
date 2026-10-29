// src/app/api/files/stash/stash-api.db.test.ts
// STASH: from the browser (Files increment 2, Task 6): presign, commit, Paste URL.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Client } from 'pg';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_stash_api_test';
const url = new URL(base); url.pathname = `/${DB}`; process.env.DATABASE_URL = url.toString();
process.env.STORAGE_DIR ??= (await import('node:fs')).mkdtempSync('/tmp/webadf-stash-api-');
process.env.BLOB_READ_WRITE_TOKEN = '';
process.env.BETTER_AUTH_SECRET = 'stash-api-test-secret';
process.env.BETTER_AUTH_URL = 'https://me.example';
async function admin(stmt: string) { const c = new Client({ connectionString: base }); await c.connect(); try { await c.query(stmt); } finally { await c.end(); } }

let session = { orgId: 'o1', userId: 'u1', email: 'a@b.test' };
vi.mock('@/lib/session', () => ({ requireOrg: async () => session }));
const asOrg = (orgId: string) => { session = { ...session, orgId }; };
vi.mock('@/lib/url-fetch', async (o) => ({ ...(await o<typeof import('@/lib/url-fetch')>()), fetchUrlSafely: vi.fn() }));
const limit = vi.hoisted(() => ({ ok: true }));
vi.mock('@/lib/url-fetch-limit', () => ({ takeUrlFetch: () => (limit.ok ? { ok: true } : { ok: false, retryAfterMs: 30_000 }) }));

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { createHash } = await import('node:crypto');
const { organization } = await import('@/db/schema/auth');
const { blobs } = await import('@/db/schema/catalog');
const { diskStore } = await import('@/lib/storage');
const { listStash } = await import('@/lib/stash');
const { fetchUrlSafely } = await import('@/lib/url-fetch');
const { POST: PRESIGN } = await import('./presign/route');
const { POST: COMMIT } = await import('./commit/route');
const { POST: URL_POST } = await import('./url/route');

const json = (path: string, body: unknown) => new Request(`http://x${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const bytes = new TextEncoder().encode('hello stash');
const sha = createHash('sha256').update(bytes).digest('hex');
const commit = (entries: unknown[], onClash = 'ask', dir = 'STASH:') => COMMIT(json('/api/files/stash/commit', { dir, onClash, entries }));
const rowsAt = async (orgId: string, path: string) => (await listStash(getDb(), orgId)).filter((x) => x.path === path);

beforeAll(async () => {
  await admin(`drop database if exists ${DB} with (force)`);
  await admin(`create database ${DB}`);
  await migrate(getDb(), { migrationsFolder: 'drizzle' });
  await getDb().insert(organization).values([{ id: 'o1', name: 'o1', slug: 'o1', createdAt: new Date() }, { id: 'o2', name: 'o2', slug: 'o2', createdAt: new Date() }]);
});
afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

describe('/api/files/stash', () => {
  it('presign answers a URL only for blobs not yet stored', async () => {
    const r = await PRESIGN(json('/api/files/stash/presign', { files: [{ sha256: sha, sizeBytes: bytes.length }] }));
    expect((await r.json()).uploads).toEqual([{ sha256: sha, url: expect.any(String) }]);
    await diskStore.put(sha, bytes);   // what the browser's PUT does
    expect((await (await PRESIGN(json('/api/files/stash/presign', { files: [{ sha256: sha, sizeBytes: bytes.length }] }))).json()).uploads).toEqual([]);
  });
  it('presign takes only non-empty files, one URL per sha-256, and refuses what is over 20 MB or not a digest', async () => {
    const other = 'd'.repeat(64);
    const r = await PRESIGN(json('/api/files/stash/presign', { files: [{ sha256: other, sizeBytes: 5 }, { sha256: other, sizeBytes: 5 }] }));
    expect((await r.json()).uploads).toEqual([{ sha256: other, url: expect.any(String) }]);
    for (const files of [[{ sha256: other, sizeBytes: 0 }], [{ sha256: other, sizeBytes: 20 * 1024 * 1024 + 1 }], [{ sha256: 'XYZ', sizeBytes: 5 }], []]) {
      expect((await PRESIGN(json('/api/files/stash/presign', { files }))).status).toBe(400);
    }
  });
  it('commit stores a dropped folder with its file date', async () => {
    const r = await commit([
      { path: 'Drop', kind: 'dir', sizeBytes: 0 },
      { path: 'Drop/hello.txt', kind: 'file', sha256: sha, sizeBytes: bytes.length, lastModified: Date.UTC(2024, 1, 3) }]);
    expect(r.status).toBe(200);
    expect((await r.json()).items).toEqual([{ source: 'Drop', ok: true }]);
    const [row] = await rowsAt('o1', 'Drop/hello.txt');
    expect([row.source, row.date?.toISOString(), row.blobSha256]).toEqual(['browser', '2024-02-03T00:00:00.000Z', sha]);
    expect((await rowsAt('o1', 'Drop'))[0]).toMatchObject({ kind: 'dir', source: 'browser' });
  });
  it('commit cleans a long name to 30 characters', async () => {
    const long = 'A very long file name from Windows 11.txt';
    const r = await commit([{ path: long, kind: 'file', sha256: sha, sizeBytes: bytes.length }]);
    const body = await r.json();
    expect(body.renamed[0].from).toBe(long);
    expect(body.renamed[0].to.length).toBeLessThanOrEqual(30);
    expect(body.renamed[0].to.endsWith('.txt')).toBe(true);
    expect(await rowsAt('o1', body.renamed[0].to)).toHaveLength(1);
  });
  it('commit refuses a size that does not match, bytes that do not hash, and a batch over 64 MB', async () => {
    const wrong = await commit([{ path: 'w.txt', kind: 'file', sha256: sha, sizeBytes: 3 }]);
    expect((await wrong.json()).items[0]).toMatchObject({ ok: false, refusal: { code: 'failed', detail: 'upload did not arrive whole' } });
    expect(await diskStore.stat(sha)).not.toBeNull();   // authentic bytes, wrongly described: kept
    const fake = 'c'.repeat(64); await diskStore.put(fake, bytes);
    const forged = await commit([{ path: 'f.txt', kind: 'file', sha256: fake, sizeBytes: bytes.length }]);
    expect((await forged.json()).items[0]).toMatchObject({ ok: false, refusal: { code: 'failed' } });
    // Ruling 2: the poisoned key is freed, so presign does not skip it forever.
    expect(await diskStore.stat(fake)).toBeNull();
    expect((await (await PRESIGN(json('/api/files/stash/presign', { files: [{ sha256: fake, sizeBytes: 5 }] }))).json()).uploads).toHaveLength(1);
    const big = await commit(Array.from({ length: 4 }, (_, i) => ({ path: `b${i}`, kind: 'file', sha256: sha, sizeBytes: 20 * 1024 * 1024 })));
    expect([big.status, (await big.json())]).toEqual([413, { error: 'too_large', detail: '64 MB at a time' }]);
    const many = await commit(Array.from({ length: 201 }, (_, i) => ({ path: `m${i}`, kind: 'dir', sizeBytes: 0 })));
    expect(many.status).toBe(413);
    expect(await rowsAt('o1', 'w.txt')).toEqual([]);
    expect(await rowsAt('o1', 'f.txt')).toEqual([]);
  });
  it('commit: forged bytes of a different size are released too; a store error is not "did not arrive whole"', async () => {
    const fake = 'a'.repeat(64);
    await diskStore.put(fake, new TextEncoder().encode('a different length entirely'));
    const r = await commit([{ path: 'g.txt', kind: 'file', sha256: fake, sizeBytes: 4 }]);
    expect((await r.json()).items[0]).toMatchObject({ ok: false, refusal: { code: 'failed', detail: 'upload did not arrive whole' } });
    expect(await diskStore.stat(fake)).toBeNull();
    expect((await (await PRESIGN(json('/api/files/stash/presign', { files: [{ sha256: fake, sizeBytes: 4 }] }))).json()).uploads).toHaveLength(1);
    const read = vi.spyOn(diskStore, 'read').mockRejectedValueOnce(new Error('store down'));
    try {
      await expect(commit([{ path: 'h.txt', kind: 'file', sha256: sha, sizeBytes: bytes.length }])).rejects.toThrow('store down');
    } finally { read.mockRestore(); }
    const stat = vi.spyOn(diskStore, 'stat').mockRejectedValueOnce(new Error('stat down'));
    try {
      await expect(commit([{ path: 'h.txt', kind: 'file', sha256: sha, sizeBytes: bytes.length }])).rejects.toThrow('stat down');
    } finally { stat.mockRestore(); }
    expect(await rowsAt('o1', 'h.txt')).toEqual([]);
  });
  it('commit: a blob over 20 MB is refused without being read; released unless something names it', async () => {
    const huge = new Uint8Array(20 * 1024 * 1024 + 1);
    const loose = '1'.repeat(64); const named = '2'.repeat(64);
    await diskStore.put(loose, huge); await diskStore.put(named, huge);
    await getDb().insert(blobs).values({ sha256: named, sizeBytes: huge.length, storageKey: `adf/${named}` });
    const read = vi.spyOn(diskStore, 'read');
    try {
      for (const key of [loose, named]) {
        const r = await commit([{ path: 'tiny.txt', kind: 'file', sha256: key, sizeBytes: 4 }]);
        expect([r.status, (await r.json()).items[0]]).toEqual([200, { source: 'tiny.txt', ok: false, refusal: { code: 'failed', detail: 'upload did not arrive whole' } }]);
      }
      expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
    expect(await diskStore.stat(loose)).toBeNull();
    expect(await diskStore.stat(named)).not.toBeNull();
    expect(await rowsAt('o1', 'tiny.txt')).toEqual([]);
  });
  it('commit: an absurd lastModified is a 400, not an Invalid Date', async () => {
    for (const lastModified of [9e15, -1, 1.5]) {
      expect((await commit([{ path: 'd.txt', kind: 'file', sha256: sha, sizeBytes: bytes.length, lastModified }])).status).toBe(400);
    }
  });
  it('commit: a blob never uploaded fails that item; the others in the batch are stored', async () => {
    const r = await commit([
      { path: 'Missing.txt', kind: 'file', sha256: 'e'.repeat(64), sizeBytes: 4 },
      { path: 'Here.txt', kind: 'file', sha256: sha, sizeBytes: bytes.length }]);
    const body = await r.json();
    expect(body.items).toEqual([
      { source: 'Missing.txt', ok: false, refusal: { code: 'failed', detail: 'upload did not arrive whole' } },
      { source: 'Here.txt', ok: true }]);
  });
  it('commit stores an empty file and an empty folder without any upload (ruling 15)', async () => {
    const r = await commit([
      { path: 'Pack', kind: 'dir', sizeBytes: 0 },
      { path: 'Pack/README', kind: 'file', sizeBytes: 0 },
      { path: 'Pack/Empty', kind: 'dir', sizeBytes: 0 }]);
    expect((await r.json()).items).toEqual([{ source: 'Pack', ok: true }]);
    const [readme] = await rowsAt('o1', 'Pack/README');
    expect([readme.sizeBytes, readme.blobSha256]).toEqual([0, createHash('sha256').update(new Uint8Array(0)).digest('hex')]);
    expect((await rowsAt('o1', 'Pack/Empty'))[0].kind).toBe('dir');
  });
  it('commit reports names cleaned only for what it stored; a file and a folder of one name are refused', async () => {
    const r = await commit([{ path: 'Tom:Jerry.txt', kind: 'file', sha256: 'e'.repeat(64), sizeBytes: 4 },
      { path: 'Twin', kind: 'file', sha256: sha, sizeBytes: bytes.length }, { path: 'twin/x', kind: 'dir', sizeBytes: 0 }]);
    const body = await r.json();
    expect(body.renamed).toEqual([]);
    expect(body.items.map((i: { ok: boolean; refusal?: { code: string } }) => i.refusal?.code)).toEqual(['failed', 'name_exists']);
  });
  it('commit refuses a name that cleans to nothing, and a file without its sha-256', async () => {
    const r = await commit([{ path: '\u0001\u0002', kind: 'file', sha256: sha, sizeBytes: bytes.length }, { path: 'NoSha.txt', kind: 'file', sizeBytes: 4 }]);
    const items = (await r.json()).items;
    expect(items[0]).toMatchObject({ ok: false, refusal: { code: 'bad_name' } });
    expect(items[1]).toMatchObject({ ok: false, refusal: { code: 'failed' } });
  });
  it('commit asks on a clash and writes nothing; keep-both reports the name it stored', async () => {
    const r = await commit([{ path: 'Drop', kind: 'dir', sizeBytes: 0 }, { path: 'Drop/new.txt', kind: 'file', sha256: sha, sizeBytes: bytes.length }]);
    expect(r.status).toBe(409);
    expect((await r.json())).toEqual({ error: 'clashes', clashes: [{ source: 'Drop', name: 'Drop', dest: 'STASH:' }] });
    expect(await rowsAt('o1', 'Drop/new.txt')).toEqual([]);
    const kb = await commit([{ path: 'Drop', kind: 'dir', sizeBytes: 0 }], 'keep-both');
    expect((await kb.json()).renamed).toEqual([{ from: 'Drop', to: 'Drop_1' }]);
  });
  it('commit into a folder; an unknown, foreign, archive or non-STASH: folder is refused; a bad body is 400', async () => {
    expect((await commit([{ path: 'in.txt', kind: 'file', sha256: sha, sizeBytes: bytes.length }], 'ask', 'STASH:/Drop')).status).toBe(200);
    expect(await rowsAt('o1', 'Drop/in.txt')).toHaveLength(1);
    expect((await commit([{ path: 'x', kind: 'dir', sizeBytes: 0 }], 'ask', 'STASH:/Nope')).status).toBe(404);
    expect((await commit([{ path: 'x', kind: 'dir', sizeBytes: 0 }], 'ask', 'LIBRARY:/g1/d1')).status).toBe(400);
    asOrg('o2');
    try {
      expect((await commit([{ path: 'x', kind: 'dir', sizeBytes: 0 }], 'ask', 'STASH:/Drop')).status).toBe(404);
      // Another org's commit of the same name is its own: no clash with o1's Drop.
      expect((await commit([{ path: 'Drop', kind: 'dir', sizeBytes: 0 }])).status).toBe(200);
    } finally { asOrg('o1'); }
    expect((await COMMIT(json('/api/files/stash/commit', { dir: 'STASH:', entries: [] }))).status).toBe(400);
    expect((await COMMIT(new Request('http://x/api/files/stash/commit', { method: 'POST', body: 'nope' }))).status).toBe(400);
  });
  it('a URL is fetched into STASH: under the name the server gave, keep-both on a clash', async () => {
    vi.mocked(fetchUrlSafely).mockResolvedValue({ ok: true, bytes, finalUrl: new URL('https://example.org/x/dl.php'), contentDisposition: 'attachment; filename="Tune.mod"' });
    const first = await URL_POST(json('/api/files/stash/url', { url: 'https://example.org/x/dl.php' }));
    expect([first.status, await first.json()]).toEqual([201, { path: 'STASH:/Tune.mod' }]);
    expect(await (await URL_POST(json('/api/files/stash/url', { url: 'https://example.org/x/dl.php' }))).json()).toEqual({ path: 'STASH:/Tune_1.mod' });
    expect((await rowsAt('o1', 'Tune_1.mod'))[0].source).toBe('browser');
    vi.mocked(fetchUrlSafely).mockResolvedValueOnce({ ok: false, code: 'address_not_allowed' });
    expect((await URL_POST(json('/api/files/stash/url', { url: 'http://10.0.0.1/' }))).status).toBe(400);
  });
  it('a URL: a name that cleans to nothing is "download"; a long one is cleaned; too large 413; rate limited 429; bad body 400', async () => {
    vi.mocked(fetchUrlSafely).mockResolvedValueOnce({ ok: true, bytes, finalUrl: new URL('https://example.org/'), contentDisposition: 'attachment; filename="\u0001"' });
    expect(await (await URL_POST(json('/api/files/stash/url', { url: 'https://example.org/' }))).json()).toEqual({ path: 'STASH:/download' });
    vi.mocked(fetchUrlSafely).mockResolvedValueOnce({ ok: true, bytes, finalUrl: new URL('https://example.org/'), contentDisposition: 'attachment; filename="A very long file name from Windows 11.txt"' });
    const long = (await (await URL_POST(json('/api/files/stash/url', { url: 'https://example.org/' }))).json()).path as string;
    expect(long.slice('STASH:/'.length).length).toBeLessThanOrEqual(30);
    vi.mocked(fetchUrlSafely).mockResolvedValueOnce({ ok: false, code: 'too_large' });
    expect((await URL_POST(json('/api/files/stash/url', { url: 'https://example.org/' }))).status).toBe(413);
    limit.ok = false;
    try {
      const r = await URL_POST(json('/api/files/stash/url', { url: 'https://example.org/' }));
      expect([r.status, r.headers.get('retry-after'), (await r.json()).error]).toEqual([429, '30', 'rate_limited']);
    } finally { limit.ok = true; }
    expect((await URL_POST(json('/api/files/stash/url', { nope: 1 }))).status).toBe(400);
  });
  it('a URL lands in the caller\'s own STASH: only', async () => {
    vi.mocked(fetchUrlSafely).mockResolvedValueOnce({ ok: true, bytes, finalUrl: new URL('https://example.org/Only.txt'), contentDisposition: null });
    asOrg('o2');
    try { expect(await (await URL_POST(json('/api/files/stash/url', { url: 'https://example.org/Only.txt' }))).json()).toEqual({ path: 'STASH:/Only.txt' }); } finally { asOrg('o1'); }
    expect(await rowsAt('o1', 'Only.txt')).toEqual([]);
    expect(await rowsAt('o2', 'Only.txt')).toHaveLength(1);
  });
  it('a URL whose key was poisoned by a PUT never committed stores its own bytes', async () => {
    const real = new TextEncoder().encode('the real tune');
    const key = createHash('sha256').update(real).digest('hex');
    await diskStore.put(key, new TextEncoder().encode('forged!'));
    vi.mocked(fetchUrlSafely).mockResolvedValueOnce({ ok: true, bytes: real, finalUrl: new URL('https://example.org/Real.mod'), contentDisposition: null });
    expect(await (await URL_POST(json('/api/files/stash/url', { url: 'https://example.org/Real.mod' }))).json()).toEqual({ path: 'STASH:/Real.mod' });
    expect(new TextDecoder().decode(await diskStore.read(key))).toBe('the real tune');
  });
  it('every new STASH: route allows 60 s', async () => {
    for (const m of [await import('./presign/route'), await import('./commit/route'), await import('./url/route')]) {
      expect((m as { maxDuration?: number }).maxDuration).toBe(60);
    }
  });
});
