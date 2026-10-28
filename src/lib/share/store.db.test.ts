import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_share_store_test';
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
const { collections } = await import('@/db/schema/collections');
const store = await import('./store');
const { mintClaimCode } = await import('./tokens');

const claimant = { url: 'https://rob.example', name: "Rob's library" };
const DAY = 86_400_000;

describe('share store', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
    await getDb().insert(collections).values([
      { id: 'c1', orgId: 'o1', name: 'One' },
      { id: 'c2', orgId: 'o1', name: 'Two' },
      { id: 'cx', orgId: 'o2', name: 'Foreign' },
    ]);
  });
  afterAll(async () => {
    await closeDb();
    await admin(`drop database if exists ${DB} with (force)`);
  });

  async function make(input = { label: 'Rob', everything: false, collectionIds: ['c1'] }) {
    const r = await store.createShare('o1', 'u1', input);
    if (!r.ok) throw new Error('create failed ' + r.reason);
    return r;
  }

  it('create -> waiting with a code, scope listed', async () => {
    const r = await make();
    expect(r.code.startsWith('wfsc_')).toBe(true);
    expect(r.share.status).toBe('waiting');
    const list = await store.listShares('o1');
    const row = list.find((s) => s.id === r.share.id)!;
    expect(row.status).toBe('waiting');
    expect(row.collectionIds).toEqual(['c1']);
    expect(row.claimExpiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * DAY);
    expect(await store.listShares('o2')).toHaveLength(0);
  });

  it('claim -> claimed, token authenticates, second claim fails', async () => {
    const r = await make();
    const c = await store.claimShare(r.code, claimant);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.token.startsWith('wfst_')).toBe(true);
    expect(c.orgId).toBe('o1');
    expect(c.shareId).toBe(r.share.id);
    const row = (await store.listShares('o1')).find((s) => s.id === r.share.id)!;
    expect(row.status).toBe('claimed');
    expect(row.claimedByUrl).toBe(claimant.url);
    expect(row.claimedByName).toBe(claimant.name);
    const auth = await store.authenticateShare(`Bearer ${c.token}`);
    expect(auth).toEqual({ shareId: r.share.id, orgId: 'o1', everything: false });
    expect(await store.claimShare(r.code, claimant)).toEqual({ ok: false });
  });

  it('two concurrent claims with one code: exactly one wins (Review Focus 5)', async () => {
    const r = await make();
    const results = await Promise.all([
      store.claimShare(r.code, { url: 'https://a.example', name: 'A' }),
      store.claimShare(r.code, { url: 'https://b.example', name: 'B' }),
    ]);
    expect(results.filter((x) => x.ok)).toHaveLength(1);
    expect(results.filter((x) => !x.ok)).toHaveLength(1);
  });

  it('expired code cannot be claimed and shows expired', async () => {
    const r = await make();
    const later = new Date(Date.now() + 8 * DAY);
    expect(await store.claimShare(r.code, claimant, later)).toEqual({ ok: false });
    const row = (await store.listShares('o1', later)).find((s) => s.id === r.share.id)!;
    expect(row.status).toBe('expired');
  });

  it('unknown code fails', async () => {
    expect(await store.claimShare(mintClaimCode().plaintext, claimant)).toEqual({ ok: false });
  });

  it('revoke -> authenticate null, status revoked, code unclaimable', async () => {
    const r = await make();
    const c = await store.claimShare(r.code, claimant);
    if (!c.ok) throw new Error('claim');
    expect(await store.revokeShare('o1', r.share.id)).toBe(true);
    expect(await store.authenticateShare(`Bearer ${c.token}`)).toBeNull();
    const row = (await store.listShares('o1')).find((s) => s.id === r.share.id)!;
    expect(row.status).toBe('revoked');
    const r2 = await make();
    await store.revokeShare('o1', r2.share.id);
    expect(await store.claimShare(r2.code, claimant)).toEqual({ ok: false });
  });

  it('revoke is org-scoped', async () => {
    const r = await make();
    expect(await store.revokeShare('o2', r.share.id)).toBe(false);
  });

  it('authenticate rejects malformed or unknown bearers', async () => {
    expect(await store.authenticateShare(null)).toBeNull();
    expect(await store.authenticateShare('Bearer nope')).toBeNull();
    expect(await store.authenticateShare('Bearer wfst_unknown')).toBeNull();
    expect(await store.authenticateShare('wfst_unknown')).toBeNull();
  });

  it('last_used_at is bumped at most once a minute', async () => {
    const r = await make();
    const c = await store.claimShare(r.code, claimant);
    if (!c.ok) throw new Error('claim');
    const t0 = new Date();
    await store.authenticateShare(`Bearer ${c.token}`, t0);
    const get = async () => (await store.listShares('o1')).find((s) => s.id === r.share.id)!.lastUsedAt;
    const first = await get();
    expect(first?.getTime()).toBe(t0.getTime());
    await store.authenticateShare(`Bearer ${c.token}`, new Date(t0.getTime() + 30_000));
    expect((await get())?.getTime()).toBe(t0.getTime());
    const t2 = new Date(t0.getTime() + 61_000);
    await store.authenticateShare(`Bearer ${c.token}`, t2);
    expect((await get())?.getTime()).toBe(t2.getTime());
  });

  it('deleteShare refuses an active claimed or waiting share, accepts revoked and expired', async () => {
    const claimed = await make();
    await store.claimShare(claimed.code, claimant);
    expect(await store.deleteShare('o1', claimed.share.id)).toBe(false);
    const waiting = await make();
    expect(await store.deleteShare('o1', waiting.share.id)).toBe(false);
    await store.revokeShare('o1', claimed.share.id);
    expect(await store.deleteShare('o2', claimed.share.id)).toBe(false);
    expect(await store.deleteShare('o1', claimed.share.id)).toBe(true);
    // expired: push the expiry into the past
    const { libraryShares } = await import('@/db/schema/sharing');
    const { eq } = await import('drizzle-orm');
    await getDb().update(libraryShares).set({ claimExpiresAt: new Date(Date.now() - 1000) }).where(eq(libraryShares.id, waiting.share.id));
    expect(await store.deleteShare('o1', waiting.share.id)).toBe(true);
  });

  it('validates label and collections', async () => {
    expect(await store.createShare('o1', 'u1', { label: '', everything: true, collectionIds: [] })).toEqual({ ok: false, reason: 'bad_label' });
    expect(await store.createShare('o1', 'u1', { label: '   ', everything: true, collectionIds: [] })).toEqual({ ok: false, reason: 'bad_label' });
    expect(await store.createShare('o1', 'u1', { label: 'x'.repeat(61), everything: true, collectionIds: [] })).toEqual({ ok: false, reason: 'bad_label' });
    expect(await store.createShare('o1', 'u1', { label: 'ok', everything: false, collectionIds: [] })).toEqual({ ok: false, reason: 'no_scope' });
    expect(await store.createShare('o1', 'u1', { label: 'ok', everything: false, collectionIds: ['cx'] })).toEqual({ ok: false, reason: 'bad_collection' });
    expect(await store.createShare('o1', 'u1', { label: 'ok', everything: false, collectionIds: ['c1', 'nope'] })).toEqual({ ok: false, reason: 'bad_collection' });
    const ok = await store.createShare('o1', 'u1', { label: '  Rob  ', everything: true, collectionIds: [] });
    expect(ok.ok && ok.share.label).toBe('Rob');
  });

  it('updateShareScope replaces collections, validates org, is org-scoped', async () => {
    const r = await make();
    expect(await store.updateShareScope('o1', r.share.id, { everything: false, collectionIds: ['c2'] })).toBe(true);
    const row = () => store.listShares('o1').then((l) => l.find((s) => s.id === r.share.id)!);
    expect((await row()).collectionIds).toEqual(['c2']);
    expect(await store.updateShareScope('o1', r.share.id, { everything: false, collectionIds: ['cx'] })).toBe(false);
    expect((await row()).collectionIds).toEqual(['c2']);
    expect(await store.updateShareScope('o2', r.share.id, { everything: true, collectionIds: [] })).toBe(false);
    expect(await store.updateShareScope('o1', r.share.id, { everything: true, collectionIds: [] })).toBe(true);
    expect((await row()).everything).toBe(true);
  });

  it('rejects bad claimant details without consuming the code; stores origin only', async () => {
    const r = await make();
    const bad = [
      { url: 'javascript:alert(1)', name: 'A' }, { url: 'data:text/html,x', name: 'A' },
      { url: 'https://x.example/' + 'a'.repeat(3000), name: 'A' }, { url: 'https://x.example', name: '' },
      { url: 'https://x.example', name: ' \u0001 ' }, { url: 'https://x.example', name: 'n'.repeat(200) },
      { url: 'not a url', name: 'A' },
    ];
    for (const b of bad) expect(await store.claimShare(r.code, b)).toEqual({ ok: false });
    const ok = await store.claimShare(r.code, { url: 'https://Rob.example:8443/path?q=1#h', name: ' Ro\u0007b ' });
    expect(ok.ok).toBe(true);
    const row = (await store.listShares('o1')).find((s) => s.id === r.share.id)!;
    expect(row.claimedByUrl).toBe('https://rob.example:8443');
    expect(row.claimedByName).toBe('Rob');
  });

  it('deleteShare accepts a share at exactly its expiry instant', async () => {
    const r = await make();
    expect(await store.deleteShare('o1', r.share.id, r.share.claimExpiresAt)).toBe(true);
  });

  it('updateShareScope refuses a revoked share', async () => {
    const r = await make();
    await store.revokeShare('o1', r.share.id);
    expect(await store.updateShareScope('o1', r.share.id, { everything: true, collectionIds: [] })).toBe(false);
  });

  it('a claimed share past its claim expiry still authenticates', async () => {
    const r = await make();
    const c = await store.claimShare(r.code, claimant);
    if (!c.ok) throw new Error('claim');
    const { libraryShares } = await import('@/db/schema/sharing');
    const { eq } = await import('drizzle-orm');
    await getDb().update(libraryShares).set({ claimExpiresAt: new Date(Date.now() - DAY) }).where(eq(libraryShares.id, r.share.id));
    expect(await store.authenticateShare(`Bearer ${c.token}`)).not.toBeNull();
  });
});
