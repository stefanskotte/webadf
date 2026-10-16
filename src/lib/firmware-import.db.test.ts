import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { firmwareManifest } from './firmware-manifest';
import { githubReleasePlan } from './firmware-github-release';
import { signingKeyId } from '../../scripts/firmware-signing-key';

// A database of its own: the import writes super-admin-owned registry rows that must not leak into the shared one.
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_fwimport_test';
const url = new URL(base);
url.pathname = `/${DB}`;
process.env.DATABASE_URL = url.toString();
const storageDir = mkdtempSync(join(tmpdir(), 'webadf-fwimport-'));
process.env.STORAGE_DIR = storageDir;
process.env.BLOB_READ_WRITE_TOKEN = '';
process.env.SUPERADMIN_EMAILS = 'admin@x.test';

async function admin(stmt: string) {
  const c = new Client({ connectionString: base });
  await c.connect();
  try { await c.query(stmt); } finally { await c.end(); }
}

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { firmwareReleases } = await import('@/db/schema/firmware');
const { user } = await import('@/db/schema/auth');
const { runFirmwareImport } = await import('./firmware-import');

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const keyId = signingKeyId(publicKey);
const keys = { [keyId]: Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('hex') };

interface Rel { tag: string; bin: Buffer; manifest: Record<string, unknown>; body: string; tamper?: boolean; draft?: boolean }
function release(semver: string, build: string, sequence: number, opts: { notes?: string | null; manifestNotes?: boolean; security?: boolean } = {}): Rel {
  const version = `${semver}+g${build}`;
  const bin = Buffer.from(`firmware image ${version}`);
  const sha256 = createHash('sha256').update(bin).digest('hex');
  const msg = firmwareManifest({ version, sequence, sha256, sizeBytes: bin.length });
  const signature = sign(null, Buffer.from(msg, 'ascii'), privateKey).toString('base64');
  const notes = opts.notes ?? null;
  const plan = githubReleasePlan({ version, semver, sequence, sha256, signature, signingKeyId: keyId, notes, security: opts.security ?? false });
  if (!plan.publish) throw new Error('not published');
  const manifest = { ...plan.manifest } as Record<string, unknown>;
  if (opts.manifestNotes === false) { delete manifest.notes; delete manifest.security; }
  return { tag: plan.tag, bin, manifest, body: plan.body };
}

function fakeGithub(rels: Rel[], listStatus = 200) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const u = String(input);
    calls.push(u);
    if (u === 'https://api.github.com/repos/test/repo/releases?per_page=100') {
      if (listStatus === 403) return new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
      return Response.json(rels.map((r) => ({
        tag_name: r.tag, body: r.body, draft: false, prerelease: false,
        assets: [
          { name: 'manifest.json', browser_download_url: `https://dl.test/${r.tag}/manifest.json` },
          { name: 'wifi_floppy.bin', browser_download_url: `https://dl.test/${r.tag}/wifi_floppy.bin` },
        ],
      })));
    }
    const m = /^https:\/\/dl\.test\/([^/]+)\/(.+)$/.exec(u);
    const r = m && rels.find((x) => x.tag === m[1]);
    if (!r) return new Response('nope', { status: 404 });
    if (m![2] === 'manifest.json') return Response.json(r.manifest);
    const bytes = r.tamper ? Buffer.concat([r.bin, Buffer.from('!')]) : r.bin;
    return new Response(new Uint8Array(bytes));
  }) as typeof fetch;
  return { impl, calls };
}
const run = (impl: typeof fetch) => runFirmwareImport({ repo: 'test/repo', fetchImpl: impl, keys, log: () => {} });
const rows = () => getDb().select().from(firmwareReleases);

describe('runFirmwareImport', () => {
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

  const r100 = release('1.0.0', 'aaa', 10, { notes: 'First one.' });
  const r120 = release('1.2.0', 'bbb', 12, { notes: 'Fixes DF1.', security: true, manifestNotes: false });
  const rc = { ...release('1.1.0', 'rc1', 11), tag: 'fw-1.1.0-rc1' };
  const other = { ...release('3.0.0', 'ccc', 30), tag: 'v3.0.0' };

  it('waits when no super-admin has signed up yet, and writes nothing', async () => {
    const res = await run(fakeGithub([r100, r120]).impl);
    expect(res.waiting).toMatch(/super-admin/);
    expect(res.imported).toEqual([]);
    expect(await rows()).toHaveLength(0);
  });

  it('imports each verified release with its own sequence, blob, notes and security flag', async () => {
    await getDb().insert(user).values({ id: 'u-admin', name: 'Admin', email: 'admin@x.test' });
    const res = await run(fakeGithub([r120, rc, other, r100]).impl);
    expect(res.imported).toEqual(['1.0.0+gaaa', '1.2.0+gbbb']);
    const all = (await rows()).sort((a, b) => a.sequence - b.sequence);
    expect(all.map((x) => x.sequence)).toEqual([10, 12]);
    expect(all[0]).toMatchObject({ version: '1.0.0+gaaa', notes: 'First one.', security: false, blobPath: 'firmware/1.0.0+gaaa.bin', publishedByUserId: 'u-admin' });
    // the 1.2.0 manifest carries no notes/security: notes come from the release body, security defaults false
    expect(all[1]).toMatchObject({ version: '1.2.0+gbbb', notes: 'Fixes DF1.', security: false });
    for (const [rel, row] of [[r100, all[0]], [r120, all[1]]] as const) {
      const f = join(storageDir, row.blobPath);
      expect(existsSync(f)).toBe(true);
      expect(readFileSync(f).equals(rel.bin)).toBe(true);
    }
  });

  it('is idempotent: a second run imports nothing', async () => {
    const res = await run(fakeGithub([r120, r100]).impl);
    expect(res.imported).toEqual([]);
    expect(await rows()).toHaveLength(2);
  });

  it('skips a release whose image was tampered, writing no row and no blob', async () => {
    const bad = { ...release('1.3.0', 'ddd', 13), tamper: true };
    const res = await run(fakeGithub([r100, bad]).impl);
    expect(res.imported).toEqual([]);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0]).toMatchObject({ tag: 'fw-1.3.0' });
    expect(res.skipped[0].reason).toMatch(/sha256/);
    expect(await getDb().select().from(firmwareReleases).where(eq(firmwareReleases.semver, '1.3.0'))).toHaveLength(0);
    expect(existsSync(join(storageDir, 'firmware/1.3.0+gddd.bin'))).toBe(false);
  });

  it('reports a GitHub rate limit as an error and writes nothing', async () => {
    const res = await run(fakeGithub([], 403).impl);
    expect(res.error).toMatch(/rate limit/);
    expect(res.imported).toEqual([]);
    expect(await rows()).toHaveLength(2);
  });

  it('imports an older release that shows up later, with its own lower sequence', async () => {
    const old = release('0.9.0', 'eee', 9);
    const res = await run(fakeGithub([r100, r120, old]).impl);
    expect(res.imported).toEqual(['0.9.0+geee']);
    expect((await rows()).map((x) => x.sequence).sort((a, b) => a - b)).toEqual([9, 10, 12]);
  });
});
