import { test, expect, type APIRequestContext } from '@playwright/test';
import { signUpFresh } from './helpers';
import { pairDevice, authHeader, publishTestRelease, cleanupSeeded } from './device-helpers';

test.afterAll(cleanupSeeded);

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
  await publishTestRelease('0.0.0-e2e.7+gg777777', { security: true });
  await report(request, token, '0.0.0-e2e.6+gf666666');

  await page.goto('/devices');
  await expect(page.getByTestId('firmware-notice')).toContainText(/security/i);
});
