// Task 14 of the Amiga->web upload plan, against a real database (plan ruling PF5): the refused-bytes release never
// deletes bytes a live upload or a transfer names, and deleting a user's org deletes its amiga_uploads.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';

// A database of its own (the shared one is the live one).
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_housekeeping_test';
const url = new URL(base);
url.pathname = `/${DB}`;
process.env.DATABASE_URL = url.toString();
const storageDir = mkdtempSync(join(tmpdir(), 'webadf-housekeeping-'));
process.env.STORAGE_DIR = storageDir;
process.env.BLOB_READ_WRITE_TOKEN = '';

async function admin(stmt: string) {
  const c = new Client({ connectionString: base });
  await c.connect();
  try { await c.query(stmt); } finally { await c.end(); }
}

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { devices } = await import('@/db/schema/devices');
const { transfers } = await import('@/db/schema/transfers');
const { user, member, organization } = await import('@/db/schema/auth');
const { amigaUploads, amigaUploadChunks } = await import('@/db/schema/amiga-uploads');
const { diskStore } = await import('@/lib/storage');
const { releaseRefused } = await import('@/lib/ingest-complete');
const { deleteUserCascade } = await import('@/lib/admin-delete');
const { libraryShares, libraryShareCollections, remoteLibraries } = await import('@/db/schema/sharing');
const { collections } = await import('@/db/schema/collections');
const { blobs, games, disks } = await import('@/db/schema/catalog');

const db = () => getDb();
const put = async (text: string) => {
  const b = new TextEncoder().encode(text);
  const sha = createHash('sha256').update(b).digest('hex');
  await diskStore.put(sha, b);
  return sha;
};
const later = () => new Date(Date.now() + 3600_000);

describe('housekeeping', () => {
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

  it('a refused ADF/HFE release keeps bytes a live upload or any transfer names, and frees the rest', async () => {
    await db().insert(devices).values({ id: 'dev-r', orgId: 'org-r', name: 'B', tokenHash: 'h-r' });
    const [upl, deleted, xfer, nobody] = await Promise.all([put('upload'), put('deleted-upload'), put('transfer'), put('nobody')]);
    await db().insert(amigaUploads).values([
      { id: 'u1', orgId: 'org-r', deviceId: 'dev-r', deviceName: 'B', path: 'a', sizeBytes: 6, amigaDate: '1.1.1', status: 'stored', blobSha256: upl, expiresAt: later() },
      { id: 'u2', orgId: 'org-r', deviceId: 'dev-r', deviceName: 'B', path: 'b', sizeBytes: 6, amigaDate: '1.1.1', status: 'deleted', blobSha256: deleted, expiresAt: later() },
    ]);
    await db().insert(transfers).values({
      id: 't1', orgId: 'org-r', deviceId: 'dev-r', createdByUserId: 'x', path: 'c', sizeBytes: 8, crc32: 0, blobSha256: xfer, expiresAt: later(),
    });

    await releaseRefused([upl, deleted, xfer, nobody]);

    expect(await diskStore.stat(upl)).not.toBeNull();       // a live upload names it
    expect(await diskStore.stat(xfer)).not.toBeNull();      // a transfer names it
    expect(await diskStore.stat(deleted)).toBeNull();       // a deleted row names nothing
    expect(await diskStore.stat(nobody)).toBeNull();        // nothing names it: released
  });

  it('deleting a user (and their sole org) deletes the org amiga_uploads and their chunks, and no one else\'s', async () => {
    const now = new Date();
    await db().insert(user).values({ id: 'usr-d', name: 'D', email: 'd@example.test' });
    await db().insert(organization).values({ id: 'org-d', name: 'D', slug: 'org-d', createdAt: now });
    await db().insert(member).values({ id: 'mem-d', organizationId: 'org-d', userId: 'usr-d', createdAt: now });
    await db().insert(devices).values({ id: 'dev-d', orgId: 'org-d', name: 'B', tokenHash: 'h-d' });
    const row = (id: string, orgId: string, deviceId: string) =>
      ({ id, orgId, deviceId, deviceName: 'B', path: id, sizeBytes: 1, amigaDate: '1.1.1', status: 'receiving', expiresAt: later() });
    await db().insert(amigaUploads).values([row('d-mine', 'org-d', 'dev-d'), row('d-other', 'org-r', 'dev-r')]);
    await db().insert(amigaUploadChunks).values([
      { uploadId: 'd-mine', offset: 0, data: Buffer.from([1]) }, { uploadId: 'd-other', offset: 0, data: Buffer.from([2]) },
    ]);

    await deleteUserCascade('usr-d');

    expect(await db().select().from(amigaUploads).where(eq(amigaUploads.orgId, 'org-d'))).toHaveLength(0);
    expect(await db().select().from(amigaUploadChunks).where(eq(amigaUploadChunks.uploadId, 'd-mine'))).toHaveLength(0);
    expect(await db().select().from(amigaUploads).where(eq(amigaUploads.id, 'd-other'))).toHaveLength(1);
    expect(await db().select().from(amigaUploadChunks).where(eq(amigaUploadChunks.uploadId, 'd-other'))).toHaveLength(1);
  });
  it('deleting a user (and their sole org) deletes its shares, their links and its remote libraries, after the hidden rows (final review 4)', async () => {
    const now = new Date();
    await db().insert(user).values({ id: 'usr-s', name: 'S', email: 's@example.test' });
    await db().insert(organization).values({ id: 'org-s', name: 'S', slug: 'org-s', createdAt: now });
    await db().insert(member).values({ id: 'mem-s', organizationId: 'org-s', userId: 'usr-s', createdAt: now });
    const share = (id: string, orgId: string) =>
      ({ id, orgId, label: id, claimExpiresAt: later(), createdBy: 'x' });
    await db().insert(libraryShares).values([share('sh-mine', 'org-s'), share('sh-other', 'org-r')]);
    await db().insert(collections).values([{ id: 'c-mine', orgId: 'org-s', name: 'C' }, { id: 'c-other', orgId: 'org-r', name: 'C' }]);
    await db().insert(libraryShareCollections).values([
      { shareId: 'sh-mine', collectionId: 'c-mine' }, { shareId: 'sh-other', collectionId: 'c-other' },
    ]);
    const lib = (id: string, orgId: string) =>
      ({ id, orgId, baseUrl: 'https://owner.example', tokenEnc: 'v1.x', name: 'Rob', addedBy: 'x' });
    await db().insert(remoteLibraries).values([lib('rl-mine', 'org-s'), lib('rl-other', 'org-r')]);
    // A hidden pair: its FK to remote_libraries (no cascade) means the library can only go after it.
    const sha = 'e'.repeat(64);
    await db().insert(blobs).values({ sha256: sha, sizeBytes: 10, storageKey: sha }).onConflictDoNothing();
    await db().insert(games).values({ id: 'hg-s', orgId: 'org-s', title: 'H', sortTitle: 'h', remoteLibraryId: 'rl-mine', remoteTitleId: 't' });
    await db().insert(disks).values({ id: 'hd-s', gameId: 'hg-s', orgId: 'org-s', diskNo: 1, sha256: sha, sizeBytes: 10, remoteLibraryId: 'rl-mine', remoteDiskId: 'd' });

    await deleteUserCascade('usr-s');

    expect(await db().select().from(libraryShares).where(eq(libraryShares.orgId, 'org-s'))).toHaveLength(0);
    expect(await db().select().from(libraryShareCollections).where(eq(libraryShareCollections.shareId, 'sh-mine'))).toHaveLength(0);
    expect(await db().select().from(remoteLibraries).where(eq(remoteLibraries.orgId, 'org-s'))).toHaveLength(0);
    expect(await db().select().from(disks).where(eq(disks.id, 'hd-s'))).toHaveLength(0);
    // Someone else's stay.
    expect(await db().select().from(libraryShares).where(eq(libraryShares.id, 'sh-other'))).toHaveLength(1);
    expect(await db().select().from(libraryShareCollections).where(eq(libraryShareCollections.shareId, 'sh-other'))).toHaveLength(1);
    expect(await db().select().from(remoteLibraries).where(eq(remoteLibraries.id, 'rl-other'))).toHaveLength(1);
  });
});
