import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';
import { pairDevice, authHeader, cleanupTestReleases, cleanupSeeded } from './device-helpers';

test.afterAll(async () => { await cleanupTestReleases(); await cleanupSeeded(); });

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
