import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';
import {
  pairDevice, authHeader, cleanupTestReleases, cleanupSeeded, publishTestRelease,
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

test('an unpublished version is a 404, not a 403', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request);
  const res = await request.get('/api/device/firmware/9.9.9%2Bgnothere', {
    headers: authHeader(token),
  });
  // 404 so a caller learns nothing about what exists.
  expect(res.status()).toBe(404);
});

test('an anonymous caller cannot download firmware', async ({ request }) => {
  const res = await request.get('/api/device/firmware/1.0.0%2Bga111111');
  expect(res.status()).toBe(401);
});

test('an over-long version is refused before any lookup', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request);
  const res = await request.get(`/api/device/firmware/${'v'.repeat(80)}`, {
    headers: authHeader(token),
  });
  expect(res.status()).toBe(400);
});

/**
 * A published release whose object is missing is 503, not 404 -- so a board
 * retries rather than concluding the version is gone and abandoning an update
 * it was told to take. publishTestRelease records a blobPath with nothing
 * behind it, which is exactly this state.
 */
test('a release whose object is missing is a 503, so the board retries', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request);
  await publishTestRelease('0.0.0+e2e80');

  const res = await request.get(`/api/device/firmware/${encodeURIComponent('0.0.0+e2e80')}`,
                                { headers: authHeader(token) });
  expect(res.status()).toBe(503);
});

test('a version that is not the registry format is refused before any lookup', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request);
  // Under the length bound, so only a FORMAT check catches it.
  const res = await request.get('/api/device/firmware/not-a-version',
                                { headers: authHeader(token) });
  expect(res.status()).toBe(400);
});
