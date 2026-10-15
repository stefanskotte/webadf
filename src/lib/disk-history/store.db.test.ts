import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

// The blob store is not under test; the rows are. The delay lets two racing
// writers both pass the stale-head pre-check before either one's rows land.
vi.mock('@/lib/storage', () => ({
  diskStore: {
    put: async () => { await new Promise((r) => setTimeout(r, 50)); return { key: 'x' }; },
    storageKey: (sha: string) => `adf/${sha}`,
  },
}));

const { getDb, closeDb } = await import('@/db');
const { blobs, disks, entitlements, games } = await import('@/db/schema/catalog');
const { diskVersions } = await import('@/db/schema/disk-history');
const { recordVersion, StaleHeadError } = await import('./store');
const { ADF_BYTES } = await import('@/lib/adfmfm');

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const orgId = `org-${randomUUID()}`;
const gameId = randomUUID();
const diskId = randomUUID();
const head = new Uint8Array(ADF_BYTES);
const headSha = sha(head);
const edit = (n: number) => { const b = head.slice(); b[0] = n; return b; };
const input = (next: Uint8Array) => ({
  orgId, diskId, headSha, head, next, source: 'browser' as const,
  userId: null, sourceFilename: 'Game.adf',
});

describe('recordVersion on node-postgres', () => {
  beforeAll(async () => {
    const db = getDb();
    await db.insert(blobs).values({ sha256: headSha, sizeBytes: head.length, storageKey: `adf/${headSha}` }).onConflictDoNothing();
    await db.insert(games).values({ id: gameId, orgId, title: 'T', sortTitle: 't' });
    await db.insert(disks).values({ id: diskId, gameId, orgId, diskNo: 1, sha256: headSha, sizeBytes: head.length });
  });
  afterAll(async () => {
    const db = getDb();
    await db.delete(disks).where(eq(disks.orgId, orgId)); // disk_versions cascade
    await db.delete(games).where(eq(games.orgId, orgId));
    await db.delete(entitlements).where(eq(entitlements.orgId, orgId));
    await db.delete(blobs).where(inArray(blobs.sha256, [sha(edit(1)), sha(edit(2))]));
    await db.delete(blobs).where(eq(blobs.sha256, headSha));
    await closeDb();
  });

  it('two writers that read the same history: one wins, the loser is StaleHeadError and leaves nothing behind', async () => {
    const a = edit(1);
    const b = edit(2);
    const results = await Promise.allSettled([recordVersion(input(a)), recordVersion(input(b))]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0].reason).toBeInstanceOf(StaleHeadError);

    const db = getDb();
    const versions = await db.select().from(diskVersions).where(eq(diskVersions.diskId, diskId));
    // version 0 (the original) plus the winner's version 1: exactly one write landed
    expect(versions.map((v) => v.seq).sort()).toEqual([0, 1]);
    const winnerSha = versions.find((v) => v.seq === 1)!.imageSha256;
    const loserSha = winnerSha === sha(a) ? sha(b) : sha(a);
    const [disk] = await db.select().from(disks).where(eq(disks.id, diskId));
    expect(disk.sha256).toBe(winnerSha);
    // the loser's blob row rolled back with the rest of its transaction
    expect(await db.select().from(blobs).where(eq(blobs.sha256, loserSha))).toHaveLength(0);
  });

  it('a later write from the stale head is refused and records nothing', async () => {
    const err = await recordVersion(input(edit(2))).catch((e) => e);
    expect(err).toBeInstanceOf(StaleHeadError);
    const versions = await getDb().select().from(diskVersions).where(eq(diskVersions.diskId, diskId));
    expect(versions).toHaveLength(2);
  });
});
