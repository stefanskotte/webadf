import { test, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { signUpFresh, runTag } from './helpers';
import { pairDevice, seedDisk, authHeader, cleanupSeeded } from './device-helpers';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

test.afterAll(cleanupSeeded);

async function deviceRow(deviceId: string) {
  const r = await getDb().select().from(devices).where(eq(devices.id, deviceId));
  return r[0];
}

test('a report is recorded', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const digest = sha(runTag());
  const before = Date.now();

  const res = await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: digest, psramFree: 6127616, rssi: -58 },
  });
  expect(res.status()).toBe(204);

  const row = await deviceRow(deviceId);
  expect(row.mountedSha256).toBe(digest);
  expect(row.psramFree).toBe(6127616);
  expect(row.rssi).toBe(-58);
  expect(row.lastSeenAt).not.toBeNull();
  expect(new Date(row.lastSeenAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
});

test('a report never changes desired state', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const { diskId } = await seedDisk(orgId, { title: `Px ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });

  await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } });
  const beforeReport = await deviceRow(deviceId);

  const differentDigest = sha(`${runTag()}-different`);
  const res = await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: differentDigest },
  });
  expect(res.status()).toBe(204);

  const after = await deviceRow(deviceId);
  expect(after.desiredSha256).toBe(beforeReport.desiredSha256);
  expect(after.desiredVersion).toBe(beforeReport.desiredVersion);
  // The observation itself must still land, or this test would pass for the
  // wrong reason (a route that does nothing at all).
  expect(after.mountedSha256).toBe(differentDigest);
});

test('mountedSha256: null is a valid report meaning "I hold nothing"', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const { diskId } = await seedDisk(orgId, { title: `Px ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });
  await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } });
  const beforeReport = await deviceRow(deviceId);

  const res = await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: null },
  });
  expect(res.status()).toBe(204);

  const after = await deviceRow(deviceId);
  expect(after.mountedSha256).toBeNull();
  expect(after.desiredSha256).toBe(beforeReport.desiredSha256);
  expect(after.desiredVersion).toBe(beforeReport.desiredVersion);
});

test('an error is recorded and then cleared', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);

  const res1 = await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: null, error: 'fetch failed' },
  });
  expect(res1.status()).toBe(204);

  const afterError = await deviceRow(deviceId);
  expect(afterError.lastError).toBe('fetch failed');
  expect(afterError.lastErrorAt).not.toBeNull();

  const res2 = await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: null, error: null },
  });
  expect(res2.status()).toBe(204);

  const afterClear = await deviceRow(deviceId);
  expect(afterClear.lastError).toBeNull();
  expect(afterClear.lastErrorAt).toBeNull();
});

test('a malformed body is a 400', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request);

  const nonHex = await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: 'not-a-valid-sha' },
  });
  expect(nonHex.status()).toBe(400);

  const outOfRangeRssi = await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: null, rssi: 50 },
  });
  expect(outOfRangeRssi.status()).toBe(400);

  const invalidJson = await request.post('/api/device/status', {
    headers: { ...authHeader(token), 'Content-Type': 'application/json' },
    data: '{not json',
  });
  expect(invalidJson.status()).toBe(400);
});

test('bad credentials are a 401 for every flavour', async ({ request }) => {
  const cases: Array<[string, Record<string, string>]> = [
    ['no header', {}],
    ['malformed header', { Authorization: 'Basic abc' }],
    ['unknown token', authHeader(`wadf_${randomUUID()}`)],
  ];
  for (const [label, headers] of cases) {
    const res = await request.post('/api/device/status', {
      headers, data: { mountedSha256: null },
    });
    expect(res.status(), label).toBe(401);
  }
});
