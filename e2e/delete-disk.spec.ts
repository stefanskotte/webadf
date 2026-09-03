import { test, expect } from '@playwright/test';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDb } from '@/db';
import { games, disks, blobs, entitlements } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { signUpFresh, runTag } from './helpers';
import { cleanupSeeded, seedDisk, pairDevice } from './device-helpers';

test.afterAll(cleanupSeeded);

const freshSha = () => randomUUID().replace(/-/g, '').padEnd(64, '0');
const gameRows = async (id: string) => getDb().select().from(games).where(eq(games.id, id));
const diskRows = async (id: string) => getDb().select().from(disks).where(eq(disks.id, id));

test('deleting a title asks first, then removes it and its disks', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const sha = freshSha();
  const { gameId, diskId } = await seedDisk(u.orgId, { title: `Doomed ${run}`, diskNo: 1, sha256: sha });

  await page.goto('/library');
  await expect(page.getByTestId('game-card')).toHaveCount(1);

  // It asks. A delete that just happens on one click is not what was asked
  // for, and this one ejects hardware.
  await page.getByTestId(`delete-game-${gameId}`).click();
  await expect(page.getByTestId('delete-dialog')).toBeVisible();

  // And it can be declined.
  await page.getByTestId('delete-cancel').click();
  await expect(page.getByTestId('delete-dialog')).toHaveCount(0);
  expect(await gameRows(gameId)).toHaveLength(1);

  await page.getByTestId(`delete-game-${gameId}`).click();
  await page.getByTestId('delete-confirm').click();
  await expect(page.getByTestId('game-card')).toHaveCount(0);

  expect(await gameRows(gameId)).toHaveLength(0);
  expect(await diskRows(diskId)).toHaveLength(0);
});

test('the blob survives, and only this org loses its claim on the bytes', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const sha = freshSha();
  const { gameId } = await seedDisk(u.orgId, { title: `Shared ${run}`, diskNo: 1, sha256: sha });

  const res = await page.request.delete(`/api/games/${gameId}`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.releasedSha256).toContain(sha);

  // THE BLOB IS GLOBAL. Another tenant may hold these exact bytes, so
  // destroying the object would break their library. Only the entitlement --
  // this org's claim -- goes, which is what makes the blob reclaimable later.
  const blob = await getDb().select().from(blobs).where(eq(blobs.sha256, sha));
  expect(blob).toHaveLength(1);
  const ent = await getDb().select().from(entitlements)
    .where(and(eq(entitlements.orgId, u.orgId), eq(entitlements.sha256, sha)));
  expect(ent).toHaveLength(0);
});

test('an entitlement is kept while another disk in the same library still needs it', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const sha = freshSha();
  // The same bytes backing two titles -- a duplicate upload, which is
  // ordinary. Removing the entitlement on the first delete would break the
  // survivor's download and its device fetch, because the entitlement IS the
  // boundary those paths check.
  const a = await seedDisk(u.orgId, { title: `Twin A ${run}`, diskNo: 1, sha256: sha });
  const b = await seedDisk(u.orgId, { title: `Twin B ${run}`, diskNo: 1, sha256: sha });

  expect((await page.request.delete(`/api/games/${a.gameId}`)).status()).toBe(200);

  const ent = await getDb().select().from(entitlements)
    .where(and(eq(entitlements.orgId, u.orgId), eq(entitlements.sha256, sha)));
  expect(ent).toHaveLength(1);

  // ...and the survivor is intact, still pointing at those bytes. Not
  // asserted by downloading them: seedDisk writes a byte-less blob row, so
  // /adf answers 503 for any seeded disk regardless of entitlement.
  const survivor = await diskRows(b.diskId);
  expect(survivor).toHaveLength(1);
  expect(survivor[0].sha256).toBe(sha);
});

test('a device holding the disk is ejected deliberately, with its version bumped', async ({ page, request }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const sha = freshSha();
  const { gameId, diskId } = await seedDisk(u.orgId, { title: `Mounted ${run}`, diskNo: 1, sha256: sha });
  const { deviceId } = await pairDevice(page, request, `Board ${run}`);

  expect((await page.request.post(`/api/devices/${deviceId}/mount`, {
    data: { diskId },
  })).ok()).toBe(true);

  const before = (await getDb().select().from(devices).where(eq(devices.id, deviceId)))[0];
  expect(before.desiredDiskId).toBe(diskId);

  const res = await page.request.delete(`/api/games/${gameId}`);
  expect(res.status()).toBe(200);
  // One device named, not a specific name: a board reports its own name from
  // its MAC when it registers, so pairDevice's label is not what lands here.
  expect((await res.json()).ejected).toHaveLength(1);

  const after = (await getDb().select().from(devices).where(eq(devices.id, deviceId)))[0];
  expect(after.desiredDiskId).toBeNull();
  expect(after.desiredSha256).toBeNull();
  // THE BUMP IS THE POINT. disks.gameId cascades, so the row would vanish
  // either way and readDesired's LEFT JOIN would quietly return nothing --
  // but the long poll is gated on desiredVersion, so without this the board
  // sits for 25 s and never learns the disk is gone.
  expect(after.desiredVersion).toBeGreaterThan(before.desiredVersion);
});

test('deleting one disk of a set leaves the others and the title', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const one = await seedDisk(u.orgId, { title: `Multi ${run}`, diskNo: 1, sha256: freshSha() });

  // A second disk on the SAME title. The blob goes in first: disks.sha256
  // carries a foreign key onto blobs.sha256, so the other order fails.
  const secondSha = freshSha();
  await getDb().insert(blobs).values({
    sha256: secondSha, sizeBytes: 901_120, storageKey: `adf/${secondSha}`,
  }).onConflictDoNothing();
  await getDb().insert(entitlements)
    .values({ orgId: u.orgId, sha256: secondSha, sourceFilename: 'two.adf' })
    .onConflictDoNothing();
  await getDb().insert(disks).values({
    id: `dsk_${randomUUID()}`, gameId: one.gameId, orgId: u.orgId,
    diskNo: 2, sha256: secondSha, isBoot: false, sizeBytes: 901_120,
  });
  const second = (await getDb().select().from(disks)
    .where(and(eq(disks.gameId, one.gameId), eq(disks.diskNo, 2))))[0];

  const res = await page.request.delete(`/api/disks/${second.id}`);
  expect(res.status()).toBe(200);
  expect((await res.json()).gameDeleted).toBe(false);

  expect(await diskRows(second.id)).toHaveLength(0);
  expect(await diskRows(one.diskId)).toHaveLength(1);
  expect(await gameRows(one.gameId)).toHaveLength(1);

  // ...and removing the last one takes the title with it, because a title
  // with no disks is not a title.
  expect((await page.request.delete(`/api/disks/${one.diskId}`)).status()).toBe(200);
  expect(await gameRows(one.gameId)).toHaveLength(0);
});

test('another tenant cannot delete, and gets 404 rather than 403', async ({ browser }) => {
  const run = runTag();
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pa = await a.newPage();
  const pb = await b.newPage();
  const ua = await signUpFresh(pa);
  await signUpFresh(pb);
  const { gameId, diskId } = await seedDisk(ua.orgId, { title: `Theirs ${run}`, diskNo: 1, sha256: freshSha() });

  expect((await pb.request.delete(`/api/games/${gameId}`)).status()).toBe(404);
  expect((await pb.request.delete(`/api/disks/${diskId}`)).status()).toBe(404);
  expect(await gameRows(gameId)).toHaveLength(1);
  expect(await diskRows(diskId)).toHaveLength(1);

  await a.close();
  await b.close();
});
