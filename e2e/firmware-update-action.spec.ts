import { test, expect, type APIRequestContext } from '@playwright/test';
import { signUpFresh } from './helpers';
import {
  pairDevice, authHeader, publishTestRelease, cleanupTestReleases, cleanupSeeded,
  desiredFirmwareOf,
} from './device-helpers';

// try/finally, not two awaits. cleanupSeeded is deliberately self-protecting
// ("a failure here must not fail a passing spec") and resets its tracking
// arrays in its own finally; a throw from the release sweep would skip it
// entirely and strand seeded users, orgs, disks and blobs in the LIVE
// database -- the exact accumulation the global teardown was written after.
test.afterAll(async () => {
  try {
    await cleanupTestReleases();
  } finally {
    await cleanupSeeded();
  }
});

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
  await publishTestRelease('0.0.0+e2e30');
  await publishTestRelease('0.0.0+e2e31');
  await announceCapable(request, token, '0.0.0+e2e30');

  const res = await page.request.post('/api/devices/firmware-update', {
    data: { deviceIds: [deviceId], version: '0.0.0+e2e31', password: 'wrong-password' },
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
  await publishTestRelease('0.0.0+e2e32');
  await publishTestRelease('0.0.0+e2e33');
  await announceCapable(request, a.token, '0.0.0+e2e32');
  // Baker never reports a capability, so it cannot be updated.

  const res = await page.request.post('/api/devices/firmware-update', {
    data: { deviceIds: [a.deviceId, b.deviceId], version: '0.0.0+e2e33', password },
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
  await publishTestRelease('0.0.0+e2e34');
  await publishTestRelease('0.0.0+e2e35');
  await announceCapable(request, token, '0.0.0+e2e35');   // on the NEWER one

  const res = await page.request.post('/api/devices/firmware-update', {
    data: { deviceIds: [deviceId], version: '0.0.0+e2e34', password },
  });
  expect(res.status()).toBe(409);
  expect((await res.json()).refusals[0].reason).toBe('would_roll_back');
  // The half that was missing: a refusal must also WRITE NOTHING.
  expect(await desiredFirmwareOf(deviceId)).toBeNull();
});

/**
 * The step-up is otherwise an unlimited oracle for the operator's real
 * password, aimed at precisely the attacker it exists to stop -- one who
 * already holds the session cookie.
 */
test('repeated wrong passwords lock the door', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await publishTestRelease('0.0.0+e2e43');
  await publishTestRelease('0.0.0+e2e44');
  await announceCapable(request, token, '0.0.0+e2e43');

  const attempt = () => page.request.post('/api/devices/firmware-update', {
    data: { deviceIds: [deviceId], version: '0.0.0+e2e44', password: 'nope' },
  });

  const codes: number[] = [];
  for (let i = 0; i < 6; i++) codes.push((await attempt()).status());

  // The first few are ordinary refusals; the door closes before the sixth.
  expect(codes.slice(0, 4)).toEqual([401, 401, 401, 401]);
  expect(codes[5]).toBe(429);
  expect(await desiredFirmwareOf(deviceId)).toBeNull();
});

test('a correct password after failures still works, and clears the count', async ({ page, request }) => {
  const { password } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await publishTestRelease('0.0.0+e2e45');
  await publishTestRelease('0.0.0+e2e46');
  await announceCapable(request, token, '0.0.0+e2e45');

  for (let i = 0; i < 3; i++) {
    await page.request.post('/api/devices/firmware-update', {
      data: { deviceIds: [deviceId], version: '0.0.0+e2e46', password: 'nope' },
    });
  }
  const ok = await page.request.post('/api/devices/firmware-update', {
    data: { deviceIds: [deviceId], version: '0.0.0+e2e46', password },
  });
  expect(ok.status()).toBe(200);
});

test('a device in another org is a 404', async ({ page, request, browser }) => {
  const { password } = await signUpFresh(page);
  await publishTestRelease('0.0.0+e2e36');

  const other = await browser.newPage();
  await signUpFresh(other);
  const stranger = await pairDevice(other, request, 'Stranger');
  await other.close();

  const res = await page.request.post('/api/devices/firmware-update', {
    data: { deviceIds: [stranger.deviceId], version: '0.0.0+e2e36', password },
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
  await publishTestRelease('0.0.0+e2e39');
  await publishTestRelease('0.0.0+e2e40');
  await announceCapable(request, token, '0.0.0+e2e39');

  await page.request.post('/api/devices/firmware-update', {
    data: { deviceIds: [deviceId], version: '0.0.0+e2e40', password },
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
  await publishTestRelease('0.0.0+e2e37');
  await publishTestRelease('0.0.0+e2e38');
  await announceCapable(request, token, '0.0.0+e2e37');

  const res = await page.request.post('/api/devices/firmware-update', {
    data: { deviceIds: [deviceId], version: '0.0.0+e2e38', password },
  });
  expect(res.status()).toBe(200);
  expect((await res.json()).count).toBe(1);

  const poll = await request.get('/api/device/poll?since=0', { headers: authHeader(token) });
  expect(poll.status()).toBe(200);
  expect((await poll.json()).update.version).toBe('0.0.0+e2e38');
});
