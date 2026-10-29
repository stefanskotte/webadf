// src/app/api/files/files-api.db.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Client } from 'pg';

// applyDiskEdit passes through untouched unless a test queues an outcome with `seam.next`.
const seam = vi.hoisted(() => ({ next: null as null | { ok: false; status: number; reason: string } }));
vi.mock('@/lib/disk-write', async (importOriginal) => {
  const m = await importOriginal<typeof import('@/lib/disk-write')>();
  return {
    ...m,
    applyDiskEdit: async (...a: Parameters<typeof m.applyDiskEdit>) => {
      const o = seam.next;
      if (o) { seam.next = null; return o as never; }
      return m.applyDiskEdit(...a);
    },
  };
});

// findHolder runs inside loadDisk after the image is read, so a failure there is a database error, not a missing blob.
const holderSeam = vi.hoisted(() => ({ fail: false }));
vi.mock('@/lib/disk-holder', async (importOriginal) => {
  const m = await importOriginal<typeof import('@/lib/disk-holder')>();
  return { ...m, findHolder: async (...a: Parameters<typeof m.findHolder>) => { if (holderSeam.fail) throw new Error('db down'); return m.findHolder(...a); } };
});

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_files_api_test';
const url = new URL(base); url.pathname = `/${DB}`; process.env.DATABASE_URL = url.toString();
process.env.STORAGE_DIR ??= (await import('node:fs')).mkdtempSync('/tmp/webadf-files-api-');
process.env.BLOB_READ_WRITE_TOKEN = '';
process.env.BETTER_AUTH_SECRET = 'files-api-test-secret';
process.env.BETTER_AUTH_URL = 'https://me.example';
async function admin(stmt: string) { const c = new Client({ connectionString: base }); await c.connect(); try { await c.query(stmt); } finally { await c.end(); } }

let session = { orgId: 'o1', userId: 'u1', email: 'a@b.test' };
vi.mock('@/lib/session', () => ({ requireOrg: async () => session }));
const asOrg = (orgId: string) => { session = { ...session, orgId }; };

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { createHash } = await import('node:crypto');
const { games, disks, entitlements, blobs } = await import('@/db/schema/catalog');
const { organization } = await import('@/db/schema/auth');
const { diskStore } = await import('@/lib/storage');
const { formatVolume } = await import('@/lib/adffs/format');
const { addFile, makeDirectory } = await import('@/lib/adffs/write');
const { ROOT_BLOCK } = await import('@/lib/adffs/constants');
const { GET: GET_LIST } = await import('./list/route');
const { POST: POST_OPS } = await import('./ops/route');
const { GET: GET_DL } = await import('./download/route');

const { readVolume } = await import('@/lib/adffs');
const { unzipSync, strFromU8 } = await import('fflate');
/** A root folder's block, for adding into it. */
const resolveRoot = (adf: Uint8Array, name: string) => {
  const v = readVolume(adf); if (!v.ok) throw new Error('no volume');
  return v.root.find((e) => e.name === name)!.block;
};
const must = (r: { ok: true; adf: Uint8Array } | { ok: false; reason: string }) => { if (!r.ok) throw new Error(r.reason); return r.adf; };
const req = (p: string) => new Request('http://localhost' + p);
const json = (body: unknown) => new Request('http://localhost/api/files/ops', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

async function seedDisk(gameId: string, title: string, diskId: string, adf: Uint8Array, store = true) {
  const sha = createHash('sha256').update(adf).digest('hex');
  if (store) await diskStore.put(sha, adf);
  const db = getDb();
  await db.insert(blobs).values({ sha256: sha, sizeBytes: adf.length, storageKey: `adf/${sha}` }).onConflictDoNothing();
  await db.insert(entitlements).values({ orgId: 'o1', sha256: sha, sourceFilename: `${title}.adf` }).onConflictDoNothing();
  await db.insert(games).values({ id: gameId, orgId: 'o1', title, sortTitle: title.toLowerCase() }).onConflictDoNothing();
  await db.insert(disks).values({ id: diskId, gameId, orgId: 'o1', diskNo: 1, sha256: sha, sizeBytes: adf.length });
}

beforeAll(async () => {
  await admin(`drop database if exists ${DB} with (force)`);
  await admin(`create database ${DB}`);
  await migrate(getDb(), { migrationsFolder: 'drizzle' });
  await getDb().insert(organization).values([{ id: 'o1', name: 'o1', slug: 'o1', createdAt: new Date() }, { id: 'o2', name: 'o2', slug: 'o2', createdAt: new Date() }]);
  let adf = formatVolume({ filesystem: 'FFS', volumeName: 'SysInfo' });
  adf = must(makeDirectory(adf, ROOT_BLOCK, 'C'));
  adf = must(addFile(adf, ROOT_BLOCK, 'ReadMe', new TextEncoder().encode('hello')));
  adf = must(addFile(adf, ROOT_BLOCK, "it's(1).txt", new TextEncoder().encode('q')));
  await seedDisk('g1', 'SysInfo', 'd1', adf);
  let other = formatVolume({ filesystem: 'OFS', volumeName: 'Other' });
  other = must(addFile(other, ROOT_BLOCK, 'Other.txt', new TextEncoder().encode('other')));
  other = must(makeDirectory(other, ROOT_BLOCK, 'S'));
  const s = resolveRoot(other, 'S');
  other = must(addFile(other, s, 'Startup', new TextEncoder().encode('echo hi')));
  await seedDisk('g2', 'Other', 'd2', other);
  await seedDisk('g3', 'Gone', 'd3', formatVolume({ filesystem: 'OFS', volumeName: 'Gone' }), false);
});
afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

describe('/api/files', () => {
  it('lists, refuses a bad path, and 404s a foreign one', async () => {
    expect((await GET_LIST(req('/api/files/list?path=LIBRARY:/g1'))).status).toBe(200);
    expect((await GET_LIST(req('/api/files/list?path=nope'))).status).toBe(400);
    expect((await GET_LIST(req('/api/files/list'))).status).toBe(400);
    asOrg('o2');
    expect((await GET_LIST(req('/api/files/list?path=LIBRARY:/g1'))).status).toBe(404);
    asOrg('o1');
  });
  it('ops: clashes are 409 with the list; a refusal carries its code; a body that is not an op is 400', async () => {
    const clash = await POST_OPS(json({ op: 'copy', sources: ['LIBRARY:/g1/d1/ReadMe'], dest: 'LIBRARY:/g1/d1', onClash: 'ask' }));
    expect(clash.status).toBe(409);
    expect((await clash.json()).error).toBe('clashes');
    expect((await POST_OPS(json({ op: 'makedir', dest: 'LIBRARY:/g1/d1', name: 'a/b' }))).status).toBe(400);
    expect((await POST_OPS(json({ op: 'explode' }))).status).toBe(400);
    expect((await POST_OPS(new Request('http://localhost/api/files/ops', { method: 'POST', body: 'not json' }))).status).toBe(400);
    const ok = await POST_OPS(json({ op: 'makedir', dest: 'LIBRARY:/g1/d1', name: 'Made' }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).items).toEqual([expect.objectContaining({ ok: true })]);
  });
  it('conflict maps to 409 conflict', async () => {
    seam.next = { ok: false, status: 409, reason: 'conflict' };
    const r = await POST_OPS(json({ op: 'makedir', dest: 'LIBRARY:/g1/d1', name: 'New' }));
    expect([r.status, (await r.json()).error]).toEqual([409, 'conflict']);
  });
  it('downloads one file with its name', async () => {
    const r = await GET_DL(req('/api/files/download?path=' + encodeURIComponent('LIBRARY:/g1/d1/ReadMe')));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toContain("filename*=UTF-8''ReadMe");
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
    expect(new TextDecoder().decode(await r.arrayBuffer())).toBe('hello');
  });
  it('download: bad path 400, folder or unknown 404, missing blob 503', async () => {
    const dl = (p: string) => GET_DL(req('/api/files/download?path=' + encodeURIComponent(p)));
    expect((await dl('nope')).status).toBe(400);
    expect((await dl('LIBRARY:/g1/d1/C')).status).toBe(404);
    expect((await dl('LIBRARY:/g1/d1/Nothing')).status).toBe(404);
    const gone = await dl('LIBRARY:/g3/d3/x');
    expect([gone.status, (await gone.json()).error]).toEqual([503, 'blob_unavailable']);
  });
  it('list: a missing blob is 503 blob_unavailable', async () => {
    const r = await GET_LIST(req('/api/files/list?path=LIBRARY:/g3/d3'));
    expect([r.status, (await r.json()).error]).toEqual([503, 'blob_unavailable']);
  });
  it('download: the filename is strict RFC 5987', async () => {
    const r = await GET_DL(req('/api/files/download?path=' + encodeURIComponent("LIBRARY:/g1/d1/it's(1).txt")));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toContain("filename*=UTF-8''it%27s%281%29.txt");
  });
  it('another org gets 404 from ops and download', async () => {
    asOrg('o2');
    try {
      const o = await POST_OPS(json({ op: 'makedir', dest: 'LIBRARY:/g1/d1', name: 'Nope' }));
      expect([o.status, (await o.json()).error]).toEqual([404, 'not_found']);
      expect((await GET_DL(req('/api/files/download?path=' + encodeURIComponent('LIBRARY:/g1/d1/ReadMe')))).status).toBe(404);
    } finally { asOrg('o1'); }
  });
  it('downloads several paths across disks as one zip, folders with their contents', async () => {
    const q = ['LIBRARY:/g1/d1/ReadMe', 'LIBRARY:/g2/d2/Other.txt', 'LIBRARY:/g2/d2/S', 'LIBRARY:/g2/d2/S/Startup']
      .map((p) => 'paths=' + encodeURIComponent(p)).join('&');
    const r = await GET_DL(req(`/api/files/download?${q}&name=Disk%201`));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/zip');
    expect(r.headers.get('content-disposition')).toContain("filename*=UTF-8''Disk%201.zip");
    const files = unzipSync(new Uint8Array(await r.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(['Other.txt', 'ReadMe', 'S/', 'S/Startup']);
    expect(strFromU8(files['ReadMe'])).toBe('hello');
    expect(strFromU8(files['Other.txt'])).toBe('other');
    expect(strFromU8(files['S/Startup'])).toBe('echo hi');
  });
  it('zip download: foreign or unknown path 404, bad path 400, too many 413, missing blob 503', async () => {
    const dl = (...ps: string[]) => GET_DL(req('/api/files/download?' + ps.map((p) => 'paths=' + encodeURIComponent(p)).join('&')));
    expect((await dl('LIBRARY:/g1/d1/ReadMe', 'LIBRARY:/g1/d1/Nothing')).status).toBe(404);
    expect((await dl('LIBRARY:/g1/d1')).status).toBe(404);
    expect((await dl('nope')).status).toBe(400);
    asOrg('o2');
    try { expect((await dl('LIBRARY:/g1/d1/ReadMe', 'LIBRARY:/g2/d2/Other.txt')).status).toBe(404); } finally { asOrg('o1'); }
    const many = await dl(...Array.from({ length: 1001 }, () => 'LIBRARY:/g1/d1/ReadMe'));
    expect([many.status, (await many.json()).error]).toEqual([413, 'too_large']);
    const gone = await dl('LIBRARY:/g3/d3/x');
    expect([gone.status, (await gone.json()).error]).toEqual([503, 'blob_unavailable']);
  });
  it('a database error is not reported as blob_unavailable', async () => {
    holderSeam.fail = true;
    try {
      await expect(GET_LIST(req('/api/files/list?path=LIBRARY:/g1/d1'))).rejects.toThrow('db down');
      await expect(GET_DL(req('/api/files/download?path=' + encodeURIComponent('LIBRARY:/g1/d1/ReadMe')))).rejects.toThrow('db down');
      await expect(POST_OPS(json({ op: 'makedir', dest: 'LIBRARY:/g1/d1', name: 'X' }))).rejects.toThrow('db down');
    } finally { holderSeam.fail = false; }
  });
});
