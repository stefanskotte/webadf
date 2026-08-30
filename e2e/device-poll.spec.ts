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
  const startedAt = Date.now();
  const res = await request.get(`/api/device/poll?since=${first.version}`, {
    headers: authHeader(token), timeout: 45_000,
  });
  const elapsedMs = Date.now() - startedAt;
  expect(res.status()).toBe(204);
  // The 25 s hold is protocol-load-bearing: it is what stops a device that
  // gets a 204 from immediately re-polling in a hot loop. Asserting only the
  // final status would pass even if the hold were gutted to a few ms, so
  // pin the duration too.
  expect(elapsedMs).toBeGreaterThanOrEqual(20_000);
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

  const badValues = [
    'abc', '-5', '',
    // parseInt('1abc', 10) === 1 -- a numeric prefix must not sail through as
    // a real version. This is the case the earlier version of the guard
    // missed: with the real version at 1, `since=1abc` used to return 204,
    // telling the device it was up to date when it had never received
    // version 1 at all.
    '1abc',
    '0x10',
    '1e9',
    ' 1',
    '99999999999999999999', // beyond Number.MAX_SAFE_INTEGER
  ];
  for (const bad of badValues) {
    const res = await request.get(`/api/device/poll?since=${encodeURIComponent(bad)}`, {
      headers: authHeader(token),
    });
    expect(res.status(), `since=${JSON.stringify(bad)}`).toBe(200);
    expect((await res.json()).desired, `since=${JSON.stringify(bad)}`).not.toBeNull();
  }
});

test('a poll updates last_seen_at without any status POST (F-4)', async ({ page, request }) => {
  // The poll is the only contact a device is guaranteed to make every ~25 s.
  // If only the status POST wrote last_seen_at, a device polling happily
  // whose status path is broken would read as "never seen," pointing the
  // operator at the hardware instead of the network.
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const { diskId } = await seedDisk(orgId, { title: `Px ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });
  // Mount so the poll returns immediately (200) instead of holding the full
  // 25 s for an unrelated 204 -- this test is about last_seen_at, not the hold.
  await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } });

  const before = await getDb().select().from(devices).where(eq(devices.id, deviceId));
  expect(before[0].lastSeenAt).toBeNull();

  const beforeCall = Date.now();
  const res = await request.get('/api/device/poll?since=0', { headers: authHeader(token) });
  expect(res.status()).toBe(200);

  const after = await getDb().select().from(devices).where(eq(devices.id, deviceId));
  expect(after[0].lastSeenAt).not.toBeNull();
  expect(after[0].lastSeenAt!.getTime()).toBeGreaterThanOrEqual(beforeCall - 1000);
});

test('a since far above the real version is a 200 with current desired, not a 204 forever (F-5)', async ({ page, request }) => {
  // Reachable after a database restore rolls desired_version backward: the
  // device's remembered `since` is now higher than anything the server has
  // ever produced, and `version > from` would be false forever without a
  // clamp -- 204 on every poll, no signal, indistinguishable from silence.
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const digest = sha(runTag());
  const { diskId } = await seedDisk(orgId, { title: `Px ${runTag()}`, diskNo: 1, sha256: digest });
  const mount = await (await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } })).json();

  const res = await request.get(`/api/device/poll?since=${mount.version + 999_999}`, {
    headers: authHeader(token),
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.desired?.sha256).toBe(digest);
  expect(body.version).toBe(mount.version);
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
