import { test, expect, type APIRequestContext } from '@playwright/test';
import { signUpFresh } from './helpers';
import {
  pairDevice, authHeader, publishTestRelease, cleanupSeeded, cleanupTestReleases,
} from './device-helpers';

// Both, and the releases FIRST. cleanupSeeded does not touch
// firmware_releases, which is global: while a seeded release exists it is the
// newest one production compares every real board against, so the window has
// to close when this file finishes rather than when the whole suite does.
test.afterAll(async () => {
  await cleanupTestReleases();
  await cleanupSeeded();
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
  await publishTestRelease('0.0.0-e2e.1+ga111111');
  await publishTestRelease('0.0.0-e2e.2+gb222222');
  await report(request, token, '0.0.0-e2e.1+ga111111');

  await page.goto('/devices');
  await expect(page.getByTestId('firmware-notice')).toContainText('1 of 1');
  await expect(page.getByTestId(`device-firmware-${deviceId}`)).toContainText('1 release behind');
});

test('a device on the newest release shows no callout', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await publishTestRelease('0.0.0-e2e.3+gc333333');
  await report(request, token, '0.0.0-e2e.3+gc333333');

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
  await publishTestRelease('0.0.0-e2e.4+gd444444');
  await report(request, token, '0.0.0-e2e.4+gdeadbee-dirty');

  await page.goto('/devices');
  await expect(page.getByTestId(`device-firmware-${deviceId}`)).toContainText('unrecognised build');
  await expect(page.getByTestId('firmware-notice')).toHaveCount(0);
});

test('a device that has never reported a version says so', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  await publishTestRelease('0.0.0-e2e.5+ge555555');

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
  await publishTestRelease('0.0.0-e2e.6+gf666666');
  await publishTestRelease('0.0.0-e2e.7+gg777777', { security: true, notes: 'Closes the TLS resume hang' });
  await report(request, token, '0.0.0-e2e.6+gf666666');

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
  await publishTestRelease('0.0.0-e2e.8+gh888888');
  await publishTestRelease('0.0.0-e2e.9+gi999999', { security: true });
  await publishTestRelease('0.0.0-e2e.10+gj101010');   // ordinary, and newest
  await report(request, token, '0.0.0-e2e.8+gh888888');

  await page.goto('/devices');
  await expect(page.getByTestId('firmware-notice')).toContainText(/security/i);
});

/**
 * Before any release is published -- which is the state this ships in, since
 * the first one needs the operator at the Mac with the signing key -- a board
 * must not be accused of running an unrecognised build.
 */
test('with nothing published, a device is not called unrecognised', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await report(request, token, '1.0.0+gabcdef0');

  await page.goto('/devices');
  const line = page.getByTestId(`device-firmware-${deviceId}`);
  await expect(line).toContainText('no releases published');
  await expect(line).not.toContainText('unrecognised');
  await expect(page.getByTestId('firmware-notice')).toHaveCount(0);
});
