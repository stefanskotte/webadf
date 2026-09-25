import { test, expect, type APIRequestContext } from '@playwright/test';
import { signUpFresh } from './helpers';
import {
  pairDevice, authHeader, publishTestRelease, cleanupSeeded, cleanupTestReleases,
  desiredFirmwareOf, seedDevices,
} from './device-helpers';

// Both, and the releases FIRST. cleanupSeeded does not touch
// firmware_releases, which is global: while a seeded release exists it is the
// newest one production compares every real board against, so the window has
// to close when this file finishes rather than when the whole suite does.
test.afterAll(async () => {
  try {
    await cleanupTestReleases();
  } finally {
    await cleanupSeeded();
  }
});

/**
 * The Devices tab's firmware line. Before this increment it read
 * `fw <version>` from a value captured once at pairing, which went stale the
 * first time anyone reflashed and looked authoritative while doing it.
 *
 * Every release here carries the E2E_RELEASE_PREFIX; firmware_releases is
 * global and the global teardown deletes by exactly that prefix.
 */

async function report(request: APIRequestContext, token: string, firmwareVersion: string) {
  const res = await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion },
  });
  expect(res.status()).toBe(204);
}

test('a device behind the newest release is called out', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await publishTestRelease('0.0.0+e2e1');
  await publishTestRelease('0.0.0+e2e2');
  await report(request, token, '0.0.0+e2e1');

  await page.goto('/devices');
  await expect(page.getByTestId('firmware-notice')).toContainText('1 of 1');
  await expect(page.getByTestId(`device-firmware-${deviceId}`)).toContainText('1 release behind');
});

test('a device on the newest release shows no callout', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await publishTestRelease('0.0.0+e2e3');
  await report(request, token, '0.0.0+e2e3');

  await page.goto('/devices');
  await expect(page.getByTestId(`device-firmware-${deviceId}`)).toContainText('up to date');
  await expect(page.getByTestId('firmware-notice')).toHaveCount(0);
});

/**
 * The bench case, and the one a version comparison would get wrong: a dirty
 * local build shares its semver with a release and differs only in the git
 * suffix. Saying "up to date" there is the lie this increment removes.
 */
test('an unregistered build is called unrecognised, not up to date', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await publishTestRelease('0.0.0+e2e4');
  await report(request, token, '0.0.0+e2e4-dirty');

  await page.goto('/devices');
  await expect(page.getByTestId(`device-firmware-${deviceId}`)).toContainText('unrecognised build');
  await expect(page.getByTestId('firmware-notice')).toHaveCount(0);
});

test('a device that has never reported a version says so', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  await publishTestRelease('0.0.0+e2e5');

  // pairDevice registers, which DOES carry a version -- so clear it to model
  // a row from before the heartbeat carried one.
  const { getDb } = await import('@/db');
  const { devices } = await import('@/db/schema/devices');
  const { eq } = await import('drizzle-orm');
  await getDb().update(devices).set({ firmwareVersion: null }).where(eq(devices.id, deviceId));

  await page.goto('/devices');
  await expect(page.getByTestId(`device-firmware-${deviceId}`)).toContainText('unknown');
});

test('a security release says so in the callout', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request);
  await publishTestRelease('0.0.0+e2e6');
  await publishTestRelease('0.0.0+e2e7', { security: true, notes: 'Closes the TLS resume hang' });
  await report(request, token, '0.0.0+e2e6');

  await page.goto('/devices');
  const notice = page.getByTestId('firmware-notice');
  await expect(notice).toContainText(/security/i);
  // The notes reach a non-admin here or they reach nobody: /admin/firmware,
  // the only other place that renders them, redirects every non-admin.
  await expect(notice).toContainText('Closes the TLS resume hang');
});

/**
 * The case reading only the NEWEST release's flag got wrong. A security
 * release followed by an ordinary one still leaves a behind board missing the
 * security fix, and the callout must not go quiet for exactly those boards.
 */
test('a security release skipped over by a later ordinary one still says security', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request);
  await publishTestRelease('0.0.0+e2e8');
  await publishTestRelease('0.0.0+e2e9', { security: true });
  await publishTestRelease('0.0.0+e2e10');   // ordinary, and newest
  await report(request, token, '0.0.0+e2e8');

  await page.goto('/devices');
  await expect(page.getByTestId('firmware-notice')).toContainText(/security/i);
});

/*
 * The empty-registry case -- "no releases published", which is the state this
 * increment ships in -- is covered in src/lib/firmware-state.test.ts and
 * deliberately NOT here. firmware_releases is global and shared with the
 * operator's real data, so a spec cannot create an empty registry: the rows
 * this file seeds are still there when it would run, and once the operator
 * publishes a genuine release the registry is never empty again. A test that
 * can only pass on a database nobody has used yet is worse than no test.
 */

test('a board that cannot update gets no checkbox', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await publishTestRelease('0.0.0+e2e60');
  await report(request, token, '0.0.0+e2e60');   // no updateProtocol

  await page.goto('/devices');
  // Not a disabled control -- nothing at all. Every board in the field today
  // is in this state, and a dead button on all of them would be worse than none.
  await expect(page.getByTestId(`device-select-${deviceId}`)).toHaveCount(0);
});

test('a capable board behind the newest release can be selected and updated', async ({ page, request }) => {
  const { password } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await publishTestRelease('0.0.0+e2e61');
  await publishTestRelease('0.0.0+e2e62');
  await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: '0.0.0+e2e61', updateProtocol: 1 },
  });

  await page.goto('/devices');
  await page.getByTestId(`device-select-${deviceId}`).check();
  await expect(page.getByTestId('update-bar')).toContainText('1 selected');
  await page.getByTestId('update-start').click();
  await expect(page.getByTestId('update-dialog'))
    .toContainText('will wait until it is ejected');
  await page.getByTestId('update-password').fill(password);
  await page.getByTestId('update-confirm').click();

  await expect(page.getByTestId(`device-firmware-${deviceId}`))
    .toContainText('update requested');
});

test('a wrong password in the dialog changes nothing', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await publishTestRelease('0.0.0+e2e63');
  await publishTestRelease('0.0.0+e2e64');
  await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: '0.0.0+e2e63', updateProtocol: 1 },
  });

  await page.goto('/devices');
  await page.getByTestId(`device-select-${deviceId}`).check();
  await page.getByTestId('update-start').click();
  await page.getByTestId('update-password').fill('not-the-password');
  await page.getByTestId('update-confirm').click();

  await expect(page.getByTestId('update-dialog')).toBeVisible();
  expect(await desiredFirmwareOf(deviceId)).toBeNull();
});

/**
 * The confirm dialog is a real modal: announced as one, the caret in the
 * password field, Enter submits, Escape backs out. It used to be a bare div
 * a screen reader walked straight past and no key could dismiss.
 */
test('the update dialog is a keyboard modal: focused password, Enter submits, Escape closes', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await publishTestRelease('0.0.0+e2e65');
  await publishTestRelease('0.0.0+e2e66');
  await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: '0.0.0+e2e65', updateProtocol: 1 },
  });

  await page.goto('/devices');
  await page.getByTestId(`device-select-${deviceId}`).check();
  await page.getByTestId('update-start').click();

  const dialog = page.getByRole('dialog', { name: 'Update 1 device' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(page.getByTestId('update-password')).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('update-dialog')).toHaveCount(0);

  // Reopened, a wrong password submitted with Enter alone reaches the server:
  // the 401 toast is proof the form submitted, and nothing was written.
  await page.getByTestId('update-start').click();
  await page.getByTestId('update-password').fill('not-the-password');
  await page.getByTestId('update-password').press('Enter');
  await expect(page.getByText('That password was not right.')).toBeVisible();
  await expect(page.getByTestId('update-dialog')).toBeVisible();
  expect(await desiredFirmwareOf(deviceId)).toBeNull();
});

/**
 * The route refuses more than MAX_UPDATE_BATCH boards; the bar has to say so
 * before the password rather than after it as a generic failure.
 */
test('more boards than one update may carry disables Update and says how many to untick', async ({ page }) => {
  test.setTimeout(90_000); // 51 checkboxes
  const { orgId } = await signUpFresh(page);
  await publishTestRelease('0.0.0+e2e67');
  await publishTestRelease('0.0.0+e2e68');
  const ids = await seedDevices(orgId, 51, '0.0.0+e2e67');

  await page.goto('/devices');
  for (const id of ids.slice(0, 50)) await page.getByTestId(`device-select-${id}`).check();
  await expect(page.getByTestId('update-bar')).toContainText('50 selected');
  await expect(page.getByTestId('update-cap')).toHaveCount(0);
  await expect(page.getByTestId('update-start')).toBeEnabled();

  await page.getByTestId(`device-select-${ids[50]}`).check();
  await expect(page.getByTestId('update-cap')).toHaveText('At most 50 boards per update — untick 1.');
  await expect(page.getByTestId('update-start')).toBeDisabled();

  await page.getByTestId(`device-select-${ids[0]}`).uncheck();
  await expect(page.getByTestId('update-cap')).toHaveCount(0);
  await expect(page.getByTestId('update-start')).toBeEnabled();
});
