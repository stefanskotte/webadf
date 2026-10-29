import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Client } from 'pg';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';

// A database of its own (the shared one is the live one).
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_ingest_complete_test';
const url = new URL(base);
url.pathname = `/${DB}`;
process.env.DATABASE_URL = url.toString();
const storageDir = mkdtempSync(join(tmpdir(), 'webadf-ingest-complete-'));
process.env.STORAGE_DIR = storageDir;
process.env.BLOB_READ_WRITE_TOKEN = '';

// after() only works inside a request; the sweep is not what this file tests.
vi.mock('next/server', () => ({ after: () => {} }));
vi.mock('@/lib/tosec-sweep', () => ({ sweep: async () => {} }));

async function admin(stmt: string) {
  const c = new Client({ connectionString: base });
  await c.connect();
  try { await c.query(stmt); } finally { await c.end(); }
}

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { games } = await import('@/db/schema/catalog');
const { devices } = await import('@/db/schema/devices');
const { transfers } = await import('@/db/schema/transfers');
const { diskStore } = await import('@/lib/storage');
const { registerUploads } = await import('./ingest-complete');

const ORG = 'org-titles';
type Titles = Record<string, { gameId: string; title: string }>;

/** Distinct bytes; stored so the ingest finds them at adf/<sha256>. */
async function file(filename: string, seed: string) {
  const bytes = new Uint8Array(1024).fill(seed.charCodeAt(0));
  bytes.set(new TextEncoder().encode(seed));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await diskStore.put(sha256, bytes);
  return { filename, sha256, sizeBytes: bytes.byteLength };
}
const send = async (files: Awaited<ReturnType<typeof file>>[]) => {
  const res = await registerUploads(ORG, files);
  return (await res.json()) as { titles?: Titles; rejected: string[] };
};
const gameRow = async (id: string) => (await getDb().select().from(games).where(eq(games.id, id)))[0];

describe('registerUploads names the title of each disk', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
  });
  afterAll(async () => {
    await closeDb();
    await admin(`drop database if exists ${DB} with (force)`);
    rmSync(storageDir, { recursive: true, force: true });
  });

  it('a new disk names its game, and the same file sent again names the same one', async () => {
    const f = await file('Turrican II (1991)(Factor 5)[cr].adf', 'turrican');
    const first = await send([f]);
    const g = (await getDb().select().from(games).where(eq(games.orgId, ORG))).find((r) => r.title === 'Turrican II')!;
    expect(first.titles![f.sha256]).toEqual({ gameId: g.id, title: 'Turrican II' });
    expect((await send([f])).titles![f.sha256]).toEqual({ gameId: g.id, title: 'Turrican II' });
  });

  it('reads the title back from the database, not from the parse', async () => {
    const f = await file('Lemmings (1991)(Psygnosis).adf', 'lemmings');
    const gameId = (await send([f])).titles![f.sha256].gameId;
    await getDb().update(games).set({ title: 'Edited' }).where(eq(games.id, gameId));
    expect((await send([f])).titles![f.sha256]).toEqual({ gameId, title: 'Edited' });
  });

  it('a disk re-sent into a human-arranged set names the set it is in', async () => {
    const f = await file('Monkey Island (1990)(Lucasfilm).adf', 'monkey');
    const gameId = (await send([f])).titles![f.sha256].gameId;
    await getDb().update(games).set({ diskOrderSource: 'human' }).where(eq(games.id, gameId));
    const again = await send([f]);
    expect(again.titles![f.sha256]).toEqual({ gameId, title: (await gameRow(gameId)).title });
  });

  it('a rejected file has no entry', async () => {
    const ok = await file('Zool (1992)(Gremlin).adf', 'zool');
    const missing = { filename: 'Ghost (1990).adf', sha256: 'f'.repeat(64), sizeBytes: 1024 };
    const res = await send([ok, missing]);
    expect(res.rejected).toEqual([missing.sha256]);
    expect(res.titles![ok.sha256].title).toBe('Zool');
    expect(res.titles![missing.sha256]).toBeUndefined();
  });

  // Carry (b) from Files increment 2: bytes that fail their digest are deleted only while nothing names their key. A Send
  // or a STASH: file may name it: storeSendBytes overwrites a planted key with the real bytes, and a verify that read the
  // planted ones just before must not then delete the real ones.
  describe('registerUploads releases a key that fails its digest only when nothing names it', () => {
    const planted = async (seed: string) => {
      const key = createHash('sha256').update(`key-${seed}`).digest('hex');
      const bytes = new TextEncoder().encode(`not the bytes of ${seed}`);
      await diskStore.put(key, bytes);
      return { filename: `${seed}.adf`, sha256: key, sizeBytes: bytes.byteLength };
    };

    it('deletes planted bytes nothing names', async () => {
      const f = await planted('lonely');
      expect((await send([f])).rejected).toEqual([f.sha256]);
      expect(await diskStore.stat(f.sha256)).toBeNull();
    });
    it('keeps the bytes at a key a queued transfer names', async () => {
      const f = await planted('sent');
      await getDb().insert(devices).values({ id: 'dev-release', orgId: ORG, name: 'b', tokenHash: 'h-release' });
      await getDb().insert(transfers).values({ id: 't-release', orgId: ORG, deviceId: 'dev-release', createdByUserId: 'u', path: 'x',
        sizeBytes: f.sizeBytes, crc32: 0, blobSha256: f.sha256, expiresAt: new Date(Date.now() + 3600_000) });
      expect((await send([f])).rejected).toEqual([f.sha256]);
      expect(await diskStore.stat(f.sha256)).not.toBeNull();
    });
  });
});
