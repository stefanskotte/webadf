import { test, expect } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { randomUUID, createHash } from 'node:crypto';
import { getDb } from '@/db';
import { games, disks, blobs } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { signUpFresh } from './helpers';
import { signInAsSuperAdmin } from './admin-helpers';
import { cleanupSeeded, seedDisk, pairDevice } from './device-helpers';
import { seedTosecEntry, cleanupTosec } from './tosec-helpers';

test.afterAll(async () => { await cleanupTosec(); await cleanupSeeded(); });

/** Give a blob known hashes directly, so the sweeper's match phase can run. */
async function fakeHashes(sha256: string) {
  const sha1 = createHash('sha1').update(sha256).digest('hex');
  await getDb().update(blobs)
    .set({ sha1, md5: null, crc32: null, hashedAt: new Date() })
    .where(eq(blobs.sha256, sha256));
  return sha1;
}

test('a hash match retitles a badly named disk', async ({ page }) => {
  const user = await signUpFresh(page);
  const sha256 = randomUUID().replace(/-/g, '').padEnd(64, '0');
  // Deliberately the badly-named case: "stateart" carries no year, no publisher.
  await seedDisk(user.orgId, { title: 'stateart', diskNo: 1, sha256 });
  const sha1 = await fakeHashes(sha256);

  await seedTosecEntry({
    gameName: 'State of the Art (1992)(Spaceballs)',
    romName: 'State of the Art (1992)(Spaceballs).adf',
    sha1, title: 'State of the Art', sortTitle: 'state of the art',
    year: 1992, publisher: 'Spaceballs',
  });

  await signInAsSuperAdmin(page);
  const res = await page.request.post('/api/admin/scan');
  expect(res.ok()).toBe(true);

  const db = getDb();
  const rows = await db.select().from(games).where(eq(games.orgId, user.orgId));
  expect(rows).toHaveLength(1);
  expect(rows[0].title).toBe('State of the Art');
  expect(rows[0].year).toBe(1992);
  expect(rows[0].publisher).toBe('Spaceballs');
  expect(rows[0].metadataSource).toBe('tosec');
});

test('two games TOSEC resolves to one are merged, keeping every disk', async ({ page }) => {
  const user = await signUpFresh(page);
  const shaA = randomUUID().replace(/-/g, '').padEnd(64, '0');
  const shaB = randomUUID().replace(/-/g, '').padEnd(64, '1');
  await seedDisk(user.orgId, { title: 'turrican2', diskNo: 1, sha256: shaA });
  await seedDisk(user.orgId, { title: 'Turrican II', diskNo: 2, sha256: shaB });

  for (const [sha, diskNo] of [[shaA, 1], [shaB, 2]] as const) {
    const sha1 = await fakeHashes(sha);
    await seedTosecEntry({
      gameName: `Turrican II (1991)(Rainbow Arts)(Disk ${diskNo} of 2)`,
      romName: `Turrican II (1991)(Rainbow Arts)(Disk ${diskNo} of 2).adf`,
      sha1, title: 'Turrican II', sortTitle: 'turrican ii',
      year: 1991, publisher: 'Rainbow Arts', diskNo, diskCount: 2,
    });
  }

  await signInAsSuperAdmin(page);
  expect((await page.request.post('/api/admin/scan')).ok()).toBe(true);

  const db = getDb();
  const rows = await db.select().from(games).where(eq(games.orgId, user.orgId));
  expect(rows).toHaveLength(1);
  const kept = await db.select().from(disks).where(eq(disks.gameId, rows[0].id));
  expect(kept).toHaveLength(2);
});

test('a sweep is NEVER observable as an eject', async ({ page, request }) => {
  // The hazard this whole design is shaped around. devices.desiredDiskId has
  // no foreign key and readDesired joins on it; if a sweep re-keyed disks the
  // join would return nothing, and "no disk desired" IS eject.
  const user = await signUpFresh(page);
  const sha256 = randomUUID().replace(/-/g, '').padEnd(64, '2');
  const { diskId, gameId } = await seedDisk(user.orgId, { title: 'stateart', diskNo: 1, sha256 });
  // pairDevice is the only device-creating helper this repo has: it goes
  // through the real pair + register flow and registers the id for cleanup.
  const device = await pairDevice(page, request, 'Eject canary');

  const db = getDb();
  await db.update(devices).set({
    desiredSha256: sha256, desiredDiskId: diskId, desiredDiskNo: 1, desiredVersion: 7,
  }).where(eq(devices.id, device.deviceId));

  const sha1 = await fakeHashes(sha256);
  // setName MUST differ from "a hash match retitles a badly named disk"
  // above: seedTosecEntry defaults setName to 'e2e-set' and derives its row
  // id from stableId('tosec', setName, romName) alone -- the sha1 plays no
  // part in the id. Reusing that test's identical romName under the same
  // default setName would collide onto the SAME row, and its
  // .onConflictDoNothing() would silently keep whichever entry landed
  // first (that test's sha1, not this one's), making a match here
  // impossible regardless of what sweep()/applyMatch() actually do. Found
  // via the premise assertion below failing deterministically -- in
  // isolation, with no other test or file involved -- until this was fixed.
  await seedTosecEntry({
    setName: 'e2e-set-eject',
    gameName: 'State of the Art (1992)(Spaceballs)',
    romName: 'State of the Art (1992)(Spaceballs).adf',
    sha1, title: 'State of the Art', sortTitle: 'state of the art',
    year: 1992, publisher: 'Spaceballs',
  });

  await signInAsSuperAdmin(page);
  expect((await page.request.post('/api/admin/scan')).ok()).toBe(true);

  // Prove the premise first: the match actually fired and retitled the
  // game. Without this, a sweep()/applyMatch() that silently no-ops on this
  // exact fixture would leave every assertion below trivially true -- the
  // device invariants hold whether or not anything happened at all. This
  // test's whole value is being trustworthy on its own, not borrowing
  // credibility from "a hash match retitles a badly named disk" above.
  const game = (await db.select().from(games).where(eq(games.id, gameId)))[0];
  expect(game.title, 'the rename this test depends on must actually have fired').toBe('State of the Art');
  expect(game.metadataSource).toBe('tosec');

  const after = (await db.select().from(devices).where(eq(devices.id, device.deviceId)))[0];
  expect(after.desiredDiskId, 'a sweep must not move desired state').toBe(diskId);
  expect(after.desiredSha256).toBe(sha256);
  expect(after.desiredVersion, 'a sweep must not bump the version').toBe(7);
  // The disk row itself must still exist under the same id.
  expect(await db.select().from(disks).where(eq(disks.id, diskId))).toHaveLength(1);
});
