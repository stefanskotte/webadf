// src/lib/stash-library.db.test.ts
// addUploadToLibrary's `existed`: whether the library had the disk before this call. Filing a STASH: image onto a
// collection (src/lib/files/shelf.ts) skips one the library already had whose title is already there (Files 2, R5).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Client } from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_stash_library_test';
const url = new URL(base); url.pathname = `/${DB}`; process.env.DATABASE_URL = url.toString();
process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'webadf-stash-library-'));
process.env.BLOB_READ_WRITE_TOKEN = '';
async function admin(stmt: string) { const c = new Client({ connectionString: base }); await c.connect(); try { await c.query(stmt); } finally { await c.end(); } }

// after() only works inside a request; the sweep is not what this file tests.
vi.mock('next/server', () => ({ after: () => {} }));
vi.mock('@/lib/tosec-sweep', () => ({ sweep: async () => {} }));

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { organization } = await import('@/db/schema/auth');
const { diskStore } = await import('@/lib/storage');
const { formatVolume } = await import('@/lib/adffs/format');
const { insertStash, listStash } = await import('@/lib/stash');
const { addUploadToLibrary } = await import('./stash-library');

// One volume's bytes (formatVolume dates the volume, so two calls differ).
const BYTES = formatVolume({ filesystem: 'FFS', volumeName: 'One' });
async function stash(path: string, bytes = BYTES) {
  const sha = createHash('sha256').update(bytes).digest('hex');
  await diskStore.put(sha, bytes, { overwrite: true });
  const r = await insertStash(getDb(), 'o1', 'browser', [{ path, kind: 'file', sha256: sha, sizeBytes: bytes.length, date: null, protection: 0, comment: '' }]);
  if (!r.ok) throw new Error(r.code);
  return (await listStash(getDb(), 'o1')).find((x) => x.path === path)!.id;
}

beforeAll(async () => {
  await admin(`drop database if exists ${DB} with (force)`);
  await admin(`create database ${DB}`);
  await migrate(getDb(), { migrationsFolder: 'drizzle' });
  await getDb().insert(organization).values({ id: 'o1', name: 'o1', slug: 'o1', createdAt: new Date() });
});
afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

describe('addUploadToLibrary: existed', () => {
  it('a new disk is not marked; the same file again, or the same bytes from another file, are', async () => {
    const first = await addUploadToLibrary('o1', await stash('One.adf'));
    expect(first).toMatchObject({ ok: true });
    expect(first).not.toHaveProperty('existed');
    if (!first.ok) return;

    const again = await addUploadToLibrary('o1', (await listStash(getDb(), 'o1')).find((x) => x.path === 'One.adf')!.id);
    expect(again).toEqual({ ok: true, diskId: first.diskId, gameId: first.gameId, existed: true });

    const copy = await addUploadToLibrary('o1', await stash('Copy of One.adf'));
    expect(copy).toEqual({ ok: true, diskId: first.diskId, gameId: first.gameId, existed: true });
  });
});
