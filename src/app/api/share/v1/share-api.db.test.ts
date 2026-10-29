import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Client } from 'pg';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_share_api_test';
const url = new URL(base);
url.pathname = `/${DB}`;
process.env.DATABASE_URL = url.toString();
const storageDir = mkdtempSync(join(tmpdir(), 'webadf-share-api-'));
process.env.STORAGE_DIR = storageDir;
delete process.env.BLOB_READ_WRITE_TOKEN;

async function admin(stmt: string) {
  const c = new Client({ connectionString: base });
  await c.connect();
  try { await c.query(stmt); } finally { await c.end(); }
}

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { and, eq } = await import('drizzle-orm');
const { organization } = await import('@/db/schema/auth');
const { collections, collectionGames } = await import('@/db/schema/collections');
const { games, disks, blobs } = await import('@/db/schema/catalog');
const { diskStore, coverStore } = await import('@/lib/storage');
const { formatVolume } = await import('@/lib/adffs/format');
const { addFile, makeDirectory, readVolume } = await import('@/lib/adffs');
const store = await import('@/lib/share/store');
const api = await import('@/lib/share/api');

const ping = await import('./ping/route');
const claim = await import('./claim/route');
const library = await import('./library/route');
const titles = await import('./titles/route');
const title = await import('./titles/[id]/route');
const files = await import('./disks/[id]/files/route');
const bytes = await import('./disks/[id]/bytes/route');
const covers = await import('./covers/[id]/route');

const HOST = 'https://owner.example';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
let ipSeq = 0;
const freshIp = () => `203.0.113.${++ipSeq}`;

function get(path: string, token?: string, ip?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (ip) headers['x-forwarded-for'] = ip;
  return new Request(`${HOST}/api/share/v1/${path}`, { headers });
}
function postClaim(body: unknown, ip = freshIp()) {
  return new Request(`${HOST}/api/share/v1/claim`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `${ip}, 10.0.0.1` },
    body: JSON.stringify(body),
  });
}
function expectShareHeaders(res: Response) {
  expect(res.headers.get('x-webfloppy-share-protocol')).toBe('1');
  expect(res.headers.get('cache-control')).toBe('no-store');
}

async function newCode(input: { everything: boolean; collectionIds: string[] }) {
  const r = await store.createShare('o1', 'u1', { label: 'Rob', ...input });
  if (!r.ok) throw new Error(r.reason);
  return r;
}
async function tokenFor(input: { everything: boolean; collectionIds: string[] }) {
  const r = await newCode(input);
  const c = await store.claimShare(r.code, { url: 'https://rob.example', name: 'Rob' });
  if (!c.ok) throw new Error('claim');
  return { token: c.token, shareId: r.share.id };
}

let adf: Uint8Array;
let adfSha: string;
const coverBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const coverSha = sha(coverBytes);

describe('share API v1', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    const db = getDb();
    await migrate(db, { migrationsFolder: 'drizzle' });
    await db.insert(organization).values({ id: 'o1', name: "Stefan's floppies", slug: 'o1', createdAt: new Date() });
    await db.insert(collections).values([
      { id: 'cs', orgId: 'o1', name: 'Shared', sortKey: 1 },
      { id: 'cu', orgId: 'o1', name: 'Unshared', sortKey: 2 },
    ]);
    const must = (r: { ok: true; adf: Uint8Array } | { ok: false; reason: string }) => { if (!r.ok) throw new Error(r.reason); return r.adf; };
    adf = formatVolume({ filesystem: 'FFS', volumeName: 'ShareVol' });
    adf = must(addFile(adf, 880, 'ReadMe', new TextEncoder().encode('hello amiga\n')));
    adf = must(makeDirectory(adf, 880, 'S'));
    const vol = readVolume(adf);
    if (!vol.ok) throw new Error('no volume');
    const sDir = vol.root.find((e) => e.name === 'S')!;
    adf = must(addFile(adf, sDir.block, 'Startup-Sequence', new TextEncoder().encode('echo hi\n')));
    adfSha = sha(adf);
    await diskStore.put(adfSha, adf);
    await coverStore.put(coverSha, coverBytes, 'image/png');
    await db.insert(blobs).values([
      { sha256: adfSha, sizeBytes: adf.byteLength, storageKey: `adf/${adfSha}` },
      { sha256: 'h'.repeat(64), sizeBytes: 1000, storageKey: 'x' },
    ]);
    const g = (id: string, t: string, extra: Record<string, unknown> = {}) => ({ id, orgId: 'o1', title: t, sortTitle: t.toLowerCase(), ...extra });
    await db.insert(games).values([
      g('g1', 'Alpha', { coverOverrideSha256: coverSha }), g('g2', 'Beta'), g('g3', 'Gamma'), g('gu', 'Unshared'),
    ]);
    const d = (id: string, gameId: string, extra: Record<string, unknown> = {}) =>
      ({ id, gameId, orgId: 'o1', diskNo: 1, sha256: adfSha, sizeBytes: adf.byteLength, ...extra });
    await db.insert(disks).values([
      d('d1', 'g1'), d('d2', 'g2'), d('d3', 'g3'), d('du', 'gu'),
      d('dh', 'g3', { diskNo: 2, sha256: 'h'.repeat(64), sizeBytes: 1000, imageFormat: 'hfe', extractable: false, extractReason: 'track 7 unreadable' }),
    ]);
    await db.insert(collectionGames).values([
      { collectionId: 'cs', gameId: 'g1' }, { collectionId: 'cs', gameId: 'g2' }, { collectionId: 'cs', gameId: 'g3' },
      { collectionId: 'cu', gameId: 'gu' },
    ]);
  });
  afterAll(async () => {
    await closeDb();
    await admin(`drop database if exists ${DB} with (force)`);
    rmSync(storageDir, { recursive: true, force: true });
  });

  it('ping answers the protocol without auth', async () => {
    const res = await ping.GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, protocol: 1 });
    expectShareHeaders(res);
  });

  it('claim: happy path, then reuse is invalid_or_used', async () => {
    const r = await newCode({ everything: false, collectionIds: ['cs'] });
    const body = { code: r.code, protocol: 1, instanceUrl: 'https://rob.example', instanceName: 'Rob' };
    const res = await claim.POST(postClaim(body));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.token).toMatch(/^wfst_/);
    expect(json).toEqual({ token: json.token, protocol: 1, library: { name: "Stefan's floppies" } });
    expectShareHeaders(res);
    const again = await claim.POST(postClaim(body));
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: 'invalid_or_used' });
    expectShareHeaders(again);
  });

  it('claim: protocol 2 is 409 and does not consume the code', async () => {
    const r = await newCode({ everything: false, collectionIds: ['cs'] });
    const res = await claim.POST(postClaim({ code: r.code, protocol: 2, instanceUrl: 'https://rob.example', instanceName: 'Rob' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'protocol', supported: [1] });
    expectShareHeaders(res);
    const ok = await claim.POST(postClaim({ code: r.code, protocol: 1, instanceUrl: 'https://rob.example', instanceName: 'Rob' }));
    expect(ok.status).toBe(200);
  });

  it('claim: bad claimant details or a malformed body are the one 404', async () => {
    const r = await newCode({ everything: false, collectionIds: ['cs'] });
    const bad = await claim.POST(postClaim({ code: r.code, protocol: 1, instanceUrl: 'javascript:alert(1)', instanceName: 'Rob' }));
    expect(bad.status).toBe(404);
    expect(await bad.json()).toEqual({ error: 'invalid_or_used' });
    const junk = await claim.POST(new Request(`${HOST}/api/share/v1/claim`, { method: 'POST', body: 'not json', headers: { 'x-real-ip': freshIp() } }));
    expect(junk.status).toBe(404);
    expectShareHeaders(junk);
  });

  it('claim: the 11th attempt from one IP in a minute is 429', async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i++) {
      const res = await claim.POST(postClaim({ code: 'wfsc_nope', protocol: 1, instanceUrl: 'https://a.example', instanceName: 'A' }, ip));
      expect(res.status).toBe(404);
    }
    const res = await claim.POST(postClaim({ code: 'wfsc_nope', protocol: 1, instanceUrl: 'https://a.example', instanceName: 'A' }, ip));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expectShareHeaders(res);
  });

  it('library lists only scoped collections', async () => {
    const { token } = await tokenFor({ everything: false, collectionIds: ['cs'] });
    const res = await library.GET(get('library', token));
    expect(res.status).toBe(200);
    expectShareHeaders(res);
    expect(await res.json()).toEqual({
      name: "Stefan's floppies", collections: [{ id: 'cs', name: 'Shared', titles: 3 }], titles: 3, disks: 4,
    });
  });

  it('titles: pages are stable across two requests, q filters, unshared collection is 404', async () => {
    const { token } = await tokenFor({ everything: false, collectionIds: ['cs'] });
    const r1 = await titles.GET(get('titles?limit=2', token));
    expectShareHeaders(r1);
    const p1 = await r1.json();
    expect(p1.titles.map((t: { id: string }) => t.id)).toEqual(['g1', 'g2']);
    expect(typeof p1.nextCursor).toBe('string');
    const p2 = await (await titles.GET(get(`titles?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`, token))).json();
    expect(p2).toEqual({ titles: [expect.objectContaining({ id: 'g3', diskCount: 2 })], nextCursor: null });
    const q = await (await titles.GET(get('titles?q=bet', token))).json();
    expect(q.titles.map((t: { id: string }) => t.id)).toEqual(['g2']);
    const coll = await titles.GET(get('titles?collection=cu', token));
    expect(coll.status).toBe(404);
    expect(await coll.json()).toEqual({ error: 'not_found' });
    expectShareHeaders(coll);
    const badCursor = await titles.GET(get('titles?cursor=zzz', token));
    expect(badCursor.status).toBe(400);
  });

  it('titles/{id}: in scope with disks, out of scope 404', async () => {
    const { token } = await tokenFor({ everything: false, collectionIds: ['cs'] });
    const res = await title.GET(get('titles/g3', token), ctx('g3'));
    const body = await res.json();
    expect(body.title).toMatchObject({ id: 'g3', title: 'Gamma', diskCount: 2, collectionIds: ['cs'], hasCover: false, coverDigest: null });
    const withCover = await (await title.GET(get('titles/g1', token), ctx('g1'))).json();
    expect(withCover.title).toMatchObject({ hasCover: true, coverDigest: coverSha });
    expect(body.disks.map((d: { id: string }) => d.id)).toEqual(['d3', 'dh']);
    const out = await title.GET(get('titles/gu', token), ctx('gu'));
    expect(out.status).toBe(404);
    expect(await out.json()).toEqual({ error: 'not_found' });
    expectShareHeaders(out);
  });

  it('disks/{id}/files: a formatted ADF lists root with ISO dates; a broken HFE is unreadable', async () => {
    const { token } = await tokenFor({ everything: false, collectionIds: ['cs'] });
    const res = await files.GET(get('disks/d1/files', token), ctx('d1'));
    expect(res.status).toBe(200);
    expectShareHeaders(res);
    const body = await res.json();
    expect(body.volume.name).toBe('ShareVol');
    expect(body.volume.filesystem).toBe('FFS');
    expect(new Date(body.volume.createdAt).toISOString()).toBe(body.volume.createdAt);
    const byName = Object.fromEntries(body.root.map((e: { name: string }) => [e.name, e]));
    expect(Object.keys(byName).sort()).toEqual(['ReadMe', 'S']);
    expect(byName.ReadMe).toMatchObject({ kind: 'file', sizeBytes: 12 });
    expect(byName.ReadMe.children).toBeUndefined();
    // addFile stamps a header date, so a file lists an ISO date too.
    expect(byName.ReadMe.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(new Date(byName.ReadMe.modifiedAt).toISOString()).toBe(byName.ReadMe.modifiedAt);
    expect(byName.S.kind).toBe('dir');
    expect(new Date(byName.S.modifiedAt).toISOString()).toBe(byName.S.modifiedAt);
    expect(byName.S.children).toEqual([expect.objectContaining({ name: 'Startup-Sequence', kind: 'file', sizeBytes: 8 })]);
    expect(byName.S).not.toHaveProperty('block');
    expect(body.usage.totalBlocks).toBeGreaterThan(0);
    const hfe = await files.GET(get('disks/dh/files', token), ctx('dh'));
    expect(await hfe.json()).toEqual({ unreadable: 'track 7 unreadable' });
    const out = await files.GET(get('disks/du/files', token), ctx('du'));
    expect(out.status).toBe(404);
  });

  it('disks/{id}/bytes: in scope gives bytes and ETag; out of scope 404', async () => {
    const { token } = await tokenFor({ everything: false, collectionIds: ['cs'] });
    const res = await bytes.GET(get('disks/d1/bytes', token), ctx('d1'));
    expect(res.status).toBe(200);
    expectShareHeaders(res);
    expect(res.headers.get('etag')).toBe(`"${adfSha}"`);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-length')).toBe(String(adf.byteLength));
    expect(sha(new Uint8Array(await res.arrayBuffer()))).toBe(adfSha);
    const out = await bytes.GET(get('disks/du/bytes', token), ctx('du'));
    expect(out.status).toBe(404);
    expectShareHeaders(out);
  });

  it('removing a title from the shared collection 404s its bytes at once (Review Focus 1)', async () => {
    const { token } = await tokenFor({ everything: false, collectionIds: ['cs'] });
    expect((await bytes.GET(get('disks/d2/bytes', token), ctx('d2'))).status).toBe(200);
    await getDb().delete(collectionGames).where(and(eq(collectionGames.collectionId, 'cs'), eq(collectionGames.gameId, 'g2')));
    const res = await bytes.GET(get('disks/d2/bytes', token), ctx('d2'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    await getDb().insert(collectionGames).values({ collectionId: 'cs', gameId: 'g2' });
  });

  it('covers/{id}: in-scope cover bytes, sandboxed; none or out of scope 404', async () => {
    const { token } = await tokenFor({ everything: false, collectionIds: ['cs'] });
    const res = await covers.GET(get('covers/g1', token), ctx('g1'));
    expect(res.status).toBe(200);
    expectShareHeaders(res);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(coverBytes);
    expect(res.headers.get('etag')).toBe(`"${coverSha}"`);
    expect((await covers.GET(get('covers/g2', token), ctx('g2'))).status).toBe(404);
    expect((await covers.GET(get('covers/gu', token), ctx('gu'))).status).toBe(404);
  });

  it('a revoked or unknown token is 401 on every authenticated route', async () => {
    const { token, shareId } = await tokenFor({ everything: true, collectionIds: [] });
    await store.revokeShare('o1', shareId);
    const ip = freshIp();
    for (const t of [token, 'wfst_unknown', undefined]) {
      const calls: Response[] = await Promise.all([
        library.GET(get('library', t, ip)),
        titles.GET(get('titles', t, ip)),
        title.GET(get('titles/g1', t, ip), ctx('g1')),
        files.GET(get('disks/d1/files', t, ip), ctx('d1')),
        bytes.GET(get('disks/d1/bytes', t, ip), ctx('d1')),
        covers.GET(get('covers/g1', t, ip), ctx('g1')),
      ]);
      for (const res of calls) {
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'unauthorized' });
        expectShareHeaders(res);
      }
    }
  });

  it('the 31st bytes request in a minute is 429 with Retry-After', async () => {
    const { token } = await tokenFor({ everything: false, collectionIds: ['cs'] });
    for (let i = 0; i < 30; i++) {
      const res = await bytes.GET(get('disks/d1/bytes', token), ctx('d1'));
      expect(res.status).toBe(200);
      await res.arrayBuffer();
    }
    const res = await bytes.GET(get('disks/d1/bytes', token), ctx('d1'));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'rate_limited' });
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expectShareHeaders(res);
    // Listings have their own budget.
    expect((await library.GET(get('library', token))).status).toBe(200);
  });

  it('the 121st listing request in a minute is 429', async () => {
    const { token } = await tokenFor({ everything: false, collectionIds: ['cs'] });
    for (let i = 0; i < 120; i++) expect((await title.GET(get('titles/gu', token), ctx('gu'))).status).toBe(404);
    const res = await library.GET(get('library', token));
    expect(res.status).toBe(429);
    expectShareHeaders(res);
  });

  it('covers have their own budget: 121 in a minute pass and the listing budget is untouched', async () => {
    const { token } = await tokenFor({ everything: false, collectionIds: ['cs'] });
    for (let i = 0; i < 121; i++) {
      const res = await covers.GET(get('covers/g1', token), ctx('g1'));
      expect(res.status).toBe(200);
      await res.arrayBuffer();
    }
    for (let i = 0; i < 120; i++) expect((await title.GET(get('titles/gu', token), ctx('gu'))).status).toBe(404);
    expect((await library.GET(get('library', token))).status).toBe(429);
  });

  it('failed authentication is limited per client IP; a good token from that IP still works', async () => {
    const ip = freshIp();
    for (let i = 0; i < 60; i++) expect((await library.GET(get('library', 'wfst_nope', ip))).status).toBe(401);
    const blocked = await library.GET(get('library', 'wfst_nope', ip));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expectShareHeaders(blocked);
    expect((await library.GET(get('library', 'wfst_nope', freshIp()))).status).toBe(401);
    const { token } = await tokenFor({ everything: false, collectionIds: ['cs'] });
    expect((await library.GET(get('library', token, ip))).status).toBe(200);
  });

  it('an uncaught error still answers with the protocol header (503) and is logged', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const h = api.withShare(async () => { throw new Error('boom'); });
      const res = await h();
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'unavailable' });
      expectShareHeaders(res);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('every route sets force-dynamic; bytes sets maxDuration 60', () => {
    for (const m of [ping, claim, library, titles, title, files, bytes, covers]) expect(m.dynamic).toBe('force-dynamic');
    expect(bytes.maxDuration).toBe(60);
  });
});
