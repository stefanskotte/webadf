// A disk added while a collection is open lands in that collection: /api/ingest/complete and /api/ingest/url file the
// titles they placed. collection_games has no org_id, so a foreign or stale id must file nothing and refuse nothing.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Client } from 'pg';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_ingest_file_into_collection_test';
const url = new URL(base); url.pathname = `/${DB}`; process.env.DATABASE_URL = url.toString();
const storageDir = mkdtempSync(join(tmpdir(), 'webadf-file-into-collection-'));
process.env.STORAGE_DIR = storageDir;
process.env.BLOB_READ_WRITE_TOKEN = '';

vi.mock('next/server', () => ({ after: () => {} }));
vi.mock('@/lib/tosec-sweep', () => ({ sweep: async () => {} }));
vi.mock('@/lib/session', () => ({ requireOrg: async () => ({ orgId: 'o1', userId: 'u1', email: 'a@b.test' }) }));
const ingestFromUrl = vi.fn();
vi.mock('@/lib/url-ingest', () => ({ ingestFromUrl: (...a: unknown[]) => ingestFromUrl(...a) }));
vi.mock('@/lib/url-fetch-limit', () => ({ takeUrlFetch: () => ({ ok: true }) }));

async function admin(stmt: string) { const c = new Client({ connectionString: base }); await c.connect(); try { await c.query(stmt); } finally { await c.end(); } }

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { collections, collectionGames } = await import('@/db/schema/collections');
const { diskStore } = await import('@/lib/storage');
const { POST: complete } = await import('./complete/route');
const { POST: fromUrl } = await import('./url/route');

let seq = 0;
async function file(filename: string) {
  const bytes = new Uint8Array(1024).fill(7);
  bytes.set(new TextEncoder().encode(`seed-${++seq}`));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await diskStore.put(sha256, bytes);
  return { filename, sha256, sizeBytes: bytes.byteLength };
}
const post = (body: unknown) => new Request('http://x/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
type Titles = Record<string, { gameId: string; title: string }>;
const send = async (body: unknown) => {
  const res = await complete(post(body));
  return { status: res.status, titles: ((await res.json()) as { titles?: Titles }).titles ?? {} };
};
const members = async () => (await getDb().select().from(collectionGames)).map((r) => [r.collectionId, r.gameId]);

beforeAll(async () => {
  await admin(`drop database if exists ${DB} with (force)`);
  await admin(`create database ${DB}`);
  await migrate(getDb(), { migrationsFolder: 'drizzle' });
});
beforeEach(async () => {
  await getDb().delete(collectionGames);
  await getDb().delete(collections);
  await getDb().insert(collections).values([
    { id: 'c1', orgId: 'o1', name: 'Utilities', sortKey: 0 },
    { id: 'c2', orgId: 'o1', name: 'Games', sortKey: 1 },
    { id: 'theirs', orgId: 'o2', name: 'Theirs', sortKey: 0 },
  ]);
  ingestFromUrl.mockReset();
});
afterAll(async () => {
  await closeDb();
  await admin(`drop database if exists ${DB} with (force)`);
  rmSync(storageDir, { recursive: true, force: true });
});

describe('POST /api/ingest/complete with a collectionId', () => {
  it('files a new disk\'s title in that collection', async () => {
    const f = await file('Filed New (1990)(X).adf');
    const { status, titles } = await send({ files: [f], collectionId: 'c1' });
    expect(status).toBe(200);
    expect(await members()).toEqual([['c1', titles[f.sha256].gameId]]);
  });
  it('files nothing without one: the disk stays uncategorized', async () => {
    const f = await file('Loose (1990)(X).adf');
    await send({ files: [f] });
    expect(await members()).toEqual([]);
  });
  it('files a disk the library already had, and keeps it where else it is filed', async () => {
    const f = await file('Filed Twice (1990)(X).adf');
    const { titles } = await send({ files: [f], collectionId: 'c2' });
    await send({ files: [f], collectionId: 'c1' });
    const id = titles[f.sha256].gameId;
    expect((await members()).sort()).toEqual([['c1', id], ['c2', id]]);
  });
  it('sending the same disk to the same collection again changes nothing', async () => {
    const f = await file('Filed Again (1990)(X).adf');
    await send({ files: [f], collectionId: 'c1' });
    await send({ files: [f], collectionId: 'c1' });
    expect(await members()).toHaveLength(1);
  });
  it('another library\'s collection files nothing and refuses nothing', async () => {
    const f = await file('Foreign (1990)(X).adf');
    const { status, titles } = await send({ files: [f], collectionId: 'theirs' });
    expect(status).toBe(200);
    expect(titles[f.sha256]).toBeTruthy();
    expect(await members()).toEqual([]);
  });
});

describe('POST /api/ingest/url with a collectionId', () => {
  const rows = [
    { filename: 'a.adf', sizeBytes: 1, sha256: 'a', state: 'done', title: { gameId: 'g1', title: 'A' } },
    { filename: 'bad.adf', sizeBytes: 1, sha256: null, state: 'failed', note: 'no' },
  ];
  async function fileFromUrl(body: Record<string, unknown>) {
    ingestFromUrl.mockResolvedValue({ ok: true, rows });
    return fromUrl(post({ url: 'https://example.test/a.adf', ...body }));
  }
  it('files the titles the fetch landed', async () => {
    const f = await file('From Url (1990)(X).adf');
    const { titles } = await send({ files: [f] });
    const id = titles[f.sha256].gameId;
    ingestFromUrl.mockResolvedValue({ ok: true, rows: [{ ...rows[0], title: { gameId: id, title: 'From Url' } }, rows[1]] });
    const res = await fromUrl(post({ url: 'https://example.test/a.adf', collectionId: 'c1' }));
    expect(res.status).toBe(200);
    expect(await members()).toEqual([['c1', id]]);
  });
  it('files nothing without one', async () => {
    expect((await fileFromUrl({})).status).toBe(200);
    expect(await members()).toEqual([]);
  });
});
