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
  await seedDisk('g1', 'SysInfo', 'd1', adf);
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
});
