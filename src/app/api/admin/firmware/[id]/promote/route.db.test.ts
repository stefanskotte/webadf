import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Client } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

// A database of its own (the shared one is the live one), and local storage in a temp dir.
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_fwpromote_test';
const url = new URL(base);
url.pathname = `/${DB}`;
process.env.DATABASE_URL = url.toString();
const storageDir = mkdtempSync(join(tmpdir(), 'webadf-fwpromote-'));
process.env.STORAGE_DIR = storageDir;
process.env.BLOB_READ_WRITE_TOKEN = '';

// The guard is requireSuperAdmin(); its session lookup needs a request scope this test has not got.
const requireSuperAdmin = vi.fn(async () => ({ userId: 'u-admin', email: 'admin@x.test' }));
vi.mock('@/lib/superadmin', () => ({ requireSuperAdmin: () => requireSuperAdmin() }));

async function admin(stmt: string) {
  const c = new Client({ connectionString: base });
  await c.connect();
  try { await c.query(stmt); } finally { await c.end(); }
}

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { firmwareReleases } = await import('@/db/schema/firmware');
const { firmwareStore } = await import('@/lib/storage');
const { POST } = await import('./route');

let nextSeq = 1;
async function seed(opts: { notes: string | null; bytes?: Buffer; noBlob?: boolean }) {
  const id = randomUUID();
  const sequence = nextSeq++;
  const version = `1.0.${sequence}+gtest${sequence}`;
  const bytes = opts.bytes ?? Buffer.from(`firmware image ${version}`);
  const blobPath = `firmware/${version}.bin`;
  if (!opts.noBlob) await firmwareStore.put(blobPath, bytes);
  await getDb().insert(firmwareReleases).values({
    id, version, semver: `1.0.${sequence}`, sequence,
    sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length, blobPath,
    signature: `sig-${sequence}`, signingKeyId: 'k1', signatureFormat: 2,
    notes: opts.notes, security: false, publishedByUserId: 'u-admin',
  });
  return id;
}
const row = async (id: string) => (await getDb().select().from(firmwareReleases).where(eq(firmwareReleases.id, id)))[0];
const promote = (id: string, body: unknown) => POST(
  new Request(`http://test/api/admin/firmware/${id}/promote`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }),
  { params: Promise.resolve({ id }) },
);

describe('POST /api/admin/firmware/[id]/promote', () => {
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

  it('calls requireSuperAdmin', async () => {
    requireSuperAdmin.mockClear();
    await promote(randomUUID(), { notes: 'x' });
    expect(requireSuperAdmin).toHaveBeenCalledTimes(1);
  });

  it('404 for an unknown id', async () => {
    const res = await promote(randomUUID(), { notes: 'Fixes DF1.' });
    expect(res.status).toBe(404);
  });

  it('409 when the row is already a release', async () => {
    const id = await seed({ notes: 'Fixes DF1.' });
    const res = await promote(id, { notes: 'Other notes.' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('not_test_build');
    expect((await row(id)).notes).toBe('Fixes DF1.');
  });

  it('409 when the row has no notes (a release, not a TEST build)', async () => {
    const id = await seed({ notes: null });
    expect((await promote(id, { notes: 'x' })).status).toBe(409);
  });

  it('400 for empty notes, notes still starting "TEST build", too long, or a bad body', async () => {
    const id = await seed({ notes: 'TEST build: bench' });
    for (const body of [{ notes: '' }, { notes: '   ' }, { notes: 'TEST build again' }, { notes: '  TEST build x' },
      { notes: 'x'.repeat(2001) }, {}, { notes: 5 }, 'not json',
      // look-alikes: any case, after leading punctuation
      { notes: 'test build: lower' }, { notes: 'Test Build x' }, { notes: '- TEST build x' }, { notes: '[test build] x' }]) {
      const res = await promote(id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await row(id)).notes).toBe('TEST build: bench');
  });

  it('409 with the reason for a bench-marker image, even with "TEST build" removed from the notes', async () => {
    for (const marker of ['wf-df1-default-on', 'wf-pnet-loop-test', 'wf-a2b-discard-test', 'fwdbg']) {
      const id = await seed({ notes: 'TEST build: bench', bytes: Buffer.from(`image ... ${marker} ...`) });
      const res = await promote(id, { notes: 'Looks like a release.' });
      expect(res.status, marker).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('bench_image');
      expect(body.reason).toMatch(/WF_/);
      expect((await row(id)).notes).toBe('TEST build: bench');
    }
  });

  it('a look-alike answers still_test_build', async () => {
    const id = await seed({ notes: 'TEST build: bench' });
    const res = await promote(id, { notes: '* test build again' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('still_test_build');
  });

  it('409 image_mismatch when the stored image is not the bytes the row (and its signature) names; no update', async () => {
    const id = await seed({ notes: 'TEST build: swapped' });
    const before = await row(id);
    await firmwareStore.put(before.blobPath, Buffer.from('some other bytes'));
    const res = await promote(id, { notes: 'Looks fine.' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'image_mismatch' });
    expect(await row(id)).toEqual(before);
  });

  it('503 blob_unavailable when the image cannot be read', async () => {
    const id = await seed({ notes: 'TEST build: bench', noBlob: true });
    const res = await promote(id, { notes: 'Fixes DF1.' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'blob_unavailable' });
  });

  it('success changes the notes only (trimmed); sha256, signature, sequence and the rest are unchanged', async () => {
    const id = await seed({ notes: 'TEST build: DF1 fix' });
    const before = await row(id);
    const res = await promote(id, { notes: '  DF1 fix.  ' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id, notes: 'DF1 fix.', sequence: before.sequence, version: before.version });
    const after = await row(id);
    expect(after).toEqual({ ...before, notes: 'DF1 fix.' });
  });

  it('a second promote of the same row is a 409', async () => {
    const id = await seed({ notes: 'TEST build: twice' });
    expect((await promote(id, { notes: 'Once.' })).status).toBe(200);
    const again = await promote(id, { notes: 'Twice.' });
    expect(again.status).toBe(409);
    expect((await row(id)).notes).toBe('Once.');
  });

  it('two racing promotes: exactly one wins', async () => {
    const id = await seed({ notes: 'TEST build: race' });
    const [a, b] = await Promise.all([promote(id, { notes: 'A.' }), promote(id, { notes: 'B.' })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });
});
