import { test, expect } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { randomUUID, createHash } from 'node:crypto';
import { getDb } from '@/db';
import { games, disks, blobs } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { signUpFresh } from './helpers';
import { signInAsSuperAdmin } from './admin-helpers';
import { cleanupSeeded, seedDisk, pairDevice } from './device-helpers';
import { cleanupTosec } from './tosec-helpers';
import {
  seedOpenRetroEntry, seedOpenRetroSha1, seedOpenRetroImage, cleanupOpenRetro, TINY_PNG,
} from './openretro-helpers';

test.afterAll(async () => { await cleanupOpenRetro(); await cleanupTosec(); await cleanupSeeded(); });

// Same reasoning as tosec-scan.spec.ts: /api/admin/scan runs the whole
// sweeper against the live database, whose own budget is 240 s.
const SWEEP_TIMEOUT_MS = 280_000;

/**
 * Give a blob a known sha1 and mark it decided for BOTH earlier phases.
 *
 * match_checked_at is stamped as well as hashed_at so phase 2 has nothing to
 * do -- this file is about phase 3, and leaving the blob unmatched would make
 * every test here pay for a full TOSEC candidate query it does not care about.
 */
async function readyBlob(sha256: string, salt: string) {
  const sha1 = createHash('sha1').update(sha256 + salt).digest('hex');
  await getDb().update(blobs).set({
    sha1, md5: null, crc32: null, hashedAt: new Date(),
    matchState: 'none', matchCheckedAt: new Date(),
    enrichState: null, enrichCheckedAt: null, openretroEntryId: null,
  }).where(eq(blobs.sha256, sha256));
  return sha1;
}

const freshSha = () => createHash('sha256').update(randomUUID()).digest('hex');

/**
 * Sign back in as an existing tenant. signInAsSuperAdmin replaces the page's
 * session with the operator's, and /games/[id] is org-scoped -- the operator
 * is not a member of the tenant's organization, so the page would 404 for
 * them. signUpFresh cannot be reused: it always creates a NEW account, and
 * this needs the one that owns the seeded game.
 */
async function signInAs(page: import('@playwright/test').Page, email: string, password: string) {
  await page.context().clearCookies();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/library/, { timeout: 15_000 });
}

async function gameRow(gameId: string) {
  const r = await getDb().select().from(games).where(eq(games.id, gameId));
  return r[0];
}

async function blobRow(sha256: string) {
  const r = await getDb().select().from(blobs).where(eq(blobs.sha256, sha256));
  return r[0];
}

test('a matched blob enriches its game', async ({ page }) => {
  test.setTimeout(SWEEP_TIMEOUT_MS);
  const user = await signUpFresh(page);
  const sha256 = freshSha();
  const { gameId } = await seedDisk(user.orgId, { title: 'pinball', diskNo: 1, sha256 });
  const sha1 = await readyBlob(sha256, 'enrich');

  const uuid = await seedOpenRetroEntry({
    gameName: 'Pinball Fantasies [AGA]', slug: 'pinball-fantasies-aga',
    publisher: '21st Century', developer: 'Digital Illusions', year: 1993,
    players: '1 - 8 (1)', tags: 'pinball, scrolling', chipset: 'AGA',
    longDescription: 'Four tables, each with its own ruleset.',
  });
  await seedOpenRetroSha1(sha1, uuid);

  await signInAsSuperAdmin(page);
  expect((await page.request.post('/api/admin/scan')).ok()).toBe(true);

  const g = await gameRow(gameId);
  expect(g.publisher).toBe('21st Century');
  expect(g.developer).toBe('Digital Illusions');
  expect(g.players).toBe('1 - 8 (1)');
  expect(g.genre).toBe('pinball, scrolling');
  expect(g.chipset).toBe('AGA');
  expect(g.description).toBe('Four tables, each with its own ruleset.');
  expect(g.factsSource).toBe('openretro');
  expect(g.proseSource).toBe('openretro');

  // Identity stays TOSEC's. Stamping metadataSource 'openretro' would lock
  // TOSEC out of ever correcting the title again.
  expect(g.metadataSource).toBe('filename');
  expect(g.title).toBe('pinball');

  const b = await blobRow(sha256);
  expect(b.enrichState).toBe('enriched');
  expect(b.openretroEntryId).toBe(uuid);
});

test('a human-edited game is not overwritten', async ({ page }) => {
  test.setTimeout(SWEEP_TIMEOUT_MS);
  const user = await signUpFresh(page);
  const sha256 = freshSha();
  const { gameId } = await seedDisk(user.orgId, { title: 'handmade', diskNo: 1, sha256 });
  const sha1 = await readyBlob(sha256, 'manual');

  // Anything outside MACHINE_SOURCES means a human decided it.
  await getDb().update(games)
    .set({ metadataSource: 'manual', publisher: 'My own note' })
    .where(eq(games.id, gameId));

  const uuid = await seedOpenRetroEntry({
    gameName: 'Some Game', publisher: 'Should Not Appear', developer: 'Nor This',
  });
  await seedOpenRetroSha1(sha1, uuid);

  await signInAsSuperAdmin(page);
  expect((await page.request.post('/api/admin/scan')).ok()).toBe(true);

  const g = await gameRow(gameId);
  expect(g.publisher).toBe('My own note');
  expect(g.developer).toBeNull();
  expect(g.factsSource).toBeNull();

  // The BLOB is still stamped enriched -- the entry was found, and the
  // authority rule is what declined the write. Asserting this pins the
  // difference between "no match" and "matched but protected".
  const b = await blobRow(sha256);
  expect(b.enrichState).toBe('enriched');
});

test('two entries for one sha1 is ambiguous and changes nothing', async ({ page }) => {
  test.setTimeout(SWEEP_TIMEOUT_MS);
  const user = await signUpFresh(page);
  const sha256 = freshSha();
  const { gameId } = await seedDisk(user.orgId, { title: 'contested', diskNo: 1, sha256 });
  const sha1 = await readyBlob(sha256, 'ambiguous');

  const a = await seedOpenRetroEntry({ gameName: 'Claimant A', publisher: 'Publisher A' });
  const b = await seedOpenRetroEntry({ gameName: 'Claimant B', publisher: 'Publisher B' });
  await seedOpenRetroSha1(sha1, a);
  await seedOpenRetroSha1(sha1, b);

  await signInAsSuperAdmin(page);
  expect((await page.request.post('/api/admin/scan')).ok()).toBe(true);

  const g = await gameRow(gameId);
  expect(g.publisher).toBeNull();
  expect(g.factsSource).toBeNull();

  const row = await blobRow(sha256);
  expect(row.enrichState).toBe('ambiguous');
  expect(row.openretroEntryId).toBeNull();
});

test('an enrichment sweep is NEVER observable as an eject', async ({ page, request }) => {
  test.setTimeout(SWEEP_TIMEOUT_MS);
  // The hazard the whole design is shaped around. devices.desiredDiskId has
  // no foreign key and readDesired joins on it; if a metadata pass re-keyed
  // a disk, that join would return nothing -- and "no disk desired" IS eject.
  const user = await signUpFresh(page);
  const sha256 = freshSha();
  const { diskId, gameId } = await seedDisk(user.orgId, { title: 'mounted', diskNo: 1, sha256 });
  // pairDevice uses the PAGE's tenant session, so it must run before
  // signInAsSuperAdmin swaps that session for the operator's.
  const device = await pairDevice(page, request, 'Enrich eject canary');

  const db = getDb();
  await db.update(devices).set({
    desiredSha256: sha256, desiredDiskId: diskId, desiredDiskNo: 1, desiredVersion: 7,
  }).where(eq(devices.id, device.deviceId));

  const sha1 = await readyBlob(sha256, 'eject');
  const uuid = await seedOpenRetroEntry({
    gameName: 'Mounted Game', publisher: 'Enriched Publisher',
  });
  await seedOpenRetroSha1(sha1, uuid);

  await signInAsSuperAdmin(page);
  expect((await page.request.post('/api/admin/scan')).ok()).toBe(true);

  // Assert the enrichment actually FIRED first. Without this the whole test
  // passes on a no-op sweep, which proves nothing at all about ejects.
  const g = await gameRow(gameId);
  expect(g.publisher).toBe('Enriched Publisher');

  const after = (await db.select().from(devices).where(eq(devices.id, device.deviceId)))[0];
  expect(after.desiredDiskId).toBe(diskId);
  expect(after.desiredSha256).toBe(sha256);
  expect(after.desiredVersion).toBe(7);

  // And the disk itself is still reachable by the exact id the device holds.
  const stillThere = await db.select().from(disks).where(eq(disks.id, diskId));
  expect(stillThere).toHaveLength(1);
});

test('the images reserve their space, so opening a title does not shift', async ({ page }) => {
  test.setTimeout(SWEEP_TIMEOUT_MS);
  const user = await signUpFresh(page);
  const sha256 = freshSha();
  const { gameId } = await seedDisk(user.orgId, { title: 'reserved', diskNo: 1, sha256 });
  const sha1 = await readyBlob(sha256, 'reserve');

  const uuid = await seedOpenRetroEntry({
    gameName: 'Reserved Game', slug: 'reserved-game', publisher: 'Reserver Ltd', year: 1993,
  });
  await seedOpenRetroSha1(sha1, uuid);
  const coverSha1 = createHash('sha1').update(`reserve-cover-${gameId}`).digest('hex');
  await seedOpenRetroImage({ sha1: coverSha1, entryUuid: uuid, kind: 'front' });
  const shotA = createHash('sha1').update(`reserve-shot-a-${gameId}`).digest('hex');
  const shotB = createHash('sha1').update(`reserve-shot-b-${gameId}`).digest('hex');
  await seedOpenRetroImage({ sha1: shotA, entryUuid: uuid, kind: 'screenshot', ordinal: 0 });
  await seedOpenRetroImage({ sha1: shotB, entryUuid: uuid, kind: 'screenshot', ordinal: 1 });

  await signInAsSuperAdmin(page);
  expect((await page.request.post('/api/admin/scan')).ok()).toBe(true);
  await signInAs(page, user.email, user.password);

  // Hold every image, so the page is measured in exactly the state that used
  // to be broken: markup present, bytes not yet arrived.
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/images/**', async (route) => { await gate; await route.continue(); });

  // domcontentloaded, not the default 'load': load waits for images, and the
  // images are exactly what this test is holding, so the default would
  // deadlock against its own route handler.
  await page.goto(`/games/${gameId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('game-facts')).toBeVisible();

  // THE REGRESSION. With h-auto and w-auto these boxes were 0 tall / 0 wide
  // until the bytes landed, so the card below the cover was painted at the
  // top of the page and then shoved down ~280px, and each screenshot shoved
  // its neighbours sideways as it decoded.
  const coverBox = page.getByTestId('game-cover').locator('..');
  const before = (await coverBox.boundingBox())!;
  expect(before.width).toBeGreaterThan(200);
  expect(before.height).toBeGreaterThan(260);   // 220 wide at 4/5 is 275

  const shots = page.getByTestId('game-screenshots').locator('img');
  await expect(shots).toHaveCount(2);
  const shotBefore = (await shots.first().boundingBox())!;
  expect(shotBefore.width).toBeGreaterThan(160); // 168 by CSS, not by content
  expect(shotBefore.height).toBeGreaterThan(125);

  // The facts column sits below/beside the cover; remember where it starts.
  const factsBefore = (await page.getByTestId('game-facts').boundingBox())!;

  release();
  await expect.poll(async () => page.getByTestId('game-cover')
    .evaluate((el: HTMLImageElement) => el.complete)).toBe(true);

  // Nothing moved when the bytes arrived. That is the whole point.
  const after = (await coverBox.boundingBox())!;
  const factsAfter = (await page.getByTestId('game-facts').boundingBox())!;
  expect(after.height).toBeCloseTo(before.height, 0);
  expect(after.width).toBeCloseTo(before.width, 0);
  expect(factsAfter.y).toBeCloseTo(factsBefore.y, 0);
  const shotAfter = (await shots.first().boundingBox())!;
  expect(shotAfter.width).toBeCloseTo(shotBefore.width, 0);
  expect(shotAfter.x).toBeCloseTo(shotBefore.x, 0);
});

test('the game page renders the enriched facts and the attribution link', async ({ page }) => {
  test.setTimeout(SWEEP_TIMEOUT_MS);
  const user = await signUpFresh(page);
  const sha256 = freshSha();
  const { gameId } = await seedDisk(user.orgId, { title: 'rendered', diskNo: 1, sha256 });
  const sha1 = await readyBlob(sha256, 'render');

  const uuid = await seedOpenRetroEntry({
    gameName: 'Rendered Game [AGA]', slug: 'rendered-game',
    publisher: 'Renderer Ltd', developer: 'Pixel Pushers', year: 1994,
    players: '1 - 2', tags: 'platform', chipset: 'AGA', languages: 'en, de',
    longDescription: 'A game that exists only in this test.',
    holUrl: 'http://hol.abime.net/9999',
  });
  await seedOpenRetroSha1(sha1, uuid);
  // Seeded rather than fetched: no test may reach openretro.org.
  const imageSha1 = createHash('sha1').update(`cover-${gameId}`).digest('hex');
  await seedOpenRetroImage({ sha1: imageSha1, entryUuid: uuid, kind: 'front' });

  await signInAsSuperAdmin(page);
  expect((await page.request.post('/api/admin/scan')).ok()).toBe(true);

  // Back to the tenant, since /games/[id] is org-scoped.
  await signInAs(page, user.email, user.password);

  await page.goto(`/games/${gameId}`);
  await expect(page.getByTestId('game-facts')).toBeVisible();
  await expect(page.getByTestId('fact-publisher')).toHaveText('Renderer Ltd');
  await expect(page.getByTestId('fact-developer')).toHaveText('Pixel Pushers');
  await expect(page.getByTestId('fact-chipset')).toHaveText('AGA');
  await expect(page.getByTestId('game-description')).toContainText('only in this test');
  // The cover must point at OUR route, not at openretro.org -- storing the
  // images locally is the whole reason the route exists.
  const cover = page.getByTestId('game-cover');
  await expect(cover).toBeVisible();
  await expect(cover).toHaveAttribute('src', `/api/images/${imageSha1}`);

  // And that route must really serve the stored bytes. Asserting only on the
  // <img> would pass just as happily against a 404, since a broken image is
  // still an element on the page.
  const served = await page.request.get(`/api/images/${imageSha1}`);
  expect(served.status()).toBe(200);
  expect(served.headers()['content-type']).toBe('image/png');
  expect((await served.body()).byteLength).toBe(TINY_PNG.byteLength);

  // A digest that is not a sha-1 is refused, so this route can never be
  // walked from oagd/ into adf/ where tenant data lives.
  expect((await page.request.get('/api/images/not-a-digest')).status()).toBe(400);

  const credit = page.getByTestId('openretro-credit').getByRole('link', { name: 'OpenRetro' });
  await expect(credit).toHaveAttribute('href', 'https://openretro.org/amiga/rendered-game');
});
