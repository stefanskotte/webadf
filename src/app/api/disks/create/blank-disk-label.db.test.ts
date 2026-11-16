// src/app/api/disks/create/blank-disk-label.db.test.ts
// A made disk is named after its title (tester report and operator ruling 2026-11-16), not "Disk 1"; a volume rename
// carries the label along while it is still the volume's name, and both routes take only an AmigaDOS volume name.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Client } from 'pg';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_blank_disk_label_test';
const url = new URL(base); url.pathname = `/${DB}`; process.env.DATABASE_URL = url.toString();
process.env.STORAGE_DIR ??= (await import('node:fs')).mkdtempSync('/tmp/webadf-blank-label-');
process.env.BLOB_READ_WRITE_TOKEN = '';
async function admin(stmt: string) { const c = new Client({ connectionString: base }); await c.connect(); try { await c.query(stmt); } finally { await c.end(); } }

vi.mock('@/lib/session', () => ({ requireOrg: async () => ({ orgId: 'o1', userId: 'u1', email: 'a@b.test' }) }));

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { eq } = await import('drizzle-orm');
const { disks, games } = await import('@/db/schema/catalog');
const { organization } = await import('@/db/schema/auth');
const { POST: create } = await import('./route');
const { PATCH: rename } = await import('../[id]/volume-name/route');

const post = (body: unknown) => create(new Request('http://x/api/disks/create', { method: 'POST', body: JSON.stringify(body) }));
const patch = (id: string, volumeName: string) => rename(
  new Request(`http://x/api/disks/${id}/volume-name`, { method: 'PATCH', body: JSON.stringify({ volumeName }) }),
  { params: Promise.resolve({ id }) });
const diskOf = async (id: string) => (await getDb().select().from(disks).where(eq(disks.id, id)))[0];

beforeAll(async () => {
  await admin(`drop database if exists ${DB} with (force)`);
  await admin(`create database ${DB}`);
  await migrate(getDb(), { migrationsFolder: 'drizzle' });
  await getDb().insert(organization).values([{ id: 'o1', name: 'o1', slug: 'o1', createdAt: new Date() }]);
});
afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

describe('a made disk is named after its title', () => {
  it('Create ADF labels the disk with the title and volume name', async () => {
    const r = await post({ volumeName: 'Mouseski Keyboard' });
    expect(r.status).toBe(200);
    const { gameId, diskId } = await r.json() as { gameId: string; diskId: string };
    expect((await diskOf(diskId)).label).toBe('Mouseski Keyboard');
    const [g] = await getDb().select().from(games).where(eq(games.id, gameId));
    expect(g.title).toBe('Mouseski Keyboard');
  });
  it('the unnamed default is "Empty", for the disk as for the title', async () => {
    const { diskId } = await (await post({})).json() as { diskId: string };
    expect((await diskOf(diskId)).label).toBe('Empty');
  });
  it('refuses a name AmigaDOS cannot take', async () => {
    expect((await post({ volumeName: 'Work:Stuff' })).status).toBe(400);
    expect((await post({ volumeName: 'a/b' })).status).toBe(400);
    expect((await post({ volumeName: 'x'.repeat(31) })).status).toBe(400);
  });
});

describe('a volume rename carries the label along', () => {
  it('while the label is the old volume name', async () => {
    const { diskId } = await (await post({ volumeName: 'Old Name' })).json() as { diskId: string };
    expect((await patch(diskId, 'New Name')).status).toBe(200);
    expect((await diskOf(diskId)).label).toBe('New Name');
  });
  it('a label somebody chose stays', async () => {
    const { diskId } = await (await post({ volumeName: 'Vol' })).json() as { diskId: string };
    await getDb().update(disks).set({ label: 'My own' }).where(eq(disks.id, diskId));
    expect((await patch(diskId, 'Vol Two')).status).toBe(200);
    expect((await diskOf(diskId)).label).toBe('My own');
  });
  it('refuses a name AmigaDOS cannot take', async () => {
    const { diskId } = await (await post({ volumeName: 'Keep' })).json() as { diskId: string };
    expect((await patch(diskId, 'Bad:Name')).status).toBe(400);
    expect((await diskOf(diskId)).label).toBe('Keep');
  });
});
