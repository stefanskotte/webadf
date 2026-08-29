import { test, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { signUpFresh, runTag } from './helpers';
import { pairDevice, seedDisk, authHeader, cleanupSeeded } from './device-helpers';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

test.afterAll(cleanupSeeded);

test('a device polling from version 0 is told what to mount', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const digest = sha(runTag());
  const { diskId } = await seedDisk(orgId, { title: `Px ${runTag()}`, diskNo: 1, sha256: digest });
  await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } });

  const res = await request.get('/api/device/poll?since=0', { headers: authHeader(token) });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.desired).toMatchObject({ sha256: digest, diskNo: 1, writeProtected: true });
  expect(body.version).toBeGreaterThan(0);
});

test('polling at the current version holds and then returns 204, so a device is never told the same thing twice', async ({ page, request }) => {
  test.setTimeout(60_000);
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const { diskId } = await seedDisk(orgId, { title: `Px ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });
  await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } });

  const first = await (await request.get('/api/device/poll?since=0', { headers: authHeader(token) })).json();
  const res = await request.get(`/api/device/poll?since=${first.version}`, {
    headers: authHeader(token), timeout: 45_000,
  });
  expect(res.status()).toBe(204);
});

test('an eject is delivered as an explicit null desired', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const { diskId } = await seedDisk(orgId, { title: `Px ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });
  await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } });
  const mounted = await (await request.get('/api/device/poll?since=0', { headers: authHeader(token) })).json();

  await page.request.post(`/api/devices/${deviceId}/eject`);
  const res = await request.get(`/api/device/poll?since=${mounted.version}`, { headers: authHeader(token) });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.desired).toBeNull();
  expect(body.version).toBeGreaterThan(mounted.version);
});

test('a garbled since is treated as never having polled, not as up to date', async ({ page, request }) => {
  // Reading a bad `since` as "current" would strand the device on stale state
  // forever, which is the same class of bug as an accidental eject.
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const { diskId } = await seedDisk(orgId, { title: `Px ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });
  await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } });

  for (const bad of ['abc', '-5', '']) {
    const res = await request.get(`/api/device/poll?since=${bad}`, { headers: authHeader(token) });
    expect(res.status(), `since=${JSON.stringify(bad)}`).toBe(200);
    expect((await res.json()).desired).not.toBeNull();
  }
});

test('a poll whose device has vanished is a 404, never a 200 that reads as an eject', async ({ page, request }) => {
  // THE property of spec §1 rule 1. A device told {"desired": null} ejects a
  // disk nobody asked it to eject.
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const { diskId } = await seedDisk(orgId, { title: `Px ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });
  await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } });
  const state = await (await request.get('/api/device/poll?since=0', { headers: authHeader(token) })).json();

  // Hold a poll, then delete the row underneath it.
  const pending = request.get(`/api/device/poll?since=${state.version}`, {
    headers: authHeader(token), timeout: 45_000,
  });
  await new Promise((r) => setTimeout(r, 2_000));
  await getDb().delete(devices).where(eq(devices.id, deviceId));

  const res = await pending;
  expect(res.status(), 'a vanished device must 404, never 200').toBe(404);
});

test('the poll rejects every flavour of bad credential with a bare 401', async ({ request }) => {
  const cases: Array<[string, Record<string, string>]> = [
    ['no header', {}],
    ['malformed header', { Authorization: 'Basic abc' }],
    ['unknown token', authHeader(`wadf_${randomUUID()}`)],
  ];
  for (const [label, headers] of cases) {
    const res = await request.get('/api/device/poll?since=0', { headers });
    expect(res.status(), label).toBe(401);
    const body = await res.text();
    expect(body, label).not.toMatch(/token|hash|bearer|device/i);
  }
});
