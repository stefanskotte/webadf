import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices, pairingCodes } from '@/db/schema/devices';
import { signUpFresh, runTag } from './helpers';
import { pairDevice, seedDisk, cleanupSeeded } from './device-helpers';

test.afterAll(cleanupSeeded);

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Write directly to a devices row -- how this spec drives a device into a
 * specific state without going through the real mount/eject/poll protocol. */
async function setDevice(deviceId: string, patch: Partial<typeof devices.$inferInsert>) {
  await getDb().update(devices).set(patch).where(eq(devices.id, deviceId));
}

test('the route resolves and shows the Devices heading', async ({ page }) => {
  await signUpFresh(page);
  const res = await page.goto('/devices');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Devices' })).toBeVisible();
});

test('a fresh org with no devices shows the empty-state copy', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/devices');
  await expect(page.getByText('No devices paired yet')).toBeVisible();
});

test('the header subtitle counts online devices by lastSeenAt, not just how many are paired', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId: idOnline } = await pairDevice(page, request, 'Online Device');
  const { deviceId: idDark } = await pairDevice(page, request, 'Dark Device');

  await setDevice(idOnline, { lastSeenAt: new Date() });
  // Well past STALE_AFTER_MS (60s) -- this device is paired but not online.
  await setDevice(idDark, { lastSeenAt: new Date(Date.now() - 60 * 60_000) });

  await page.goto('/devices');
  await expect(page.getByText('2 paired · 1 online', { exact: false })).toBeVisible();
});

test('the header online count follows a device coming online while the page is open', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request, 'Waking Device');
  await setDevice(deviceId, { lastSeenAt: new Date(Date.now() - 60 * 60_000) });

  await page.goto('/devices');
  await expect(page.getByText('1 paired · 0 online', { exact: false })).toBeVisible();

  // The board starts polling again. No reload: LiveRefresh must carry it.
  await setDevice(deviceId, { lastSeenAt: new Date() });
  await expect(page.getByText('1 paired · 1 online', { exact: false })).toBeVisible({ timeout: 15_000 });
});

test('the header online count drops when a device goes quiet while the page is open', async ({ page, request }) => {
  test.setTimeout(150_000);
  await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request, 'Quiet Device');
  // Seen 50 s ago: online now, stale (STALE_AFTER_MS = 60 s) about 10 s from now with no data change.
  await setDevice(deviceId, { lastSeenAt: new Date(Date.now() - 50_000) });

  await page.goto('/devices');
  await expect(page.getByText('1 paired · 1 online', { exact: false })).toBeVisible();
  await expect(page.getByText('1 paired · 0 online', { exact: false })).toBeVisible({ timeout: 60_000 });
});

test('all four device states render with distinct data-state and distinct visible text', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);

  const { deviceId: idConverged } = await pairDevice(page, request, 'Converged Device');
  const { deviceId: idPending } = await pairDevice(page, request, 'Pending Device');
  const { deviceId: idStale } = await pairDevice(page, request, 'Stale Device');
  const { deviceId: idEmpty } = await pairDevice(page, request, 'Empty Device');

  const tag = runTag();
  const { gameId: gameA, diskId: diskA } = await seedDisk(orgId, { title: `StateA-${tag}`, diskNo: 1, sha256: sha(`${tag}-a`) });
  const { gameId: gameB, diskId: diskB } = await seedDisk(orgId, { title: `StateB-${tag}`, diskNo: 1, sha256: sha(`${tag}-b`) });

  const now = new Date();
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000);

  // converged: desired == mounted, seen now.
  await setDevice(idConverged, {
    desiredGameId: gameA, desiredDiskId: diskA, desiredSha256: sha(`${tag}-a`), desiredDiskNo: 1,
    mountedGameId: gameA, mountedDiskId: diskA, mountedSha256: sha(`${tag}-a`), mountedDiskNo: 1,
    lastSeenAt: now,
  });
  // pending: desired and mounted differ, seen now.
  await setDevice(idPending, {
    desiredGameId: gameB, desiredDiskId: diskB, desiredSha256: sha(`${tag}-b`), desiredDiskNo: 1,
    mountedGameId: null, mountedDiskId: null, mountedSha256: null, mountedDiskNo: null,
    lastSeenAt: now,
  });
  // stale: same divergence as pending, but not seen for 5 minutes (> STALE_AFTER_MS).
  await setDevice(idStale, {
    desiredGameId: gameB, desiredDiskId: diskB, desiredSha256: sha(`${tag}-b`), desiredDiskNo: 1,
    mountedGameId: null, mountedDiskId: null, mountedSha256: null, mountedDiskNo: null,
    lastSeenAt: fiveMinAgo,
  });
  // empty: both null -- exactly the state a freshly-paired device is already in.

  await page.goto('/devices');

  const cardConverged = page.getByTestId(`device-${idConverged}`);
  const cardPending = page.getByTestId(`device-${idPending}`);
  const cardStale = page.getByTestId(`device-${idStale}`);
  const cardEmpty = page.getByTestId(`device-${idEmpty}`);

  await expect(cardConverged).toHaveAttribute('data-state', 'converged');
  await expect(cardPending).toHaveAttribute('data-state', 'pending');
  await expect(cardStale).toHaveAttribute('data-state', 'stale');
  await expect(cardEmpty).toHaveAttribute('data-state', 'empty');

  // The words, not just the attribute -- four cards with identical prose and
  // different data-state would pass an attribute-only assertion.
  await expect(cardConverged).toContainText('In the drive');
  await expect(cardPending).toContainText('Mounting…');
  await expect(cardStale).toContainText('Requested');
  await expect(cardEmpty).toContainText('No disk');
});

test('a stale card shows how long it has been since the device was last seen', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  const tag = runTag();
  const { gameId, diskId } = await seedDisk(orgId, { title: `Stale-${tag}`, diskNo: 1, sha256: sha(tag) });

  await setDevice(deviceId, {
    desiredGameId: gameId, desiredDiskId: diskId, desiredSha256: sha(tag), desiredDiskNo: 1,
    mountedGameId: null, mountedDiskId: null, mountedSha256: null, mountedDiskNo: null,
    lastSeenAt: new Date(Date.now() - 5 * 60_000),
  });

  await page.goto('/devices');
  const card = page.getByTestId(`device-${deviceId}`);
  await expect(card).toContainText('last seen');
  await expect(card).toContainText(/\d+m ago/);
});

test('last_error is displayed in the card for that device', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  const message = `SPI timeout ${runTag()}`;

  await setDevice(deviceId, { lastError: message, lastErrorAt: new Date() });

  await page.goto('/devices');
  await expect(page.getByTestId(`device-error-${deviceId}`)).toHaveText(message);
});

test('clicking eject nulls the desired disk and bumps the version', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  const tag = runTag();
  const { gameId, diskId } = await seedDisk(orgId, { title: `Eject-${tag}`, diskNo: 1, sha256: sha(tag) });

  await setDevice(deviceId, {
    desiredGameId: gameId, desiredDiskId: diskId, desiredSha256: sha(tag), desiredDiskNo: 1,
    mountedGameId: gameId, mountedDiskId: diskId, mountedSha256: sha(tag), mountedDiskNo: 1,
    lastSeenAt: new Date(), desiredVersion: 1,
  });

  await page.goto('/devices');

  const before = (await getDb().select().from(devices).where(eq(devices.id, deviceId)))[0];

  await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/devices/${deviceId}/eject`) && r.request().method() === 'POST'),
    page.getByTestId(`eject-${deviceId}`).click(),
  ]);

  const after = (await getDb().select().from(devices).where(eq(devices.id, deviceId)))[0];
  expect(after.desiredSha256).toBeNull();
  expect(after.desiredVersion).toBeGreaterThan(before.desiredVersion);
});

test("org B's device never appears on org A's page", async ({ page, request, browser }) => {
  await signUpFresh(page);
  // register/route.ts names every device "Device <mac>" -- the `name` given
  // to pairDevice() is accepted by /api/devices/pair but never persisted
  // (see that route's comment), so it cannot be used as the identifying
  // label here. The device's own id is the reliable handle.
  const { deviceId: deviceIdA } = await pairDevice(page, request, 'OrgA Device');

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await signUpFresh(pageB);
  const { deviceId: deviceIdB } = await pairDevice(pageB, request, 'OrgB Device');
  await ctxB.close();

  await page.goto('/devices');
  // The positive half is what makes the negative half mean something: without
  // it, a 404 or a blank page would also satisfy "org B's device is absent".
  await expect(page.getByTestId(`device-${deviceIdA}`)).toBeVisible();
  await expect(page.getByTestId(`device-${deviceIdB}`)).toHaveCount(0);
});

test('the desired title and the mounted title are not swapped', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  const tag = runTag();
  const { gameId: desiredGameId, diskId: desiredDiskId } = await seedDisk(orgId, { title: `DESIRED-${tag}`, diskNo: 1, sha256: sha(`${tag}-d`) });
  const { gameId: mountedGameId, diskId: mountedDiskId } = await seedDisk(orgId, { title: `MOUNTED-${tag}`, diskNo: 1, sha256: sha(`${tag}-m`) });

  await setDevice(deviceId, {
    desiredGameId, desiredDiskId, desiredSha256: sha(`${tag}-d`), desiredDiskNo: 1,
    mountedGameId, mountedDiskId, mountedSha256: sha(`${tag}-m`), mountedDiskNo: 1,
    lastSeenAt: new Date(),
  });

  await page.goto('/devices');
  const text = (await page.getByTestId(`device-${deviceId}`).textContent()) ?? '';

  const desiredIdx = text.indexOf(`DESIRED-${tag}`);
  const holdingIdx = text.indexOf('currently holding');
  const mountedIdx = text.indexOf(`MOUNTED-${tag}`);

  // DESIRED must be named as what's being mounted (before "currently holding")
  // and MOUNTED as what's currently held (after it) -- not the reverse.
  expect(desiredIdx).toBeGreaterThan(-1);
  expect(holdingIdx).toBeGreaterThan(-1);
  expect(mountedIdx).toBeGreaterThan(-1);
  expect(desiredIdx).toBeLessThan(holdingIdx);
  expect(holdingIdx).toBeLessThan(mountedIdx);
});

test("a device pointing at another organization's game shows no title from it", async ({ page, request, browser }) => {
  await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  const { orgId: orgB } = await signUpFresh(pageB);
  const tag = runTag();
  const leakedTitle = `LEAKED-${tag}`;
  const { gameId: orgBGameId, diskId: orgBDiskId } = await seedDisk(orgB, { title: leakedTitle, diskNo: 1, sha256: sha(`${tag}-leak`) });
  await ctxB.close();

  // devices.desired_game_id has no foreign key -- nothing in the schema stops
  // this row from naming another org's game. The org-scoped join in
  // listDevices is the only thing standing between this and a leaked title.
  await setDevice(deviceId, {
    desiredGameId: orgBGameId, desiredDiskId: orgBDiskId, desiredSha256: sha(`${tag}-leak`), desiredDiskNo: 1,
    lastSeenAt: new Date(),
  });

  await page.goto('/devices');
  const text = await page.getByTestId(`device-${deviceId}`).textContent();
  expect(text).not.toContain(leakedTitle);
});

test('a pending eject says "Ejecting", never "Mounting"', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  const tag = runTag();
  const { gameId, diskId } = await seedDisk(orgId, { title: `HeldForEject-${tag}`, diskNo: 1, sha256: sha(tag) });

  // Same shape as a pending mount (desired != mounted, seen now) but with
  // nothing desired -- an eject in flight, not a mount in flight.
  await setDevice(deviceId, {
    desiredGameId: null, desiredDiskId: null, desiredSha256: null, desiredDiskNo: null,
    mountedGameId: gameId, mountedDiskId: diskId, mountedSha256: sha(tag), mountedDiskNo: 1,
    lastSeenAt: new Date(),
  });

  await page.goto('/devices');
  const text = await page.getByTestId(`device-${deviceId}`).textContent();
  expect(text).toContain('Ejecting');
  expect(text).not.toContain('Mounting');
});

// --- the square-card redesign (option A -- "the disk in the middle") -----

test('three paired devices share one row of the grid and are roughly square', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId: idA } = await pairDevice(page, request, 'Card A');
  const { deviceId: idB } = await pairDevice(page, request, 'Card B');
  const { deviceId: idC } = await pairDevice(page, request, 'Card C');

  // Default desktop viewport (playwright.config.ts's "desktop" project sets
  // none, so this is 1280x720) is above the lg breakpoint device-list.tsx
  // switches on -- 3 per row is what should render here.
  await page.goto('/devices');
  const a = (await page.getByTestId(`device-${idA}`).boundingBox())!;
  const b = (await page.getByTestId(`device-${idB}`).boundingBox())!;
  const c = (await page.getByTestId(`device-${idC}`).boundingBox())!;

  // Same row: all three tops line up.
  expect(Math.abs(a.y - b.y)).toBeLessThan(4);
  expect(Math.abs(a.y - c.y)).toBeLessThan(4);

  // Roughly square -- these are freshly paired devices with nothing mounted,
  // so there is no long title or error to grow a card past its aspect-ratio.
  // A generous tolerance because "at least square, grows taller" (the spec)
  // deliberately does not promise an EXACT ratio once real content is in it.
  for (const box of [a, b, c]) {
    expect(box.height / box.width).toBeGreaterThan(0.8);
    expect(box.height / box.width).toBeLessThan(1.3);
  }
});

test('the Online/Offline badge renders both values, and only Offline gets a last-seen line', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId: idOnline } = await pairDevice(page, request, 'Badge Online');
  const { deviceId: idOffline } = await pairDevice(page, request, 'Badge Offline');

  await setDevice(idOnline, { lastSeenAt: new Date() });
  await setDevice(idOffline, { lastSeenAt: new Date(Date.now() - 60 * 60_000) });

  await page.goto('/devices');
  await expect(page.getByTestId(`device-status-${idOnline}`)).toHaveText('Online');
  await expect(page.getByTestId(`device-status-${idOffline}`)).toHaveText('Offline');

  // Both states are visibly rendered -- a badge in each, never an absent icon
  // standing in for one of them.
  await expect(page.getByTestId(`device-last-seen-${idOnline}`)).toHaveCount(0);
  await expect(page.getByTestId(`device-${idOffline}`)).toContainText('last seen');
});

test('the write-protect tag reads the MOUNTED disk: Protected, Writable, or "—" when empty', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId: idProtected } = await pairDevice(page, request, 'WP Protected');
  const { deviceId: idWritable } = await pairDevice(page, request, 'WP Writable');
  const { deviceId: idEmpty } = await pairDevice(page, request, 'WP Empty');
  const tag = runTag();

  const { gameId: gameP, diskId: diskP } = await seedDisk(orgId, {
    title: `WP-Protected-${tag}`, diskNo: 1, sha256: sha(`${tag}-p`), writeProtected: true,
  });
  const { gameId: gameW, diskId: diskW } = await seedDisk(orgId, {
    title: `WP-Writable-${tag}`, diskNo: 1, sha256: sha(`${tag}-w`), writeProtected: false,
  });

  // Mounted (not merely desired) is what the tag reads -- both desired and
  // mounted are set to the same disk here so `deviceState` reads 'converged'
  // and the mount is not merely in flight.
  await setDevice(idProtected, {
    desiredGameId: gameP, desiredDiskId: diskP, desiredSha256: sha(`${tag}-p`), desiredDiskNo: 1,
    mountedGameId: gameP, mountedDiskId: diskP, mountedSha256: sha(`${tag}-p`), mountedDiskNo: 1,
    lastSeenAt: new Date(),
  });
  await setDevice(idWritable, {
    desiredGameId: gameW, desiredDiskId: diskW, desiredSha256: sha(`${tag}-w`), desiredDiskNo: 1,
    mountedGameId: gameW, mountedDiskId: diskW, mountedSha256: sha(`${tag}-w`), mountedDiskNo: 1,
    lastSeenAt: new Date(),
  });
  // idEmpty stays exactly as pairDevice left it -- nothing desired or mounted.

  await page.goto('/devices');
  await expect(page.getByTestId(`device-protection-${idProtected}`)).toHaveText('Protected');
  await expect(page.getByTestId(`device-protection-${idWritable}`)).toHaveText('Writable');
  await expect(page.getByTestId(`device-protection-${idEmpty}`)).toHaveText('—');
});

test('a pairing code is shown with a live expiry, and disappears when it expires', async ({ page }) => {
  await page.clock.install();
  await signUpFresh(page);
  await page.goto('/devices');

  const [pairResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/devices/pair') && r.request().method() === 'POST'),
    page.getByTestId('pair-device').click(),
  ]);
  const { code: mintedCode } = await pairResponse.json();

  try {
    await expect(page.getByTestId('pairing-code')).toBeVisible();
    const expiry = page.getByTestId('pairing-expiry');
    await expect(expiry).toHaveText(/expires in \d+:\d\d/);

    const before = await expiry.textContent();
    await page.clock.fastForward('00:30');
    await expect(expiry).not.toHaveText(before ?? '');

    await page.clock.fastForward('10:00');
    // The code is gone, not merely disabled or greyed out -- it would send
    // someone to the hardware to type something that can no longer work.
    await expect(page.getByTestId('pairing-code')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Mint a new code/i })).toBeVisible();
  } finally {
    // This code was minted by clicking the UI, not through pairDevice(), so
    // it never entered device-helpers' own cleanup registry. Delete it here.
    await getDb().delete(pairingCodes).where(eq(pairingCodes.code, mintedCode));
  }
});
