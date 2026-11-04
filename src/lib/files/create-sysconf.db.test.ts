// src/lib/files/create-sysconf.db.test.ts
// Create SysConf (spec 2026-11-04): the 232 bytes into STASH: or a disk; the clash setting; bad settings and shelves refused.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { createHash } from 'node:crypto';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_files_create_sysconf_test';
const url = new URL(base); url.pathname = `/${DB}`; process.env.DATABASE_URL = url.toString();
process.env.STORAGE_DIR ??= (await import('node:fs')).mkdtempSync('/tmp/webadf-files-create-sysconf-');
process.env.BLOB_READ_WRITE_TOKEN = '';
async function admin(stmt: string) { const c = new Client({ connectionString: base }); await c.connect(); try { await c.query(stmt); } finally { await c.end(); } }

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { games, disks, entitlements, blobs } = await import('@/db/schema/catalog');
const { organization } = await import('@/db/schema/auth');
const { diskStore } = await import('@/lib/storage');
const { formatVolume } = await import('@/lib/adffs/format');
const { listStash } = await import('@/lib/stash');
const { parsePath } = await import('./path');
const { stashDriver } = await import('./stash-driver');
const { libraryDriver } = await import('./library-driver');
const { runOp } = await import('./ops');
const { buildSysconf, sysconfDefaults } = await import('./sysconf');
const { SYSCONF_ON_SHELF } = await import('./shelf-rules');

type OnClash = 'ask' | 'replace' | 'skip' | 'keep-both';
const ctx = { orgId: 'o1', userId: null };
const P = (s: string) => parsePath(s)!;
const make = (dest: string, o: { settings?: unknown; onClash?: OnClash } = {}) =>
  runOp(ctx, { op: 'create-sysconf', dest, settings: o.settings === undefined ? sysconfDefaults() : o.settings, onClash: o.onClash ?? 'ask' });

async function seedDisk(gameId: string, title: string, diskId: string, adf: Uint8Array) {
  const s = createHash('sha256').update(adf).digest('hex');
  await diskStore.put(s, adf);
  const db = getDb();
  await db.insert(blobs).values({ sha256: s, sizeBytes: adf.length, storageKey: `adf/${s}` }).onConflictDoNothing();
  await db.insert(entitlements).values({ orgId: 'o1', sha256: s, sourceFilename: `${title}.adf` }).onConflictDoNothing();
  await db.insert(games).values({ id: gameId, orgId: 'o1', title, sortTitle: title.toLowerCase() }).onConflictDoNothing();
  await db.insert(disks).values({ id: diskId, gameId, orgId: 'o1', diskNo: 1, sha256: s, sizeBytes: adf.length });
}

beforeAll(async () => {
  await admin(`drop database if exists ${DB} with (force)`);
  await admin(`create database ${DB}`);
  await migrate(getDb(), { migrationsFolder: 'drizzle' });
  await getDb().insert(organization).values([{ id: 'o1', name: 'o1', slug: 'o1', createdAt: new Date() }]);
  for (const d of ['Boot', 'Clash', 'Bad']) await runOp(ctx, { op: 'makedir', dest: 'STASH:', name: d });
  await seedDisk('g1', 'Boot disk', 'd1', formatVolume({ filesystem: 'FFS', volumeName: 'Boot' }));
});
afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

describe('Create SysConf', () => {
  it('writes the 232 bytes into a STASH: folder', async () => {
    expect(await make('STASH:/Boot')).toMatchObject({ kind: 'done', items: [{ ok: true }] });
    const f = (await stashDriver.read(ctx, P('STASH:/Boot/system-configuration')))!;
    expect(new Uint8Array(f.bytes)).toEqual(buildSysconf(sysconfDefaults()));
  });
  it('writes into a Devs drawer on a disk, which still reads', async () => {
    const devs = 'LIBRARY:/g1/d1';
    const listed = await libraryDriver.list(ctx, P(devs));
    expect(listed).not.toBeNull();
    const dir = listed!.path;
    await runOp(ctx, { op: 'makedir', dest: dir, name: 'Devs' });
    expect(await make(`${dir}/Devs`)).toMatchObject({ kind: 'done', items: [{ ok: true }] });
    const f = (await libraryDriver.read(ctx, P(`${dir}/Devs/system-configuration`)))!;
    expect(f.bytes.length).toBe(232);
    expect(new Uint8Array(f.bytes)).toEqual(buildSysconf(sysconfDefaults()));
  });
  it('a clash follows the setting', async () => {
    await make('STASH:/Clash');
    expect(await make('STASH:/Clash')).toMatchObject({ kind: 'clashes', clashes: [{ name: 'system-configuration' }] });
    expect(await make('STASH:/Clash', { onClash: 'skip' })).toMatchObject({ kind: 'done', items: [{ ok: true, skipped: true }] });
    expect(await make('STASH:/Clash', { onClash: 'replace', settings: { ...sysconfDefaults(), fontHeight: 9 } })).toMatchObject({ kind: 'done' });
    expect((await stashDriver.read(ctx, P('STASH:/Clash/system-configuration')))!.bytes[0]).toBe(9);
  });
  it.each([[{ mouseTicks: 0 }], [{ viewX: 1.5 }], [{ pointer: [] }]])('refuses bad settings %o and writes nothing', async (o) => {
    expect(await make('STASH:/Bad', { settings: { ...sysconfDefaults(), ...o } })).toMatchObject({ kind: 'refused', status: 400 });
    expect((await listStash(getDb(), 'o1')).some((x) => x.path === 'Bad/system-configuration')).toBe(false);
  });
  it('refuses settings that are not an object', async () => {
    expect(await make('STASH:', { settings: 'nope' })).toMatchObject({ kind: 'refused', status: 400 });
  });
  it('refuses LIBRARY: shelves with the words', async () => {
    expect(await make('LIBRARY:')).toMatchObject({ kind: 'refused', refusal: { detail: SYSCONF_ON_SHELF } });
  });
  it('refuses an unknown path', async () => expect(await make('NOPE:')).toMatchObject({ kind: 'refused', status: 404 }));
});
