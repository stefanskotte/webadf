// src/lib/files/ops.db.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Client } from 'pg';

// The seam for "the source changed between the copy and the delete": applyDiskEdit passes through untouched, and
// after the next successful edit runs `afterNextEdit` once (with the real applyDiskEdit), before runOp goes on.
const seam = vi.hoisted(() => ({
  afterNextEdit: null as null | ((real: typeof import('@/lib/disk-write').applyDiskEdit) => Promise<void>),
}));
vi.mock('@/lib/disk-write', async (importOriginal) => {
  const m = await importOriginal<typeof import('@/lib/disk-write')>();
  return {
    ...m,
    applyDiskEdit: async (...a: Parameters<typeof m.applyDiskEdit>) => {
      const r = await m.applyDiskEdit(...a);
      const hook = seam.afterNextEdit;
      if (r.ok && hook) { seam.afterNextEdit = null; await hook(m.applyDiskEdit); }
      return r;
    },
  };
});

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_files_ops_test';
const url = new URL(base); url.pathname = `/${DB}`; process.env.DATABASE_URL = url.toString();
process.env.STORAGE_DIR ??= (await import('node:fs')).mkdtempSync('/tmp/webadf-files-ops-');
process.env.BLOB_READ_WRITE_TOKEN = '';
async function admin(stmt: string) { const c = new Client({ connectionString: base }); await c.connect(); try { await c.query(stmt); } finally { await c.end(); } }

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { eq, max } = await import('drizzle-orm');
const { createHash } = await import('node:crypto');
const { games, disks, entitlements, blobs } = await import('@/db/schema/catalog');
const { organization } = await import('@/db/schema/auth');
const { devices } = await import('@/db/schema/devices');
const { diskVersions } = await import('@/db/schema/disk-history');
const { diskStore } = await import('@/lib/storage');
const { formatVolume } = await import('@/lib/adffs/format');
const { addFile, makeDirectory, applyBatch } = await import('@/lib/adffs/write');
const { ROOT_BLOCK } = await import('@/lib/adffs/constants');
const { readVolume, readUsage, blocksForFile } = await import('@/lib/adffs');
const { parsePath } = await import('./path');
const { listLibrary, readLibraryFile } = await import('./library');
const { runOp, keepBothName } = await import('./ops');

const ctx = { orgId: 'o1', userId: null };
const must = (r: { ok: true; adf: Uint8Array } | { ok: false; reason: string }) => { if (!r.ok) throw new Error(r.reason); return r.adf; };
const P = (s: string) => parsePath(s)!;

async function seedDisk(gameId: string, title: string, diskId: string, diskNo: number, adf: Uint8Array) {
  const sha = createHash('sha256').update(adf).digest('hex');
  await diskStore.put(sha, adf);
  const db = getDb();
  await db.insert(blobs).values({ sha256: sha, sizeBytes: adf.length, storageKey: `adf/${sha}` }).onConflictDoNothing();
  await db.insert(entitlements).values({ orgId: 'o1', sha256: sha, sourceFilename: `${title}.adf` }).onConflictDoNothing();
  await db.insert(games).values({ id: gameId, orgId: 'o1', title, sortTitle: title.toLowerCase() }).onConflictDoNothing();
  await db.insert(disks).values({ id: diskId, gameId, orgId: 'o1', diskNo, sha256: sha, sizeBytes: adf.length });
  return sha;
}

/** The disk's head version number: 0 before any edit, +1 per recorded edit (version 0 itself is written lazily). */
async function versions(diskId: string) {
  const [r] = await getDb().select({ n: max(diskVersions.seq) }).from(diskVersions).where(eq(diskVersions.diskId, diskId));
  return r?.n ?? 0;
}
async function sha(diskId: string) {
  const [r] = await getDb().select({ sha256: disks.sha256 }).from(disks).where(eq(disks.id, diskId));
  return r.sha256;
}
async function holdDisk(diskId: string, name: string) {
  await getDb().insert(devices).values({ id: 'dev1', orgId: 'o1', name, macAddress: 'AA:BB:CC:DD:EE:01', tokenHash: 'h1', desiredSha256: await sha(diskId) });
}
async function releaseDisk() { await getDb().delete(devices); }

beforeAll(async () => {
  await admin(`drop database if exists ${DB} with (force)`);
  await admin(`create database ${DB}`);
  await migrate(getDb(), { migrationsFolder: 'drizzle' });
  await getDb().insert(organization).values([{ id: 'o1', name: 'o1', slug: 'o1', createdAt: new Date() }, { id: 'o2', name: 'o2', slug: 'o2', createdAt: new Date() }]);

  let adf = formatVolume({ filesystem: 'FFS', volumeName: 'SysInfo' });
  adf = must(makeDirectory(adf, ROOT_BLOCK, 'C'));
  const cBlock = (readVolume(adf) as { ok: true; root: { name: string; block: number }[] }).root.find((e) => e.name === 'C')!.block;
  adf = must(addFile(adf, cBlock, 'Assign', new TextEncoder().encode('assign!'), 0, { comment: 'cmd', date: new Date('1993-05-01T12:00:00Z') }));
  adf = must(addFile(adf, ROOT_BLOCK, 'ReadMe', new TextEncoder().encode('hello')));
  adf = must(makeDirectory(adf, ROOT_BLOCK, 'S'));
  await seedDisk('g1', 'SysInfo', 'd1', 1, adf);

  await seedDisk('g2', 'Turrican', 'd2', 1, formatVolume({ filesystem: 'OFS', volumeName: 'T1' }));

  // Nearly full: the largest one-file fill that still leaves two blocks (1 KB) free. A file of
  // `freeBytes - 1024` bytes does not fit OFS at all (488 data bytes per 512-byte block, plus header
  // and extension blocks), so the fill is sized in blocks.
  let full = formatVolume({ filesystem: 'OFS', volumeName: 'Full' });
  const free = readUsage(full)!.freeBlocks;
  let size = (free - 2) * 488;
  while (blocksForFile(size, 'OFS') > free - 2) size -= 488;
  full = must(addFile(full, ROOT_BLOCK, 'Filler', new Uint8Array(size)));
  await seedDisk('g3', 'Full', 'd3', 1, full);

  let intl = formatVolume({ filesystem: 'FFS', volumeName: 'Intl', intl: true });
  intl = must(addFile(intl, ROOT_BLOCK, 'Grüße', new TextEncoder().encode('hallo')));
  intl = must(applyBatch([
    { op: 'mkdir', parentPath: '', name: 'Tree' }, { op: 'add', parentPath: 'Tree', name: 'Leaf', bytes: new TextEncoder().encode('leaf') },
    { op: 'mkdir', parentPath: '', name: 'Prot' }, { op: 'add', parentPath: '', name: 'Moving', bytes: new TextEncoder().encode('abc') },
  ])(intl));
  await seedDisk('g4', 'Intl', 'd4', 1, intl);
  await seedDisk('g5', 'Spare', 'd5', 1, formatVolume({ filesystem: 'FFS', volumeName: 'Spare' }));
  await seedDisk('g6', 'Gone', 'd6', 1, formatVolume({ filesystem: 'OFS', volumeName: 'Gone' }));
});
afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

describe('copy', () => {
  it('copies a file and a folder between disks in one version, keeping date, protection and comment', async () => {
    const before = await versions('d2');
    const r = await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/C', 'LIBRARY:/g1/d1/ReadMe'], dest: 'LIBRARY:/g2/d2', onClash: 'ask' });
    // The one version it saved is named, for Undo (Task 9b).
    expect(r).toEqual({ kind: 'done', items: [{ source: 'LIBRARY:/g1/d1/C', ok: true }, { source: 'LIBRARY:/g1/d1/ReadMe', ok: true }],
      versions: [{ diskId: 'd2', seq: before + 1 }] });
    expect(await versions('d2')).toBe(before + 1);
    const a = (await readLibraryFile(ctx, P('LIBRARY:/g2/d2/C/Assign')))!;
    const src = (await readLibraryFile(ctx, P('LIBRARY:/g1/d1/C/Assign')))!;
    expect(a.bytes).toEqual(src.bytes);
    expect([a.comment, a.protection, a.date?.toISOString()]).toEqual([src.comment, src.protection, src.date?.toISOString()]);
  });
  it('asks on a clash and writes nothing', async () => {
    const s = await sha('d2');
    const r = await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/ReadMe'], dest: 'LIBRARY:/g2/d2', onClash: 'ask' });
    expect(r).toEqual({ kind: 'clashes', clashes: [{ source: 'LIBRARY:/g1/d1/ReadMe', name: 'ReadMe', dest: 'LIBRARY:/g2/d2' }] });
    expect(await sha('d2')).toBe(s);
  });
  it('clash is case-insensitive', async () => {
    await runOp(ctx, { op: 'rename', source: 'LIBRARY:/g2/d2/ReadMe', name: 'readme' });
    const r = await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/ReadMe'], dest: 'LIBRARY:/g2/d2', onClash: 'ask' });
    expect(r.kind).toBe('clashes');
  });
  it('keep-both adds ReadMe_1; skip writes nothing; replace overwrites', async () => {
    expect((await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/ReadMe'], dest: 'LIBRARY:/g2/d2', onClash: 'keep-both' })).kind).toBe('done');
    expect(await readLibraryFile(ctx, P('LIBRARY:/g2/d2/ReadMe_1'))).not.toBeNull();
    const s = await sha('d2');
    // A skipped item says so (final review): the toast must not count it as copied.
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/ReadMe'], dest: 'LIBRARY:/g2/d2', onClash: 'skip' }))
      .toMatchObject({ kind: 'done', items: [{ source: 'LIBRARY:/g1/d1/ReadMe', ok: true, skipped: true }], versions: [] });   // nothing written, nothing to undo
    expect(await sha('d2')).toBe(s);
    // A move answered Skip keeps its source where it was.
    const s1 = await sha('d1');
    expect(await runOp(ctx, { op: 'move', sources: ['LIBRARY:/g1/d1/ReadMe'], dest: 'LIBRARY:/g2/d2', onClash: 'skip' }))
      .toMatchObject({ kind: 'done', items: [{ source: 'LIBRARY:/g1/d1/ReadMe', ok: true, skipped: true }], versions: [] });
    expect([await sha('d1'), await sha('d2')]).toEqual([s1, s]);
    expect(await readLibraryFile(ctx, P('LIBRARY:/g1/d1/ReadMe'))).not.toBeNull();
    await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/ReadMe'], dest: 'LIBRARY:/g2/d2', onClash: 'replace' });
    expect(new TextDecoder().decode((await readLibraryFile(ctx, P('LIBRARY:/g2/d2/ReadMe')))!.bytes)).toBe('hello');
  });
  it('disk full refuses the whole copy', async () => {
    const s = await sha('d3');
    const r = await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/C', 'LIBRARY:/g1/d1/ReadMe'], dest: 'LIBRARY:/g3/d3', onClash: 'ask' });
    expect(r).toMatchObject({ kind: 'refused', status: 400, refusal: { code: 'disk_full', detail: expect.stringMatching(/needs \d+ KB, \d+ KB free/) } });
    expect(await sha('d3')).toBe(s);
  });
  it('refuses a folder into its own subtree', async () => {
    const s = await sha('d1');
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/C'], dest: 'LIBRARY:/g1/d1/C', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', refusal: { code: 'cycle' } });
    expect(await runOp(ctx, { op: 'move', sources: ['LIBRARY:/g1/d1/C'], dest: 'LIBRARY:/g1/d1/c', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', refusal: { code: 'cycle' } });
    expect(await sha('d1')).toBe(s);
  });
  it('copies an international name', async () => {
    await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g4/d4/Grüße'], dest: 'LIBRARY:/g2/d2', onClash: 'ask' });
    expect((await readLibraryFile(ctx, P('LIBRARY:/g2/d2/Grüße')))?.name).toBe('Grüße');
  });
  it('copies out of a held disk but refuses copying into it', async () => {
    await holdDisk('d1', 'A500 bench');
    expect((await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/S'], dest: 'LIBRARY:/g2/d2', onClash: 'replace' })).kind).toBe('done');
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g2/d2/ReadMe'], dest: 'LIBRARY:/g1/d1', onClash: 'replace' }))
      .toMatchObject({ kind: 'refused', status: 409, refusal: { code: 'read_only', detail: expect.stringMatching(/A500 bench/) } });
    await releaseDisk();
  });
  it("another org's paths are not found", async () => {
    expect(await runOp({ orgId: 'o2', userId: null }, { op: 'copy', sources: ['LIBRARY:/g1/d1/ReadMe'], dest: 'LIBRARY:/g2/d2', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', status: 404, refusal: { code: 'not_found' } });
  });
});

describe('move, delete, makedir, rename, protect, comment', () => {
  it('moves between disks: one new version on each', async () => {
    const [a, b] = [await versions('d1'), await versions('d2')];
    await runOp(ctx, { op: 'makedir', dest: 'LIBRARY:/g2/d2', name: 'Box' });
    const [a1, b1] = [await versions('d1'), await versions('d2')];
    expect([a1, b1]).toEqual([a, b + 1]);
    expect(await runOp(ctx, { op: 'move', sources: ['LIBRARY:/g2/d2/Box'], dest: 'LIBRARY:/g1/d1', onClash: 'ask' }))
      .toMatchObject({ kind: 'done', versions: [{ diskId: 'd1', seq: a1 + 1 }, { diskId: 'd2', seq: b1 + 1 }] });
    expect([await versions('d1'), await versions('d2')]).toEqual([a1 + 1, b1 + 1]);
    expect(await listLibrary(ctx, P('LIBRARY:/g1/d1/Box'))).not.toBeNull();
    expect(await listLibrary(ctx, P('LIBRARY:/g2/d2/Box'))).toBeNull();
  });
  it('deletes several items in one version', async () => {
    const v = await versions('d2');
    expect(await runOp(ctx, { op: 'delete', sources: ['LIBRARY:/g2/d2/ReadMe', 'LIBRARY:/g2/d2/ReadMe_1'] }))
      .toMatchObject({ kind: 'done', versions: [{ diskId: 'd2', seq: v + 1 }] });
    expect(await versions('d2')).toBe(v + 1);
    expect(await readLibraryFile(ctx, P('LIBRARY:/g2/d2/ReadMe'))).toBeNull();
  });
  it('refuses a bad name and a long comment', async () => {
    expect(await runOp(ctx, { op: 'makedir', dest: 'LIBRARY:/g2/d2', name: 'a:b' })).toMatchObject({ kind: 'refused', refusal: { code: 'bad_name' } });
    expect(await runOp(ctx, { op: 'comment', source: 'LIBRARY:/g2/d2/C', comment: 'x'.repeat(80) })).toMatchObject({ kind: 'refused', refusal: { code: 'comment_too_long' } });
  });
  it('sets protection on two files and a comment on one', async () => {
    await runOp(ctx, { op: 'protect', sources: ['LIBRARY:/g2/d2/C/Assign', 'LIBRARY:/g2/d2/Grüße'], protection: 0b0101 });
    const l = (await listLibrary(ctx, P('LIBRARY:/g2/d2/C')))!;
    expect(l.entries[0].protection).toBe((await listLibrary(ctx, P('LIBRARY:/g2/d2')))!.entries.find((e) => e.name === 'Grüße')!.protection);
    await runOp(ctx, { op: 'comment', source: 'LIBRARY:/g2/d2/C/Assign', comment: 'hello' });
    expect((await readLibraryFile(ctx, P('LIBRARY:/g2/d2/C/Assign')))!.comment).toBe('hello');
  });
});

describe('keepBothName', () => {
  it('numbers before the extension and stays within 30 characters', () => {
    const taken = new Set(['readme', 'readme_1', 'a.txt']);
    const t = (n: string) => taken.has(n.toLowerCase());
    expect(keepBothName('ReadMe', t)).toBe('ReadMe_2');
    expect(keepBothName('a.txt', t)).toBe('a_1.txt');
    expect(keepBothName('x'.repeat(30), () => false).length).toBeLessThanOrEqual(30);
  });
});

describe('fix round 1', () => {
  const text = async (path: string) => new TextDecoder().decode((await readLibraryFile(ctx, P(path)))!.bytes);
  it('carries a file\'s and a folder\'s protection bits (p set, d cleared) to the copy', async () => {
    await runOp(ctx, { op: 'protect', sources: ['LIBRARY:/g4/d4/Grüße', 'LIBRARY:/g4/d4/Prot'], protection: 0x20 | 0x01 });
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g4/d4/Grüße', 'LIBRARY:/g4/d4/Prot'], dest: 'LIBRARY:/g5/d5', onClash: 'ask' }))
      .toMatchObject({ kind: 'done', items: [{ ok: true }, { ok: true }] });
    const l = (await listLibrary(ctx, P('LIBRARY:/g5/d5')))!;
    expect(['Grüße', 'Prot'].map((n) => l.entries.find((e) => e.name === n)?.protection)).toEqual(['--p-rwe-', '--p-rwe-']);
  });
  it('moves a non-empty folder between disks whole, and it is gone from the source', async () => {
    expect((await runOp(ctx, { op: 'move', sources: ['LIBRARY:/g4/d4/Tree'], dest: 'LIBRARY:/g5/d5', onClash: 'ask' })).kind).toBe('done');
    expect(await text('LIBRARY:/g5/d5/Tree/Leaf')).toBe('leaf');
    expect(await listLibrary(ctx, P('LIBRARY:/g4/d4/Tree'))).toBeNull();
  });
  it('keeps an original that changed after it was copied: "copied, but the original could not be removed"', async () => {
    seam.afterNextEdit = async (real) => {   // the copy into d5 just landed; now a board saves new bytes over d4's Moving
      const r = await real('o1', 'd4', applyBatch([{ op: 'replace', parentPath: '', name: 'Moving', bytes: new TextEncoder().encode('xyz') }]));
      if (!r.ok) throw new Error(r.reason);
    };
    expect(await runOp(ctx, { op: 'move', sources: ['LIBRARY:/g4/d4/Moving'], dest: 'LIBRARY:/g5/d5', onClash: 'ask' })).toEqual({
      kind: 'done', items: [{ source: 'LIBRARY:/g4/d4/Moving', ok: false, refusal: { code: 'conflict', detail: 'copied, but the original could not be removed' } }],
      versions: [{ diskId: 'd5', seq: expect.any(Number) }] });   // only the copy was saved
    expect(seam.afterNextEdit).toBeNull();
    expect(await text('LIBRARY:/g5/d5/Moving')).toBe('abc');
    expect(await text('LIBRARY:/g4/d4/Moving')).toBe('xyz');
  });
  it('refuses replacing a file with itself as name_exists, not cycle', async () => {
    const s = await sha('d5');
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g5/d5/Moving'], dest: 'LIBRARY:/g5/d5', onClash: 'replace' })).toEqual({
      kind: 'done', items: [{ source: 'LIBRARY:/g5/d5/Moving', ok: false, refusal: { code: 'name_exists', detail: 'same file' } }], versions: [] });
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g5/d5/Tree'], dest: 'LIBRARY:/g5/d5', onClash: 'replace' })).toEqual({
      kind: 'done', items: [{ source: 'LIBRARY:/g5/d5/Tree', ok: false, refusal: { code: 'cycle' } }], versions: [] });   // a folder stays cycle
    expect(await sha('d5')).toBe(s);
  });
  it('a disk whose blob is gone is refused blob_unavailable 503, not thrown', async () => {
    await diskStore.remove(await sha('d6'));
    expect(await runOp(ctx, { op: 'makedir', dest: 'LIBRARY:/g6/d6', name: 'X' }))
      .toEqual({ kind: 'refused', status: 503, refusal: { code: 'blob_unavailable' } });
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g5/d5/Moving'], dest: 'LIBRARY:/g6/d6', onClash: 'ask' }))
      .toEqual({ kind: 'refused', status: 503, refusal: { code: 'blob_unavailable' } });
  });
});

describe('devices', () => {
  it('every device has a driver now (NET: in increment 3): a board that is not there is not found, and nothing is written', async () => {
    const s = await sha('d2');
    expect(await runOp(ctx, { op: 'delete', sources: ['NET:/board1/x'] }))
      .toMatchObject({ kind: 'refused', status: 404, refusal: { code: 'not_found' } });
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/ReadMe'], dest: 'NET:/board1', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', status: 404, refusal: { code: 'not_found' } });
    expect(await sha('d2')).toBe(s);
  });
});
