import { test, expect, type APIRequestContext } from '@playwright/test';
import { signUpFresh } from './helpers';
import {
  pairDevice, authHeader, publishTestRelease, cleanupTestReleases, cleanupSeeded,
  desiredFirmwareOf,
} from './device-helpers';

test.afterAll(async () => { await cleanupTestReleases(); await cleanupSeeded(); });

/** Report a capability, so the device is targetable at all. */
async function announceCapable(request: APIRequestContext, token: string, version: string) {
  const res = await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: version, updateProtocol: 1 },
  });
  expect(res.status()).toBe(204);
}

test('a wrong password writes nothing', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await publishTestRelease('0.0.0-e2e.30+gaa30000');
  await publishTestRelease('0.0.0-e2e.31+gaa31000');
  await announceCapable(request, token, '0.0.0-e2e.30+gaa30000');

  const res = await page.request.post('/api/devices/firmware-update', {
    data: { deviceIds: [deviceId], version: '0.0.0-e2e.31+gaa31000', password: 'wrong-password' },
  });
  expect(res.status()).toBe(401);

  expect(await desiredFirmwareOf(deviceId)).toBeNull();
});

/**
 * All-or-nothing. A multi-select that silently updated three of five would be
 * the worst outcome the batch could have, and the operator would have no way
 * to tell which three.
 */
test('one refused device leaves the whole batch unwritten', async ({ page, request }) => {
  const { password } = await signUpFresh(page);
  const a = await pairDevice(page, request, 'Able');
  const b = await pairDevice(page, request, 'Baker');
  await publishTestRelease('0.0.0-e2e.32+gaa32000');
  await publishTestRelease('0.0.0-e2e.33+gaa33000');
  await announceCapable(request, a.token, '0.0.0-e2e.32+gaa32000');
  // Baker never reports a capability, so it cannot be updated.

  const res = await page.request.post('/api/devices/firmware-update', {
    data: { deviceIds: [a.deviceId, b.deviceId], version: '0.0.0-e2e.33+gaa33000', password },
  });
  expect(res.status()).toBe(409);
  expect((await res.json()).refusals)
    .toContainEqual(expect.objectContaining({ reason: 'cannot_update' }));

  // Able must be untouched despite passing its own checks.
  expect(await desiredFirmwareOf(a.deviceId)).toBeNull();
  expect(await desiredFirmwareOf(b.deviceId)).toBeNull();
});

test('a rollback is refused', async ({ page, request }) => {
  const { password } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await publishTestRelease('0.0.0-e2e.34+gaa34000');
  await publishTestRelease('0.0.0-e2e.35+gaa35000');
  await announceCapable(request, token, '0.0.0-e2e.35+gaa35000');   // on the NEWER one

  const res = await page.request.post('/api/devices/firmware-update', {
    data: { deviceIds: [deviceId], version: '0.0.0-e2e.34+gaa34000', password },
  });
  expect(res.status()).toBe(409);
  expect((await res.json()).refusals[0].reason).toBe('would_roll_back');
});

test('a device in another org is a 404', async ({ page, request, browser }) => {
  const { password } = await signUpFresh(page);
  await publishTestRelease('0.0.0-e2e.36+gaa36000');

  const other = await browser.newPage();
  await signUpFresh(other);
  const stranger = await pairDevice(other, request, 'Stranger');
  await other.close();

  const res = await page.request.post('/api/devices/firmware-update', {
    data: { deviceIds: [stranger.deviceId], version: '0.0.0-e2e.36+gaa36000', password },
  });
  expect(res.status()).toBe(404);
});

/**
 * Standing down is not the privileged direction, so it takes no password. It
 * clears INTENT, not flash -- a board that already applied the update keeps it.
 */
test('cancelling clears a pending update, with no password', async ({ page, request }) => {
  const { password } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await publishTestRelease('0.0.0-e2e.39+gaa39000');
  await publishTestRelease('0.0.0-e2e.40+gaa40000');
  await announceCapable(request, token, '0.0.0-e2e.39+gaa39000');

  await page.request.post('/api/devices/firmware-update', {
    data: { deviceIds: [deviceId], version: '0.0.0-e2e.40+gaa40000', password },
  });
  const cancel = await page.request.delete('/api/devices/firmware-update', {
    data: { deviceIds: [deviceId] },
  });
  expect(cancel.status()).toBe(200);
  expect(await desiredFirmwareOf(deviceId)).toBeNull();
});

test('a good batch sets the update and the device sees it', async ({ page, request }) => {
  const { password } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await publishTestRelease('0.0.0-e2e.37+gaa37000');
  await publishTestRelease('0.0.0-e2e.38+gaa38000');
  await announceCapable(request, token, '0.0.0-e2e.37+gaa37000');

  const res = await page.request.post('/api/devices/firmware-update', {
    data: { deviceIds: [deviceId], version: '0.0.0-e2e.38+gaa38000', password },
  });
  expect(res.status()).toBe(200);
  expect((await res.json()).count).toBe(1);

  const poll = await request.get('/api/device/poll?since=0', { headers: authHeader(token) });
  expect(poll.status()).toBe(200);
  expect((await poll.json()).update.version).toBe('0.0.0-e2e.38+gaa38000');
});
