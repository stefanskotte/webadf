import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices, pairingCodes } from '@/db/schema/devices';
import { disks } from '@/db/schema/catalog';
import { signUpFresh, runTag } from './helpers';
import { decodeLayout, encodeLayout } from '@/lib/display-layout';
import { pairDevice, seedDisk, cleanupSeeded, authHeader, publishTestRelease, cleanupTestReleases, openBoardSettings } from './device-helpers';

// The releases first (firmware_releases is global), then the seeded rows.
test.afterAll(async () => {
  try { await cleanupTestReleases(); } finally { await cleanupSeeded(); }
});

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
  // 'stale' is always offline (same STALE_AFTER_MS threshold as isOnline), so
  // the fact now lives in the badge row's own "last seen" line -- fix round 1
  // dropped the "device last seen ..." phrase from the stale sub-line, since
  // it duplicated exactly this. Target that element directly (important 1)
  // rather than the old toContainText('last seen') on the whole card, which
  // the badge line alone would now satisfy for ANY offline card, not just a
  // diverged/stale one. The heading is what still says 'stale' specifically.
  await expect(page.getByTestId(`device-last-seen-${deviceId}`)).toContainText(/\d+m ago/);
  await expect(card).toContainText('Requested');
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
  // The `name` given to pairDevice() is now kept (plan 2026-10-17 R8), but the
  // device's own id is still the reliable handle here, so the assertions below
  // never depend on the label.
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

// --- the card grid (option A -- "the disk in the middle"; content height since 2026-10-08) --

test('three paired devices stack, each card the full content width, and no card is a fixed square', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId: idA } = await pairDevice(page, request, 'Card A');
  const { deviceId: idB } = await pairDevice(page, request, 'Card B');
  const { deviceId: idC } = await pairDevice(page, request, 'Card C');

  // 1280x720 is above the lg breakpoint; with 2+ boards the list is one column (spec §1, Ruling 1), no aside.
  await page.goto('/devices');
  // boundingBox() does not wait, and the cards stream in behind the loading placeholders (A1): wait for them first.
  for (const id of [idA, idB, idC]) await expect(page.getByTestId(`device-${id}`)).toBeVisible();
  const boxes = await Promise.all([idA, idB, idC].map((id) => page.getByTestId(`device-${id}`).boundingBox()));
  const [a, b, c] = boxes.map((x) => x!).sort((x, y) => x.y - y.y);

  // Stacked: each starts below the previous one's bottom.
  expect(b.y).toBeGreaterThanOrEqual(a.y + a.height - 1);
  expect(c.y).toBeGreaterThanOrEqual(b.y + b.height - 1);
  // Same left edge and the same width (+-2 px), and wide (the page content, not a third of it).
  for (const box of [b, c]) {
    expect(Math.abs(box.x - a.x)).toBeLessThan(2);
    expect(Math.abs(box.width - a.width)).toBeLessThan(2);
  }
  expect(a.width).toBeGreaterThan(700);
  await expect(page.getByTestId('pair-another-card')).toHaveCount(0);
});

test('pair-another: with one board the aside opens the header pairing form, with two the aside is gone', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request, 'Only Board');
  await page.goto('/devices');
  await expect(page.getByTestId(`device-${deviceId}`)).toBeVisible();
  await expect(page.getByTestId('pair-another-card')).toBeVisible();
  await expect(page.getByTestId('pair-name')).toHaveCount(0);

  await page.getByTestId('pair-another').click();
  // The header's own form opens: exactly one on the page, and it has the focus.
  await expect(page.getByTestId('pair-name')).toHaveCount(1);
  await expect(page.getByTestId('pair-name')).toBeFocused();

  await pairDevice(page, request, 'Second Board');
  await page.goto('/devices');
  await expect(page.getByTestId('pair-device')).toBeVisible();
  await expect(page.getByTestId('pair-another-card')).toHaveCount(0);
});

test('firmware-notice: one updatable board gets "Update <name>", which opens the update dialog listing it', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await setDevice(deviceId, { name: 'Bench A500' });
  await publishTestRelease('0.0.0+e2e71');
  await publishTestRelease('0.0.0+e2e72');
  await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: '0.0.0+e2e71', updateProtocol: 1 },
  });

  await page.goto('/devices');
  const notice = page.getByTestId('firmware-notice');
  await expect(notice).toContainText('is available');
  await expect(notice).toContainText('1 of 1 device is behind');
  const action = page.getByTestId('firmware-notice-update');
  await expect(action).toHaveText('Update Bench A500');

  await action.click();
  const dialog = page.getByTestId('update-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Update 1 device');
  await expect(dialog).toContainText('Bench A500');
  await expect(dialog).toContainText('0.0.0+e2e72');
});

test('offline strip: an offline board says so and when it was last seen, an online one has no strip', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId: idOff } = await pairDevice(page, request, 'Strip Off');
  const { deviceId: idOn } = await pairDevice(page, request, 'Strip On');
  await setDevice(idOff, { name: 'Dark Amiga', lastSeenAt: new Date(Date.now() - 5 * 60_000) });
  await setDevice(idOn, { name: 'Lit Amiga', lastSeenAt: new Date() });

  await page.goto('/devices');
  const strip = page.getByTestId(`device-offline-${idOff}`);
  await expect(strip).toBeVisible();
  await expect(strip).toContainText('Dark Amiga is offline');
  await expect(page.getByTestId(`device-last-seen-${idOff}`)).toContainText(/It was last seen \d+m ago\./);
  await expect(strip).toContainText('reach it when it reconnects');
  await expect(page.getByTestId(`device-offline-${idOn}`)).toHaveCount(0);
  await expect(page.getByTestId(`device-last-seen-${idOn}`)).toHaveCount(0);
});

test('offline strip: a board never seen says so without "last seen never"', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  await setDevice(deviceId, { lastSeenAt: null });
  await page.goto('/devices');
  const line = page.getByTestId(`device-last-seen-${deviceId}`);
  await expect(line).toHaveText('It has not been seen yet.');
  await expect(page.getByTestId(`device-offline-${deviceId}`)).not.toContainText('seen never');
});

test('pair-another while a code is live moves focus to that code', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request, 'Only Board');
  await page.goto('/devices');
  await expect(page.getByTestId(`device-${deviceId}`)).toBeVisible();
  await page.getByTestId('pair-device').click();
  await page.getByTestId('pair-submit').click();
  await expect(page.getByTestId('pairing-code')).toBeVisible();
  await page.getByTestId('pair-another').click();
  await expect(page.getByTestId('pairing-code')).toBeFocused();
  await expect(page.getByTestId('pairing-code')).toBeInViewport();
  // The live code stays; no second form opens.
  await expect(page.getByTestId('pair-name')).toHaveCount(0);
});

test('the card facts show Network, Signal, Firmware and Last seen', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  await setDevice(deviceId, { lastSeenAt: new Date(), rssi: -61 });
  await page.goto('/devices');
  await expect(page.getByTestId(`device-signal-${deviceId}`)).toContainText('-61 dBm');
  await expect(page.getByTestId(`device-seen-${deviceId}`)).toHaveText(/^\d+s ago$|^just now$|^\d+m ago$/);
  await expect(page.getByTestId(`device-firmware-${deviceId}`)).not.toContainText('fw ');
  await expect(page.getByTestId(`device-name-${deviceId}`)).toHaveJSProperty('tagName', 'H2');
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
  // standing in for one of them. The last-seen element itself (important 1),
  // not just a toContainText on the whole card -- that would also pass on
  // whatever else happens to say "last seen" somewhere in the card.
  await expect(page.getByTestId(`device-last-seen-${idOnline}`)).toHaveCount(0);
  await expect(page.getByTestId(`device-last-seen-${idOffline}`)).toContainText('last seen');
  await expect(page.getByTestId(`device-last-seen-${idOffline}`)).toContainText(/\d+[a-z] ago/);
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

  // A fourth device, MID-MOUNT: desired and mounted differ (state 'pending'),
  // still holding the PROTECTED disk while a DIFFERENT one is on its way in.
  // The big text above already shows the new (desired) disk's title, so
  // tagging it with the OLD (mounted) disk's write-protect would describe
  // the wrong disk -- fix round 1, minor 3.
  const { deviceId: idPending } = await pairDevice(page, request, 'WP Pending');
  const { gameId: gameP2, diskId: diskP2 } = await seedDisk(orgId, {
    title: `WP-Pending-target-${tag}`, diskNo: 1, sha256: sha(`${tag}-p2`),
  });
  await setDevice(idPending, {
    desiredGameId: gameP2, desiredDiskId: diskP2, desiredSha256: sha(`${tag}-p2`), desiredDiskNo: 1,
    mountedGameId: gameP, mountedDiskId: diskP, mountedSha256: sha(`${tag}-p`), mountedDiskNo: 1,
    lastSeenAt: new Date(),
  });

  await page.goto('/devices');
  await expect(page.getByTestId(`device-protection-${idProtected}`)).toHaveText('Protected');
  await expect(page.getByTestId(`device-protection-${idWritable}`)).toHaveText('Writable');
  await expect(page.getByTestId(`device-protection-${idEmpty}`)).toHaveText('—');
  await expect(page.getByTestId(`device-${idPending}`)).toHaveAttribute('data-state', 'pending');
  await expect(page.getByTestId(`device-protection-${idPending}`)).toHaveText('—');
});

test('a pairing code is shown with a live expiry, and disappears when it expires', async ({ page }) => {
  await page.clock.install();
  await signUpFresh(page);
  await page.goto('/devices');

  const [pairResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/devices/pair') && r.request().method() === 'POST'),
    (async () => { await page.getByTestId('pair-device').click(); await page.getByTestId('pair-submit').click(); })(),
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

test('pairing asks for a name, shows it with the code, and the paired board wears it', async ({ page, request }) => {
  await signUpFresh(page);
  await page.goto('/devices');
  await page.getByTestId('pair-device').click();
  await expect(page.getByTestId('pair-name')).toBeFocused();
  await page.getByTestId('pair-name').fill('A500 in the study');
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/devices/pair') && r.request().method() === 'POST'),
    page.getByTestId('pair-submit').click(),
  ]);
  const { code } = await res.json();
  await expect(page.getByTestId('pairing-for')).toHaveText('for A500 in the study');
  const reg = await request.post('/api/device/register', {
    data: { pairingCode: code, firmwareVersion: '1.15.0', macAddress: 'AA:BB:CC:DD:EE:02' },
  });
  const { deviceId } = await reg.json();
  await page.goto('/devices');
  await expect(page.getByTestId(`device-name-${deviceId}`)).toHaveText('A500 in the study');
  await getDb().delete(devices).where(eq(devices.id, deviceId));
});

test('Cancel closes the pairing form without minting a code', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/devices');
  await page.getByTestId('pair-device').click();
  await page.getByTestId('pair-cancel').click();
  await expect(page.getByTestId('pair-name')).toHaveCount(0);
  await expect(page.getByTestId('pair-device')).toBeVisible();
});

// --- the drive-bezel card (design A2) ---------------------------------------

test('the bezel display names the mounted disk, and the drive box names it too, always visible', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId: idConverged } = await pairDevice(page, request, 'Bezel Converged');
  const { deviceId: idPending } = await pairDevice(page, request, 'Bezel Pending');
  const tag = runTag();
  const { gameId: gameA, diskId: diskA } = await seedDisk(orgId, { title: `BezelA-${tag}`, diskNo: 1, sha256: sha(`${tag}-a`) });
  const { gameId: gameB, diskId: diskB } = await seedDisk(orgId, { title: `BezelB-${tag}`, diskNo: 1, sha256: sha(`${tag}-b`) });

  await setDevice(idConverged, {
    desiredGameId: gameA, desiredDiskId: diskA, desiredSha256: sha(`${tag}-a`), desiredDiskNo: 1,
    mountedGameId: gameA, mountedDiskId: diskA, mountedSha256: sha(`${tag}-a`), mountedDiskNo: 1,
    lastSeenAt: new Date(),
  });
  // Asked for B while still holding A: the board's screen still shows A.
  await setDevice(idPending, {
    desiredGameId: gameB, desiredDiskId: diskB, desiredSha256: sha(`${tag}-b`), desiredDiskNo: 1,
    mountedGameId: gameA, mountedDiskId: diskA, mountedSha256: sha(`${tag}-a`), mountedDiskNo: 1,
    lastSeenAt: new Date(),
  });

  await page.goto('/devices');
  // What the glass shows, in words: a one-disk title gets the disk's label
  // alone, cut at the firmware's DC_LABEL_MAX (24) as mount.ts sends it.
  const shown = `BezelA-${tag} — ${`BezelA-${tag} (Disk 1)`.slice(0, 24)}`;
  await expect(page.getByTestId(`device-oled-${idConverged}`)).toHaveAttribute('data-oled', shown);
  const box = page.getByTestId(`device-disk-${idConverged}`);
  await expect(box).toBeVisible();
  await expect(box).toContainText('In the drive');
  await expect(box).toContainText(`BezelA-${tag}`);

  await expect(page.getByTestId(`device-oled-${idPending}`)).toHaveAttribute('data-oled', shown);
  const words = page.getByTestId(`device-disk-${idPending}`);
  await expect(words).toBeVisible();
  await expect(words).toContainText('Mounting…');
  await expect(words).toContainText(`BezelB-${tag}`);
});

test('the protection switch flips the disk, the disk title links to its title, and an empty drive offers the library', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId: idDisk } = await pairDevice(page, request, 'Switch Disk');
  const { deviceId: idEmpty } = await pairDevice(page, request, 'Switch Empty');
  const tag = runTag();
  const { gameId, diskId } = await seedDisk(orgId, { title: `Switch-${tag}`, diskNo: 1, sha256: sha(`${tag}-s`), writeProtected: false });
  await setDevice(idDisk, {
    desiredGameId: gameId, desiredDiskId: diskId, desiredSha256: sha(`${tag}-s`), desiredDiskNo: 1,
    mountedGameId: gameId, mountedDiskId: diskId, mountedSha256: sha(`${tag}-s`), mountedDiskNo: 1,
    lastSeenAt: new Date(),
  });
  await setDevice(idEmpty, { lastSeenAt: new Date() });

  await page.goto('/devices');
  const sw = page.getByTestId(`device-protection-${idDisk}`);
  await expect(sw).toHaveText('Writable');
  await expect(sw).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId(`device-disk-title-${idDisk}`)).toHaveAttribute('href', `/games/${gameId}`);

  await sw.click();
  await expect(sw).toHaveText('Protected');
  await expect(sw).toHaveAttribute('aria-pressed', 'true');
  const [row] = await getDb().select({ wp: disks.writeProtected }).from(disks).where(eq(disks.id, diskId));
  expect(row.wp).toBe(true);

  const empty = page.getByTestId(`device-protection-${idEmpty}`);
  await expect(empty).toHaveText('—');
  await expect(empty).toBeDisabled();
  await expect(page.getByTestId(`device-open-library-${idEmpty}`)).toHaveAttribute('href', '/library');
  await expect(page.getByTestId(`device-disk-title-${idEmpty}`)).toHaveCount(0);
});

test('pressing the bezel display opens the display drawer', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  await page.goto('/devices');

  await expect(page.getByTestId(`display-drawer-${deviceId}`)).toHaveCount(0);
  await page.getByTestId(`device-oled-${deviceId}`).click();
  await expect(page.getByTestId(`display-drawer-${deviceId}`)).toBeVisible();
  await expect(page.getByTestId(`display-toggle-${deviceId}`)).toHaveText('Change display');
});

// Pillock, 2026-10-19: the bezel drew the board's screen upside down at
// Rotation 180. It is drawn upright, as the editor's preview is -- the same
// pixels as the same layout unturned.
test('the bezel draws a turned layout upright', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  const upright = new Uint8Array(await readFile('wifi-floppy/firmware/test/fixtures/layouts/default32.bin'));
  const turned = encodeLayout({ ...decodeLayout(upright), rotation: 180 });
  const glass = async () => {
    await page.goto('/devices');
    const c = page.getByTestId(`device-oled-${deviceId}`).locator('canvas');
    await expect.poll(() => c.evaluate((el: HTMLCanvasElement) =>
      el.getContext('2d')!.getImageData(0, 0, el.width, el.height).data.some((v, i) => i % 4 === 0 && v > 0))).toBe(true);
    return c.evaluate((el: HTMLCanvasElement) => el.toDataURL());
  };
  await setDevice(deviceId, { displayPanel: '128x32', displayLayout: Buffer.from(upright) });
  const want = await glass();
  await setDevice(deviceId, { displayPanel: '128x32', displayLayout: Buffer.from(turned) });
  expect(await glass()).toBe(want);
});

// Pillock, 2026-10-19: on a phone the Devices page used half the width.
test('on a phone a device card uses the whole width', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/devices');
  await expect(page.locator(`#device-${deviceId}`)).toBeVisible();   // boundingBox() does not wait (A1 streaming)
  const box = await page.locator(`#device-${deviceId}`).boundingBox();
  expect(box!.width).toBeGreaterThan(330);   // 390 less the 16 px gutters, not half of it
});

/** LiveRefresh polls every 3 s while the tab is in use; allow a few ticks plus the RSC refresh. */
const LIVE = 15_000;

test('a board on a custom server shows no server line on its card (the About page says how this server is hosted)', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const res = await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: '1.13.0+gabc1234', server: { custom: true, tls: 'noverify' } },
  });
  expect(res.status()).toBe(204);
  await page.goto('/devices');
  await expect(page.getByTestId(`device-firmware-${deviceId}`)).toContainText('1.13.0', { timeout: LIVE });
  await expect(page.getByTestId(`device-server-${deviceId}`)).toHaveCount(0);
  await expect(page.getByText(/Custom server|certificate not checked/)).toHaveCount(0);
});

// The boot I2C scan (fw 1.17.0) on the card: the reader line in plain words, and nothing new for older firmware.
test('the card says what the board found on its I2C bus', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId: noReader, token: t1 } = await pairDevice(page, request, 'No Reader');
  const { deviceId: withReader, token: t2 } = await pairDevice(page, request, 'With Reader');
  const { deviceId: older, token: t3 } = await pairDevice(page, request, 'Older Board');
  const report = (token: string, data: object) =>
    request.post('/api/device/status', { headers: authHeader(token), data: { mountedSha256: null, ...data } });
  expect((await report(t1, { firmwareVersion: '1.17.0+ge2e', nfcReader: 'absent', i2c: [0x3c] })).status()).toBe(204);
  expect((await report(t2, { firmwareVersion: '1.17.0+ge2e', nfcReader: 'present', i2c: [0x28, 0x3c] })).status()).toBe(204);
  expect((await report(t3, { firmwareVersion: '1.16.0+ge2e', nfcReader: 'absent' })).status()).toBe(204);

  await page.goto('/devices');
  // The reader line lives in Board settings; a board with no reader carries an attention dot on its button.
  await expect(page.getByTestId(`device-${older}`)).toBeVisible();
  await expect(page.getByTestId(`board-settings-attention-${noReader}`)).toBeVisible();
  await expect(page.getByTestId(`board-settings-attention-${withReader}`)).toHaveCount(0);
  await expect(page.getByTestId(`board-settings-attention-${older}`)).toHaveCount(0);
  await openBoardSettings(page, noReader);
  const absent = page.getByTestId(`device-nfc-${noReader}`);
  await expect(absent).toContainText('No NFC reader found — nothing at 0x28');
  await expect(page.getByTestId(`device-i2c-${noReader}`)).toHaveText('I2C devices seen: 0x3c (display)');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('board-settings-dialog')).toHaveCount(0);
  await openBoardSettings(page, withReader);
  await expect(page.getByTestId(`device-nfc-${withReader}`)).toContainText('NFC reader at 0x28');
  await expect(page.getByTestId(`device-i2c-${withReader}`)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('board-settings-dialog')).toHaveCount(0);
  // Firmware that sends no scan: a sentence saying so (Ruling 22), not an empty section.
  await openBoardSettings(page, older);
  await expect(page.getByTestId(`device-nfc-${older}`)).toHaveCount(0);
  await expect(page.getByTestId(`device-nfc-unknown-${older}`))
    .toHaveText('This firmware does not report its reader (needs 1.17.0 or newer).');
});

// fw 1.18.0 drives a PN532 at 0x24 too (nfc_reader.h): a working one is a reader, and on older firmware the card
// says it needs the update instead of "nothing at 0x28".
test('the card names a PN532 reader at 0x24, and the firmware it needs', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId: pn, token: t1 } = await pairDevice(page, request, 'PN532 Board');
  const { deviceId: oldPn, token: t2 } = await pairDevice(page, request, 'Old PN532 Board');
  const report = (token: string, data: object) =>
    request.post('/api/device/status', { headers: authHeader(token), data: { mountedSha256: null, ...data } });
  expect((await report(t1, { firmwareVersion: '1.18.0+ge2e', nfcReader: 'present', i2c: [0x24, 0x3c] })).status()).toBe(204);
  expect((await report(t2, { firmwareVersion: '1.17.0+ge2e', nfcReader: 'absent', i2c: [0x24, 0x3c] })).status()).toBe(204);

  await page.goto('/devices');
  await openBoardSettings(page, pn);
  await expect(page.getByTestId(`device-nfc-${pn}`)).toContainText('NFC reader at 0x24');
  await expect(page.getByTestId(`device-nfc-${pn}`)).toHaveAttribute('data-ok', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('board-settings-dialog')).toHaveCount(0);
  await openBoardSettings(page, oldPn);
  await expect(page.getByTestId(`device-nfc-${oldPn}`)).toContainText('the PN532 at 0x24 needs firmware 1.18.0 or newer');
  await expect(page.getByTestId(`device-i2c-${oldPn}`)).toHaveText('I2C devices seen: 0x24 (NFC reader, PN532), 0x3c (display)');
});

// Disk at startup (2026-10-19, src/lib/boot-disk.ts): on No disk, the board's first request of a new boot empties
// DF0 -- its poll carries no disk and the card truthfully says No disk -- while a reconnect (the same boot) keeps a
// disk mounted after it.
test('Disk at startup: No disk empties DF0 at the board\'s boot, and a reconnect keeps a disk mounted after it', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'Boot Empty');
  const tag = runTag();
  const { gameId, diskId } = await seedDisk(orgId, { title: `BootEmpty-${tag}`, diskNo: 1, sha256: sha(tag) });
  const report = (data: object) =>
    request.post('/api/device/status', { headers: authHeader(token), data: { firmwareVersion: '1.18.1+ge2e', ...data } });
  expect((await report({ mountedSha256: sha(tag), mountedDiskId: diskId, version: 1 })).status()).toBe(204);
  await setDevice(deviceId, {
    desiredGameId: gameId, desiredDiskId: diskId, desiredSha256: sha(tag), desiredDiskNo: 1, desiredVersion: 1,
  });

  // The board's earlier boot, as the server first heard it: a baseline (the first id ever heard never clears).
  expect((await request.get('/api/device/poll?since=0&nfcAck=0&displayAck=0&boot=0000000a',
    { headers: authHeader(token) })).status()).toBe(200);

  await page.goto('/devices');
  await openBoardSettings(page, deviceId);
  const group = page.getByTestId(`boot-disk-${deviceId}`);
  await expect(group).toHaveAttribute('data-value', 'last');
  await expect(page.getByTestId(`boot-disk-note-${deviceId}`)).toHaveCount(0);
  await page.getByTestId(`boot-disk-${deviceId}-empty`).click();
  await expect(group).toHaveAttribute('data-value', 'empty');
  await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/devices/${deviceId}/boot-disk`) && r.status() === 200),
    page.getByTestId('board-settings-save').click(),
  ]);
  expect((await getDb().select().from(devices).where(eq(devices.id, deviceId)))[0].bootDisk).toBe('empty');

  // The board powers up: nothing in its drive, since=0, and a new boot id.
  const poll = await request.get('/api/device/poll?since=0&nfcAck=0&displayAck=0&boot=1a2b3c4d', { headers: authHeader(token) });
  expect(poll.status()).toBe(200);
  const body = await poll.json();
  expect(body.desired).toBeNull();
  expect(body.version).toBe(2);
  expect((await report({ mountedSha256: null, mountedDiskId: null, version: 2 })).status()).toBe(204);
  await page.reload();
  const card = page.getByTestId(`device-${deviceId}`);
  await expect(card).toHaveAttribute('data-state', 'empty');
  await expect(card).toContainText('No disk');
  await openBoardSettings(page, deviceId);
  await expect(page.getByTestId(`boot-disk-${deviceId}`)).toHaveAttribute('data-value', 'empty');

  // A tag is tapped (the disk is desired again), then Wi-Fi drops and the board polls again in the SAME boot.
  await setDevice(deviceId, {
    desiredGameId: gameId, desiredDiskId: diskId, desiredSha256: sha(tag), desiredDiskNo: 1, desiredVersion: 3,
  });
  const again = await request.get('/api/device/poll?since=2&nfcAck=0&displayAck=0&boot=1a2b3c4d', { headers: authHeader(token) });
  expect(again.status()).toBe(200);
  expect((await again.json()).desired?.sha256).toBe(sha(tag));
});

test('Disk at startup: a board before 1.18.1 is told which firmware it needs, and No disk is refused', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'Old Boot');
  expect((await request.post('/api/device/status', { headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: '1.18.0+ge2e' } })).status()).toBe(204);
  await page.goto('/devices');
  await openBoardSettings(page, deviceId);
  await expect(page.getByTestId(`boot-disk-fixed-${deviceId}`)).toHaveText('Disk at startup: Last disk');
  await expect(page.getByTestId(`boot-disk-note-${deviceId}`)).toHaveText('— needs firmware 1.18.1 or newer');
  await expect(page.getByTestId(`boot-disk-${deviceId}`)).toHaveCount(0);   // nothing to choose on this firmware
  const res = await page.request.patch(`/api/devices/${deviceId}/boot-disk`, { data: { mode: 'empty' } });
  expect(res.status()).toBe(409);
  expect((await res.json()).reason).toBe('Needs firmware 1.18.1 or newer');
});

// Board settings (spec §8.3, Ruling 20): Disk at startup is a draft that Save sends; Cancel, the X and Escape send nothing.
test('Board settings: Save is disabled until a choice changes; Cancel and Escape send nothing and return focus', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'Settings Draft');
  expect((await request.post('/api/device/status', { headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: '1.21.1+ge2e' } })).status()).toBe(204);
  const bootDiskRequests: string[] = [];
  await page.route(`**/api/devices/${deviceId}/boot-disk`, (route) => {
    bootDiskRequests.push(route.request().method());
    return route.continue();
  });
  await page.goto('/devices');
  const opener = page.getByTestId(`board-settings-${deviceId}`);
  const dialog = page.getByTestId('board-settings-dialog');

  await openBoardSettings(page, deviceId);
  await expect(dialog).toHaveAttribute('data-device-id', deviceId);
  await expect(dialog).toContainText(`Settings Draft · nothing changes until you save.`);
  const save = page.getByTestId('board-settings-save');
  const group = page.getByTestId(`boot-disk-${deviceId}`);
  await expect(save).toBeDisabled();
  await expect(page.getByTestId(`boot-disk-hint-${deviceId}`)).toHaveText('The board puts the last disk back in DF0 when it starts.');

  // A change enables Save; changing it back disables it again.
  await page.getByTestId(`boot-disk-${deviceId}-empty`).click();
  await expect(group).toHaveAttribute('data-value', 'empty');
  await expect(page.getByTestId(`boot-disk-hint-${deviceId}`)).toHaveText('The board starts with DF0 empty.');
  await expect(save).toBeEnabled();
  await page.getByTestId(`boot-disk-${deviceId}-last`).click();
  await expect(save).toBeDisabled();

  // Keyboard: an arrow moves focus and the draft, as in a WAI-ARIA radiogroup.
  await page.getByTestId(`boot-disk-${deviceId}-last`).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId(`boot-disk-${deviceId}-empty`)).toBeFocused();
  await expect(group).toHaveAttribute('data-value', 'empty');

  // Cancel discards the draft and sends nothing; focus returns to the opener.
  await page.getByTestId('board-settings-cancel').click();
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();

  // Reopened, the draft starts from the board's value again. Escape closes without a request too.
  await openBoardSettings(page, deviceId);
  await expect(group).toHaveAttribute('data-value', 'last');
  await page.getByTestId(`boot-disk-${deviceId}-empty`).click();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await openBoardSettings(page, deviceId);
  await expect(group).toHaveAttribute('data-value', 'last');
  await page.getByTestId('board-settings-close').click();
  await expect(dialog).toHaveCount(0);
  expect(bootDiskRequests).toEqual([]);
  expect((await getDb().select().from(devices).where(eq(devices.id, deviceId)))[0].bootDisk).toBe('last');
});

test('Board settings: Save closes, toasts, and the row\'s bootDisk is empty', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'Settings Save');
  expect((await request.post('/api/device/status', { headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: '1.21.1+ge2e' } })).status()).toBe(204);
  await page.goto('/devices');
  await openBoardSettings(page, deviceId);
  await page.getByTestId(`boot-disk-${deviceId}-empty`).click();
  await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/devices/${deviceId}/boot-disk`)
      && r.request().method() === 'PATCH' && r.status() === 200),
    page.getByTestId('board-settings-save').click(),
  ]);
  await expect(page.getByTestId('board-settings-dialog')).toHaveCount(0);
  await expect(page.getByText('Disk at startup saved. The board uses it at its next start.')).toBeVisible();
  expect((await getDb().select().from(devices).where(eq(devices.id, deviceId)))[0].bootDisk).toBe('empty');
  await page.reload();   // the draft starts from what the page holds when the modal opens
  await openBoardSettings(page, deviceId);
  await expect(page.getByTestId(`boot-disk-${deviceId}`)).toHaveAttribute('data-value', 'empty');
});

// Fix round 1: the draft is taken from the server value when the modal opens, never while it is open.
test('Board settings: a server change while the modal is open does not overwrite the draft', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'Settings Keep');
  expect((await request.post('/api/device/status', { headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: '1.21.1+ge2e' } })).status()).toBe(204);
  await page.goto('/devices');
  await openBoardSettings(page, deviceId);
  const group = page.getByTestId(`boot-disk-${deviceId}`);
  const save = page.getByTestId('board-settings-save');
  // The user's choice: Last disk, while the server says Last disk.
  await page.getByTestId(`boot-disk-${deviceId}-empty`).click();
  await page.getByTestId(`boot-disk-${deviceId}-last`).click();
  await expect(group).toHaveAttribute('data-value', 'last');
  await expect(save).toBeDisabled();
  // Another tab saves No disk; the page's live refresh brings it in. The draft keeps the user's choice, so Save turns on.
  // (bootDisk is not in the live fingerprint, so the rename is what makes the page refresh.)
  await setDevice(deviceId, { bootDisk: 'empty', name: 'Settings Kept' });
  await expect(page.getByTestId(`device-name-${deviceId}`)).toHaveText('Settings Kept', { timeout: 20_000 });
  await expect(save).toBeEnabled();
  await expect(group).toHaveAttribute('data-value', 'last');
});

// The boot trail (fw 1.18.2): the card names where the previous start stopped -- and says nothing after a clean one.
test('the card says where the previous start stopped, and nothing after a clean one', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId: stuck, token: t1 } = await pairDevice(page, request, 'Stuck Board');
  const { deviceId: upd, token: t2 } = await pairDevice(page, request, 'Update Board');
  const { deviceId: clean, token: t3 } = await pairDevice(page, request, 'Clean Board');
  const { deviceId: held, token: t4 } = await pairDevice(page, request, 'Held Bus Board');
  const report = (token: string, data: object) =>
    request.post('/api/device/status', { headers: authHeader(token), data: { mountedSha256: null, ...data } });
  expect((await report(t1, { firmwareVersion: '1.18.2+ge2e', lastBoot: { reset: 'watchdog', c0: 'i2c', up0: 0 } }))
    .status()).toBe(204);
  expect((await report(t2, { firmwareVersion: '1.18.2+ge2e', lastBoot: { reset: 'power-on', upd: 'i2c' } }))
    .status()).toBe(204);
  expect((await report(t3, { firmwareVersion: '1.18.2+ge2e',
    lastBoot: { reset: 'software', c0: 'reboot', up0: 30, c1: 'contact', up1: 29 } })).status()).toBe(204);
  expect((await report(t4, { firmwareVersion: '1.18.2+ge2e',
    lastBoot: { reset: 'watchdog', c0: 'loop', up0: 90, i2cHeld: true, c1: 'contact', up1: 89 } })).status()).toBe(204);

  await page.goto('/devices');
  await expect(page.getByTestId(`device-last-boot-${stuck}`))
    .toHaveText('Previous start stopped at: I2C scan (reset: watchdog)');
  await expect(page.getByTestId(`device-last-boot-${upd}`))
    .toHaveText("Last update's restart got as far as: the I2C scan (reset: power-on)");
  await expect(page.getByTestId(`device-${clean}`)).toBeVisible();
  await expect(page.getByTestId(`device-last-boot-${clean}`)).toHaveCount(0);
  await expect(page.getByTestId(`device-last-boot-${held}`))
    .toHaveText('Previous start found the I2C bus held low: display and NFC were off (reset: watchdog)');
});
