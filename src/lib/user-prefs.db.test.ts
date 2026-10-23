import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { eq } from 'drizzle-orm';

// A database of its own (the shared one is the live one).
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_user_prefs_test';
const url = new URL(base);
url.pathname = `/${DB}`;
process.env.DATABASE_URL = url.toString();

async function admin(stmt: string) {
  const c = new Client({ connectionString: base });
  await c.connect();
  try { await c.query(stmt); } finally { await c.end(); }
}

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { user } = await import('@/db/schema/auth');
const { userPrefs } = await import('@/db/schema/user-prefs');
const { getUserPrefs, setUserPrefs } = await import('./user-prefs');
const { DEFAULT_PREFS } = await import('./user-prefs-schema');

let n = 0;
async function newUser() {
  const id = `u-${++n}`;
  await getDb().insert(user).values({ id, name: id, email: `${id}@example.test` });
  return id;
}

describe('user prefs storage', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
  });
  afterAll(async () => {
    await closeDb();
    await admin(`drop database if exists ${DB} with (force)`);
  });

  it('a user who never saved anything reads the defaults, and reading writes no row', async () => {
    const u = await newUser();
    expect(await getUserPrefs(u)).toEqual(DEFAULT_PREFS);
    expect(await getDb().select().from(userPrefs).where(eq(userPrefs.userId, u))).toHaveLength(0);
  });

  it('a partial patch changes only what it names, and later patches keep earlier ones', async () => {
    const u = await newUser();
    const a = await setUserPrefs(u, { startPage: 'devices' });
    expect(a).toEqual({ ...DEFAULT_PREFS, startPage: 'devices' });
    await setUserPrefs(u, { library: { sort: { key: 'title', dir: 'asc' } } });
    await setUserPrefs(u, { browse: { sort: { key: 'size', dir: 'desc' } } });
    expect(await getUserPrefs(u)).toEqual({
      startPage: 'devices',
      library: { sort: { key: 'title', dir: 'asc' }, view: 'grid', pageSize: 48 },
      browse: { sort: { key: 'size', dir: 'desc' } },
      firmware: { skipPassword: false },
    });
  });

  it("one user's prefs never touch another's", async () => {
    const a = await newUser();
    const b = await newUser();
    await setUserPrefs(a, { startPage: 'upload', library: { sort: { key: 'year', dir: 'desc' } } });
    expect(await getUserPrefs(b)).toEqual(DEFAULT_PREFS);
    await setUserPrefs(b, { startPage: 'devices' });
    expect((await getUserPrefs(a)).startPage).toBe('upload');
    expect((await getUserPrefs(b)).library.sort).toEqual(DEFAULT_PREFS.library.sort);
  });

  it('concurrent patches to different settings are both kept', async () => {
    const u = await newUser();
    await Promise.all([
      setUserPrefs(u, { startPage: 'devices' }),
      setUserPrefs(u, { library: { sort: { key: 'publisher', dir: 'asc' } } }),
      setUserPrefs(u, { browse: { sort: { key: 'date', dir: 'desc' } } }),
    ]);
    expect(await getUserPrefs(u)).toEqual({
      startPage: 'devices',
      library: { sort: { key: 'publisher', dir: 'asc' }, view: 'grid', pageSize: 48 },
      browse: { sort: { key: 'date', dir: 'desc' } },
      firmware: { skipPassword: false },
    });
  });

  it('concurrent patches to an EXISTING row are all kept (the row lock, not the insert, serialises them)', async () => {
    const u = await newUser();
    await setUserPrefs(u, { startPage: 'upload' });
    await Promise.all([
      setUserPrefs(u, { startPage: 'devices' }),
      setUserPrefs(u, { library: { sort: { key: 'year', dir: 'asc' } } }),
      setUserPrefs(u, { browse: { sort: { key: 'size', dir: 'asc' } } }),
    ]);
    expect(await getUserPrefs(u)).toEqual({
      startPage: 'devices',
      library: { sort: { key: 'year', dir: 'asc' }, view: 'grid', pageSize: 48 },
      browse: { sort: { key: 'size', dir: 'asc' } },
      firmware: { skipPassword: false },
    });
  });

  it('firmware.skipPassword is stored, survives other patches, and turns back off', async () => {
    const u = await newUser();
    await setUserPrefs(u, { firmware: { skipPassword: true } });
    await setUserPrefs(u, { startPage: 'devices' });
    expect((await getUserPrefs(u)).firmware).toEqual({ skipPassword: true });
    await setUserPrefs(u, { firmware: { skipPassword: false } });
    expect((await getUserPrefs(u)).firmware).toEqual({ skipPassword: false });
  });

  it('a stored value that no longer validates reads as defaults for that field only', async () => {
    const u = await newUser();
    await getDb().insert(userPrefs).values({
      userId: u, prefs: { startPage: 'devices', library: { sort: { key: 'gone', dir: 'asc' } } },
    });
    expect(await getUserPrefs(u)).toEqual({ ...DEFAULT_PREFS, startPage: 'devices' });
  });

  it('deleting the user deletes their prefs', async () => {
    const u = await newUser();
    await setUserPrefs(u, { startPage: 'devices' });
    await getDb().delete(user).where(eq(user.id, u));
    expect(await getDb().select().from(userPrefs).where(eq(userPrefs.userId, u))).toHaveLength(0);
  });
});
