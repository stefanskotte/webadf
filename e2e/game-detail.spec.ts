import { test, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { disks, blobs } from '@/db/schema/catalog';
import { signUpFresh, runTag } from './helpers';
import { pairDevice, seedDisk, addDisk, cleanupSeeded } from './device-helpers';

test.afterAll(cleanupSeeded);

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function deviceRow(deviceId: string) {
  const r = await getDb().select().from(devices).where(eq(devices.id, deviceId));
  return r[0];
}

async function diskRow(diskId: string) {
  const r = await getDb().select().from(disks).where(eq(disks.id, diskId));
  return r[0];
}

/** Same pattern as devices-page.spec.ts's setDevice: write directly to a
 * devices row to put it into a specific state without the real protocol. */
async function setDevice(deviceId: string, patch: Partial<typeof devices.$inferInsert>) {
  await getDb().update(devices).set(patch).where(eq(devices.id, deviceId));
}

test('the route resolves and shows the game title', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const { gameId } = await seedDisk(orgId, { title: `RouteTest-${tag}`, diskNo: 1, sha256: sha(`${tag}-1`) });
  await addDisk(orgId, gameId, { diskNo: 2, sha256: sha(`${tag}-2`) });

  const res = await page.goto(`/games/${gameId}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: `RouteTest-${tag}` })).toBeVisible();
});

test("a game from another organization 404s, while the signed-in org's own game still resolves", async ({ page, browser }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const { gameId: ownGameId } = await seedDisk(orgId, { title: `OwnOrg-${tag}`, diskNo: 1, sha256: sha(`${tag}-own`) });

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  const { orgId: orgB } = await signUpFresh(pageB);
  const { gameId: gameIdB } = await seedDisk(orgB, { title: `OtherOrg-${tag}`, diskNo: 1, sha256: sha(`${tag}-b`) });
  await ctxB.close();

  // The positive half is what makes the negative half mean something:
  // without it, a route that 404s unconditionally (e.g. one that doesn't
  // exist yet) would also satisfy "the other org's game 404s".
  const ownRes = await page.goto(`/games/${ownGameId}`);
  expect(ownRes?.status()).toBe(200);

  const otherRes = await page.goto(`/games/${gameIdB}`);
  expect(otherRes?.status()).toBe(404);
});

test('every disk in the set is listed in disk_no order, with the boot badge on the boot disk only', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  // disk_no 2 is seeded (and therefore inserted) first, and the boot disk
  // (disk_no 1) is added second -- so a test that passed on insertion order
  // rather than disk_no order would be caught here.
  const { gameId, diskId: diskTwoId } = await seedDisk(orgId, { title: `Order-${tag}`, diskNo: 2, sha256: sha(`${tag}-2`) });
  const { diskId: diskOneId } = await addDisk(orgId, gameId, { diskNo: 1, sha256: sha(`${tag}-1`) });
  await getDb().update(disks).set({ isBoot: true }).where(eq(disks.id, diskOneId));

  await page.goto(`/games/${gameId}`);

  const rows = page.locator('[data-testid^="disk-"]');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute('data-testid', `disk-${diskOneId}`);
  await expect(rows.nth(1)).toHaveAttribute('data-testid', `disk-${diskTwoId}`);
  await expect(rows.nth(0)).toContainText('Disk 1');
  await expect(rows.nth(1)).toContainText('Disk 2');
  await expect(rows.nth(0)).toContainText('Boot');
  await expect(rows.nth(1)).not.toContainText('Boot');
});

test('the write-protect toggle round-trips', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const { gameId, diskId } = await seedDisk(orgId, { title: `WP-${tag}`, diskNo: 1, sha256: sha(tag) });

  await page.goto(`/games/${gameId}`);

  const toggle = page.getByTestId(`wp-${diskId}`);
  // seedDisk does not set writeProtected, so the schema default (protected) applies.
  await expect(toggle).toHaveAttribute('data-protected', 'true');
  expect((await diskRow(diskId)).writeProtected).toBe(true);

  await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/disks/${diskId}`) && r.request().method() === 'PATCH'),
    toggle.click(),
  ]);
  expect((await diskRow(diskId)).writeProtected).toBe(false);
  await expect(page.getByTestId(`wp-${diskId}`)).toHaveAttribute('data-protected', 'false');

  await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/disks/${diskId}`) && r.request().method() === 'PATCH'),
    page.getByTestId(`wp-${diskId}`).click(),
  ]);
  expect((await diskRow(diskId)).writeProtected).toBe(true);
  await expect(page.getByTestId(`wp-${diskId}`)).toHaveAttribute('data-protected', 'true');
});

test('with no devices paired, the action is a link to pair rather than a mount button', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const { gameId, diskId } = await seedDisk(orgId, { title: `NoDevice-${tag}`, diskNo: 1, sha256: sha(tag) });

  await page.goto(`/games/${gameId}`);
  await expect(page.getByTestId(`mount-${diskId}-none`)).toBeVisible();
  await expect(page.getByTestId(`mount-${diskId}-none`)).toHaveAttribute('href', '/devices');
  // The plain-button testid is a different string, but prove the button
  // itself is truly absent, not merely a same-name element hidden by CSS.
  await expect(page.getByTestId(`mount-${diskId}`)).toHaveCount(0);
});

test('with exactly one device paired, a plain Mount button sets desiredDiskId on that device', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  const tag = runTag();
  const { gameId, diskId } = await seedDisk(orgId, { title: `OneDevice-${tag}`, diskNo: 1, sha256: sha(tag) });

  await page.goto(`/games/${gameId}`);
  const btn = page.getByTestId(`mount-${diskId}`);
  await expect(btn).toHaveText('Mount');
  await expect(page.getByTestId(`mount-${diskId}-menu`)).toHaveCount(0);

  await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/devices/${deviceId}/mount`) && r.request().method() === 'POST'),
    btn.click(),
  ]);

  expect((await deviceRow(deviceId)).desiredDiskId).toBe(diskId);
});

test('with two devices paired, choosing the second in the menu mounts to the second device only', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId: deviceIdA } = await pairDevice(page, request, 'Device A');
  const { deviceId: deviceIdB } = await pairDevice(page, request, 'Device B');
  const tag = runTag();
  const { gameId, diskId } = await seedDisk(orgId, { title: `TwoDevice-${tag}`, diskNo: 1, sha256: sha(tag) });

  await page.goto(`/games/${gameId}`);
  const menuBtn = page.getByTestId(`mount-${diskId}`);
  await expect(menuBtn).toHaveText('Mount to ▾');

  await menuBtn.click();
  const menu = page.getByTestId(`mount-${diskId}-menu`);
  await expect(menu).toBeVisible();
  await expect(menu.getByTestId(`mount-${diskId}-to-${deviceIdA}`)).toBeVisible();
  await expect(menu.getByTestId(`mount-${diskId}-to-${deviceIdB}`)).toBeVisible();

  // Escape closes the menu -- only possible once the hand-rolled popover was
  // replaced with the real Menu primitive, which wires this up natively.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // Clicking anywhere else on the page closes it too.
  await menuBtn.click();
  await expect(menu).toBeVisible();
  await page.getByRole('heading', { name: `TwoDevice-${tag}` }).click();
  await expect(menu).toHaveCount(0);

  await menuBtn.click();
  await expect(menu).toBeVisible();

  await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/devices/${deviceIdB}/mount`) && r.request().method() === 'POST'),
    menu.getByTestId(`mount-${diskId}-to-${deviceIdB}`).click(),
  ]);

  // The chosen device changed. The OTHER device did not -- a test that only
  // checked "something got mounted" would pass even if the target were ignored.
  expect((await deviceRow(deviceIdB)).desiredDiskId).toBe(diskId);
  expect((await deviceRow(deviceIdA)).desiredDiskId).toBeNull();
});

test('a disk held by a device shows its holder text, and a stale holder reads "not confirmed" rather than "In {device}"', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId: deviceIdConverged } = await pairDevice(page, request, 'Converged Device');
  const { deviceId: deviceIdStale } = await pairDevice(page, request, 'Stale Device');
  const tag = runTag();
  const { gameId: gameConverged, diskId: diskConverged } =
    await seedDisk(orgId, { title: `Converged-${tag}`, diskNo: 1, sha256: sha(`${tag}-c`) });
  const { gameId: gameStale, diskId: diskStale } =
    await seedDisk(orgId, { title: `Stale-${tag}`, diskNo: 1, sha256: sha(`${tag}-s`) });

  // converged: desired == mounted, seen now.
  await setDevice(deviceIdConverged, {
    desiredGameId: gameConverged, desiredDiskId: diskConverged, desiredSha256: sha(`${tag}-c`), desiredDiskNo: 1,
    mountedGameId: gameConverged, mountedDiskId: diskConverged, mountedSha256: sha(`${tag}-c`), mountedDiskNo: 1,
    lastSeenAt: new Date(),
  });
  // stale: desired set, nothing mounted, not seen for 5 minutes (> STALE_AFTER_MS).
  await setDevice(deviceIdStale, {
    desiredGameId: gameStale, desiredDiskId: diskStale, desiredSha256: sha(`${tag}-s`), desiredDiskNo: 1,
    mountedGameId: null, mountedDiskId: null, mountedSha256: null, mountedDiskNo: null,
    lastSeenAt: new Date(Date.now() - 5 * 60_000),
  });

  await page.goto(`/games/${gameConverged}`);
  const holderConverged = page.getByTestId(`holder-${diskConverged}`);
  await expect(holderConverged).toHaveText(/^In /);
  await expect(holderConverged).not.toContainText('not confirmed');

  await page.goto(`/games/${gameStale}`);
  const holderStale = page.getByTestId(`holder-${diskStale}`);
  await expect(holderStale).toContainText('not confirmed');
  await expect(holderStale).not.toHaveText(/^In /);
});

test("a disk row whose org_id diverges from its game's org_id is never shown (defense in depth)", async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const { gameId } = await seedDisk(orgId, { title: `Divergent-${tag}`, diskNo: 1, sha256: sha(`${tag}-legit`) });

  // Nothing in the schema stops a disks row from naming a game_id that
  // belongs to one org while the row's own org_id names another -- disks
  // has no composite FK tying it to its game's org (see getGameDetail's own
  // comment). No seeding helper ever creates that divergence, so it is
  // written directly here: game_id points at THIS org's game, but org_id
  // names a different one entirely.
  const rogueSha = sha(`${tag}-rogue`);
  const rogueDiskId = randomUUID();
  await getDb().insert(blobs).values({ sha256: rogueSha, sizeBytes: 901120, storageKey: `adf/${rogueSha}` }).onConflictDoNothing();
  await getDb().insert(disks).values({
    id: rogueDiskId, gameId, orgId: `org-rogue-${tag}`, diskNo: 2, sha256: rogueSha,
    label: 'Rogue disk', sizeBytes: 901120,
  });

  try {
    await page.goto(`/games/${gameId}`);
    // The positive half: the page renders and shows the legitimately-scoped
    // disk, proving the absence below is the org filter at work and not the
    // page having failed to load at all.
    await expect(page.locator('[data-testid^="disk-"]')).toHaveCount(1);
    await expect(page.getByTestId(`disk-${rogueDiskId}`)).toHaveCount(0);
  } finally {
    // Inserted directly, outside device-helpers' registry -- clean up here.
    await getDb().delete(disks).where(eq(disks.id, rogueDiskId));
    await getDb().delete(blobs).where(eq(blobs.sha256, rogueSha));
  }
});
