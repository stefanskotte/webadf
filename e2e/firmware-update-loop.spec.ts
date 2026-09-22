import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';
import {
  pairDevice, authHeader, publishTestRelease, publishTestReleaseWithBlob,
  cleanupTestReleases, cleanupSeeded,
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

/**
 * The whole server side, driven by a SIMULATED device.
 *
 * What this proves: the server instructs, serves, tracks and verifies
 * correctly. What it does NOT prove: that a board can flash itself. No
 * firmware implements this protocol yet, and when one does, expect the
 * protocol to move -- write-back's real device protocol ended up differing
 * from its spec text too.
 */
test('the whole loop: request, poll, download, apply, verify', async ({ page, request }) => {
  const { password } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);

  await publishTestRelease('0.0.0+e2e70');                       // the old one
  const version = await publishTestReleaseWithBlob('0.0.0+e2e71'); // the target

  // The board announces what it is running and what it can do.
  await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: '0.0.0+e2e70', updateProtocol: 1 },
  });

  // 1. The operator asks.
  const ask = await page.request.post('/api/devices/firmware-update', {
    data: { deviceIds: [deviceId], version, password },
  });
  expect(ask.status()).toBe(200);

  // 2. The device polls and is told. The hold releases for it without
  //    desiredVersion having moved.
  const poll = await request.get('/api/device/poll?since=0', { headers: authHeader(token) });
  expect(poll.status()).toBe(200);
  const pollBody = await poll.json();
  const instruction = pollBody.update;
  expect(instruction.version).toBe(version);
  expect(instruction.sequence).toBeGreaterThan(0);
  expect(instruction.signature).toBeTruthy();

  // 3. It downloads through the real route, and gets the bytes the
  //    instruction described.
  const dl = await request.get(`/api/device/firmware/${encodeURIComponent(version)}`,
                               { headers: authHeader(token) });
  expect(dl.status()).toBe(200);
  expect((await dl.body()).byteLength).toBe(instruction.sizeBytes);

  // 4. It acknowledges and reports progress. A real board carries its
  //    firmwareVersion on every heartbeat, so the state is sent ALONGSIDE a
  //    version -- which is the shape that used to lose the state to the
  //    completion CASE, leaving progress invisible and letting an operator
  //    re-target a board mid-flash.
  for (const state of ['downloading', 'applying'] as const) {
    const r = await request.post('/api/device/status', {
      headers: authHeader(token),
      data: {
        mountedSha256: null, firmwareUpdateState: state,
        firmwareVersion: '0.0.0+e2e70', updateProtocol: 1,
        firmwareInstructionAck: pollBody.instructionVersion,
      },
    });
    expect(r.status()).toBe(204);
  }
  await page.goto('/devices');
  await expect(page.getByTestId(`device-firmware-${deviceId}`))
    .toContainText('do not power off');

  // 5. It comes back running the new version. NOTHING says "succeeded" --
  //    the version it reports is the whole verification.
  await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: version, updateProtocol: 1 },
  });

  await page.reload();
  await expect(page.getByTestId(`device-firmware-${deviceId}`)).toContainText('up to date');
  await expect(page.getByTestId('firmware-notice')).toHaveCount(0);
});
