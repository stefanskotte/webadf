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
const { collections, collectionGames } = await import('@/db/schema/collections');
const { organization } = await import('@/db/schema/auth');
const { devices } = await import('@/db/schema/devices');
const { eq } = await import('drizzle-orm');
const { diskStore } = await import('@/lib/storage');
const { formatVolume } = await import('@/lib/adffs/format');
const { addFile, makeDirectory } = await import('@/lib/adffs/write');
const { ROOT_BLOCK } = await import('@/lib/adffs/constants');
const { GET: GET_LIST } = await import('./list/route');
const { POST: POST_OPS } = await import('./ops/route');
const { GET: GET_DL } = await import('./download/route');
const { GET: GET_REVIEW } = await import('./drop-review/route');
const { GET: GET_STRIP } = await import('./disk-strip/route');
const { ZIP_LIMITS } = await import('@/lib/files/library');
const { insertStash } = await import('@/lib/stash');
const { readFileSync } = await import('node:fs');
async function stash(path: string, bytes: Uint8Array) {
  const sha = createHash('sha256').update(bytes).digest('hex');
  await diskStore.put(sha, bytes);
  const r = await insertStash(getDb(), 'o1', 'browser', [{ path, kind: 'file', sha256: sha, sizeBytes: bytes.length, date: null, protection: 0, comment: '' }]);
  if (!r.ok) throw new Error(r.code);
}

const { readVolume } = await import('@/lib/adffs');
const { unzipSync, strFromU8 } = await import('fflate');
const { blockChecksum } = await import('@/lib/adffs/blocks');
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
  // A crafted image: a file inside S whose header holds "../../x" (no AmigaDOS rules), checksum fixed.
  let evil = formatVolume({ filesystem: 'OFS', volumeName: 'Evil' });
  evil = must(makeDirectory(evil, ROOT_BLOCK, 'S'));
  evil = must(addFile(evil, resolveRoot(evil, 'S'), 'x', new TextEncoder().encode('boo')));
  { const v = readVolume(evil); if (!v.ok) throw new Error();
    const blk = v.root.find((e) => e.name === 'S')!.children[0].block;
    const b = evil.subarray(blk * 512, blk * 512 + 512); const n = new TextEncoder().encode('../../x');
    b.fill(0, 432, 463); b[432] = n.length; b.set(n, 433);
    new DataView(b.buffer, b.byteOffset).setUint32(20, blockChecksum(b, 5)); }
  await seedDisk('g4', 'Evil', 'd4', evil);
  await seedDisk('g3', 'Gone', 'd3', formatVolume({ filesystem: 'OFS', volumeName: 'Gone' }), false);
  // One HD image with a 1.6 MB file, as four titles: two zip together (3.2 MB), three are over the 4 MiB cap.
  const big = new Uint8Array(1_600_000).map((_, i) => (i * 2654435761) >>> 24);
  const blankHd = formatVolume({ filesystem: 'FFS', volumeName: 'Big', density: 'hd' });
  const hv = readVolume(blankHd); if (!hv.ok) throw new Error('no volume');
  const hd = must(addFile(blankHd, hv.rootBlock, 'Big', big));   // an HD root is block 1760, not ROOT_BLOCK
  for (const n of [5, 6, 7, 8]) await seedDisk(`g${n}`, `Big ${n}`, `d${n}`, hd);
  // SysInfo and Other are filed in a collection: their entries have a second path through it (Files 2 §3.1).
  await getDb().insert(collections).values({ id: 'c1', orgId: 'o1', name: 'Demos', sortKey: 0 });
  await getDb().insert(collectionGames).values([{ collectionId: 'c1', gameId: 'g1', sortKey: 0 }, { collectionId: 'c1', gameId: 'g2', sortKey: 1 }]);
  await stash('Notes.txt', new TextEncoder().encode('notes'));
  await stash('t.zip', new Uint8Array(readFileSync('src/lib/archive/fixtures/t.zip')));
  await stash('bad.lha', new TextEncoder().encode('not an lha at all'));
  await stash('Mods/a.mod', new TextEncoder().encode('mod a'));
  await stash('Other/ReadMe', new TextEncoder().encode('stash readme'));
  await stash('Huge.bin', big);
  await stash('Huge2.bin', big.map((b) => b ^ 1));
  await stash('Huge3.bin', big.map((b) => b ^ 2));
});
afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

/** Wraps a diskStore method so a test can see how many calls were in flight at once (each held 10 ms). */
function inFlight(method: 'read' | 'stat') {
  const orig = diskStore[method].bind(diskStore) as (...a: unknown[]) => Promise<unknown>;
  let now = 0, max = 0;
  const spy = vi.spyOn(diskStore, method).mockImplementation((async (...a: unknown[]) => {
    now++; max = Math.max(max, now);
    try { await new Promise((r) => setTimeout(r, 10)); return await orig(...a); } finally { now--; }
  }) as never);
  return { max: () => max, restore: () => spy.mockRestore() };
}

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
    const body = await ok.json();
    expect(body.items).toEqual([expect.objectContaining({ ok: true })]);
    // The version it saved, for the toast's Undo (Task 9b).
    expect(body.versions).toEqual([{ diskId: 'd1', seq: expect.any(Number) }]);
  });
  it('drop-review: the disk as the drop review needs it; not a disk or foreign 404; held 409 (Task 9b)', async () => {
    const r = await GET_REVIEW(req('/api/files/drop-review?path=' + encodeURIComponent('LIBRARY:/g2/d2')));
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d).toMatchObject({ filesystem: 'OFS', intl: false, rootBlock: ROOT_BLOCK, volumeName: 'Other', disabled: null });
    expect(d.freeBlocks).toBeGreaterThan(0);
    expect(d.existingNamesByDir['']).toEqual(expect.arrayContaining([{ name: 'Other.txt', kind: 'file' }, { name: 'S', kind: 'dir' }]));
    expect(d.existingNamesByDir.S).toEqual([{ name: 'Startup', kind: 'file' }]);
    expect(d.entries.map((e: { name: string }) => e.name).sort()).toEqual(['Other.txt', 'S']);
    expect((await GET_REVIEW(req('/api/files/drop-review?path=LIBRARY:/g2'))).status).toBe(404);
    expect((await GET_REVIEW(req('/api/files/drop-review?path=nope'))).status).toBe(400);
    asOrg('o2');
    expect((await GET_REVIEW(req('/api/files/drop-review?path=' + encodeURIComponent('LIBRARY:/g2/d2')))).status).toBe(404);
    asOrg('o1');
    const [d2] = await getDb().select({ sha256: disks.sha256 }).from(disks).where(eq(disks.id, 'd2'));
    await getDb().insert(devices).values({ id: 'devR', orgId: 'o1', name: 'A500 bench', macAddress: 'AA:BB:CC:DD:EE:09', tokenHash: 'hR', desiredSha256: d2.sha256 });
    const held = await GET_REVIEW(req('/api/files/drop-review?path=' + encodeURIComponent('LIBRARY:/g2/d2')));
    expect([held.status, (await held.json()).error]).toEqual([409, 'read_only']);
    await getDb().delete(devices);
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
  it('zip download: a crafted name cannot climb out of the archive (zip-slip)', async () => {
    const r = await GET_DL(req('/api/files/download?paths=' + encodeURIComponent('LIBRARY:/g4/d4/S')));
    expect(r.status).toBe(200);
    const names = Object.keys(unzipSync(new Uint8Array(await r.arrayBuffer())));
    expect(names.sort()).toEqual(['S/', 'S/.._.._x']);
    for (const n of names) expect(n.split('/')).not.toContain('..');
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
  const dlMany = (...ps: string[]) => GET_DL(req('/api/files/download?' + ps.map((p) => 'paths=' + encodeURIComponent(p)).join('&')));
  it('zip cap is 4 MiB for everyone: over it 413 too_large with words; under it a zip', async () => {
    expect(ZIP_LIMITS).toEqual({ maxEntries: 1000, maxBytes: 4 * 1024 * 1024 });
    const r = await dlMany('LIBRARY:/g5/d5/Big', 'LIBRARY:/g6/d6/Big', 'LIBRARY:/g7/d7/Big');
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: 'too_large', detail: expect.stringContaining('4 MB') });
    const two = await dlMany('LIBRARY:/g5/d5/Big', 'LIBRARY:/g6/d6/Big');
    expect(two.status).toBe(200);
    expect(Object.keys(unzipSync(new Uint8Array(await two.arrayBuffer()))).sort()).toEqual(['Big', 'Big (2)']);
  });
  it('a zip stops at the first disk over the cap: no disk after the breach is read', async () => {
    const read = vi.spyOn(diskStore, 'read');
    try {
      const r = await dlMany('LIBRARY:/g5/d5/Big', 'LIBRARY:/g6/d6/Big', 'LIBRARY:/g7/d7/Big', 'LIBRARY:/g8/d8/Big');
      expect(r.status).toBe(413);
      expect(read).toHaveBeenCalledTimes(3);   // d7 is the breach: d8 is never loaded
    } finally { read.mockRestore(); }
  });
  it('one large HD file still downloads by path', async () => {
    const r = await GET_DL(req('/api/files/download?path=' + encodeURIComponent('LIBRARY:/g5/d5/Big')));
    expect([r.status, r.headers.get('content-length')]).toEqual([200, '1600000']);
  });
  it('every Files route that reads disk images allows 60 s', async () => {
    for (const m of [await import('./list/route'), await import('./ops/route'), await import('./download/route')]) {
      expect((m as { maxDuration?: number }).maxDuration).toBe(60);
    }
  });
  it('disk-strip: a disk whose image cannot be read still has its strip, with the disk as the database knows it', async () => {
    const r = await GET_STRIP(req('/api/files/disk-strip?diskId=d3'));
    expect(r.status).toBe(200);
    const s = await r.json();
    expect(s.diskId).toBe('d3');
    expect(s.info).toMatchObject({ diskId: 'd3', gameId: 'g3', title: 'Gone', label: 'Disk 1', imageFormat: 'adf', hd: false,
      volumeName: null, filesystem: null, usedBytes: null, holder: null, tosecName: null });
    // A readable disk's strip carries the same, from the database alone.
    expect((await (await GET_STRIP(req('/api/files/disk-strip?diskId=d1'))).json()).info).toMatchObject({ diskId: 'd1', title: 'SysInfo' });
  });
  it('NET: (increment 3): a copy into a board answers how many files it queued; the board\'s listing carries its queue; another org 404s', async () => {
    await getDb().insert(devices).values({ id: 'devN', orgId: 'o1', name: 'Net bench', tokenHash: 'hN', firmwareVersion: '1.15.0+gabc', lastSeenAt: new Date() });
    const r = await POST_OPS(json({ op: 'copy', sources: ['STASH:/Mods', 'STASH:/Notes.txt'], dest: 'NET:/devN', onClash: 'ask' }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ items: [{ ok: true }, { ok: true }], queued: 2 });
    const l = await GET_LIST(req('/api/files/list?path=NET:/devN/Queue'));
    expect(l.status).toBe(200);
    expect((await l.json()).queue).toEqual({ deviceId: 'devN', files: 2, bytes: 10 });
    const moved = await POST_OPS(json({ op: 'move', sources: ['STASH:/Notes.txt'], dest: 'NET:/devN', onClash: 'ask' }));
    expect(moved.status).toBe(400);
    expect(await moved.json()).toEqual({ error: 'unsupported', detail: 'Files sent to the Amiga stay where they are — use Copy' });
    asOrg('o2');
    expect((await GET_LIST(req('/api/files/list?path=NET:/devN'))).status).toBe(404);
    expect((await GET_LIST(req('/api/files/list?path=NET:/devN/Queue'))).status).toBe(404);
    expect((await POST_OPS(json({ op: 'copy', sources: ['STASH:/Notes.txt'], dest: 'NET:/devN', onClash: 'ask' }))).status).toBe(404);
    asOrg('o1');
  });
  it('NET: volumes (spec 2026-10-30 §4.4): a listing the Amiga has not answered is 202 with its label, never cached; Refresh asks again', async () => {
    const now = new Date();
    await getDb().insert(devices).values({ id: 'devV', orgId: 'o1', name: 'Vol bench', tokenHash: 'hV', firmwareVersion: '1.22.0+gabc',
      lastSeenAt: now, sendRx: 'c', sendRxAt: now, rxProto: 3, browseOn: true });
    const r = await GET_LIST(req('/api/files/list?path=' + encodeURIComponent('NET:/devV/Work/Programs')));
    expect(r.status).toBe(202);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toEqual({ pending: true, label: 'Reading Work:Programs from Vol bench…' });
    const { takeWaiting, answerPiece } = await import('@/lib/remote-requests');
    const [row] = await takeWaiting(getDb(), 'devV');
    await answerPiece(getDb(), 'devV', row.id, { piece: 0, lines: [`DONE ${row.id} 0`], last: true });
    const done = await GET_LIST(req('/api/files/list?path=' + encodeURIComponent('NET:/devV/Work/Programs')));
    expect(done.status).toBe(200);
    expect((await done.json()).net).toMatchObject({ amigaPath: 'Work:Programs', cut: false });
    const again = await GET_LIST(req('/api/files/list?fresh=1&path=' + encodeURIComponent('NET:/devV/Work/Programs')));
    expect(again.status).toBe(202);
  });
  it('lists STASH: and 422s an unreadable archive, with the refusal\'s detail when it has one', async () => {
    expect((await GET_LIST(req('/api/files/list?path=STASH:'))).status).toBe(200);
    const bad = await GET_LIST(req('/api/files/list?path=' + encodeURIComponent('STASH:/bad.lha')));
    expect([bad.status, (await bad.json()).error]).toEqual([422, 'archive_unreadable']);
    asOrg('o2');
    try { expect((await GET_LIST(req('/api/files/list?path=' + encodeURIComponent('STASH:/Notes.txt')))).status).toBe(404); } finally { asOrg('o1'); }
  });
  it('downloads a STASH: file as a nosniff, uncached attachment; LIBRARY: files too', async () => {
    const one = await GET_DL(req('/api/files/download?path=' + encodeURIComponent('STASH:/Notes.txt')));
    expect([one.status, one.headers.get('x-content-type-options'), one.headers.get('cache-control'), await one.text()])
      .toEqual([200, 'nosniff', 'private, no-store', 'notes']);
    expect(one.headers.get('content-disposition')).toContain("attachment; filename*=UTF-8''Notes.txt");
    const lib = await GET_DL(req('/api/files/download?path=' + encodeURIComponent('LIBRARY:/g1/d1/ReadMe')));
    expect([lib.headers.get('x-content-type-options'), lib.headers.get('cache-control')]).toEqual(['nosniff', 'private, no-store']);
    asOrg('o2');
    try { expect((await GET_DL(req('/api/files/download?path=' + encodeURIComponent('STASH:/Notes.txt')))).status).toBe(404); } finally { asOrg('o1'); }
  });
  it('zips STASH: and LIBRARY: together: folders with their contents, archive members, a shared name numbered', async () => {
    const z = await dlMany('STASH:/Notes.txt', 'LIBRARY:/g1/d1/ReadMe', 'STASH:/Mods', 'LIBRARY:/g2/d2/S', 'STASH:/t.zip/src/tiny.txt');
    expect([z.status, z.headers.get('content-type'), z.headers.get('x-content-type-options')]).toEqual([200, 'application/zip', 'nosniff']);
    const files = unzipSync(new Uint8Array(await z.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(['Mods/', 'Mods/a.mod', 'Notes.txt', 'ReadMe', 'S/', 'S/Startup', 'tiny.txt']);
    expect([strFromU8(files['Notes.txt']), strFromU8(files['ReadMe']), strFromU8(files['Mods/a.mod'])]).toEqual(['notes', 'hello', 'mod a']);
    const two = await dlMany('LIBRARY:/g1/d1/ReadMe', 'STASH:/Other/ReadMe');
    const both = unzipSync(new Uint8Array(await two.arrayBuffer()));
    expect([strFromU8(both['ReadMe']), strFromU8(both['ReadMe (2)'])]).toEqual(['hello', 'stash readme']);
    // An entry selected twice, or inside a selected folder, is in the zip once.
    const once = await dlMany('STASH:/Mods', 'STASH:/mods/a.mod', 'STASH:/Notes.txt', 'STASH:/notes.txt');
    expect(Object.keys(unzipSync(new Uint8Array(await once.arrayBuffer()))).sort()).toEqual(['Mods/', 'Mods/a.mod', 'Notes.txt']);
  });
  it('a zip across devices holds an entry selected in both its forms, through a collection and not, once (Files 2 §3.1)', async () => {
    const z = await dlMany('STASH:/Notes.txt', 'LIBRARY:/g1/d1/ReadMe', 'LIBRARY:/c1/g1/d1/ReadMe', 'LIBRARY:/c1/g2/d2/S', 'LIBRARY:/g2/d2/S/Startup');
    expect(z.status).toBe(200);
    expect(Object.keys(unzipSync(new Uint8Array(await z.arrayBuffer()))).sort()).toEqual(['Notes.txt', 'ReadMe', 'S/', 'S/Startup']);
    // A path through a collection the title is not filed in is still not found.
    await getDb().insert(collections).values({ id: 'c2', orgId: 'o1', name: 'Empty', sortKey: 1 });
    expect((await dlMany('STASH:/Notes.txt', 'LIBRARY:/c2/g1/d1/ReadMe')).status).toBe(404);
  });
  it('a zip across devices reads its STASH: blobs side by side, not one after another (60 s functions)', async () => {
    const reads = inFlight('read');
    try {
      const z = await dlMany('STASH:/Notes.txt', 'STASH:/Mods', 'STASH:/Other/ReadMe', 'STASH:/t.zip');
      expect(z.status).toBe(200);
      expect(Object.keys(unzipSync(new Uint8Array(await z.arrayBuffer()))).sort()).toEqual(['Mods/', 'Mods/a.mod', 'Notes.txt', 'ReadMe', 't.zip']);
      expect(reads.max()).toBeGreaterThan(1);
    } finally { reads.restore(); }
  });
  it('a zip across devices: unknown or foreign 404, archive member it cannot read 422, over the cap 413 before a STASH: blob is read', async () => {
    expect((await dlMany('STASH:/Notes.txt', 'STASH:/Nothing')).status).toBe(404);
    expect((await dlMany('STASH:/Notes.txt', 'STASH:')).status).toBe(404);
    asOrg('o2');
    try { expect((await dlMany('STASH:/Notes.txt', 'LIBRARY:/g1/d1/ReadMe')).status).toBe(404); } finally { asOrg('o1'); }
    expect((await dlMany('STASH:/Notes.txt', 'STASH:/bad.lha/x')).status).toBe(422);
    const read = vi.spyOn(diskStore, 'read');
    try {
      const r = await dlMany('STASH:/Huge.bin', 'STASH:/Huge2.bin', 'STASH:/Huge3.bin');
      expect(r.status).toBe(413);
      expect(await r.json()).toEqual({ error: 'too_large', detail: expect.stringContaining('4 MB') });
      expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
    const gone = await dlMany('STASH:/Notes.txt', 'LIBRARY:/g3/d3/x');
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
