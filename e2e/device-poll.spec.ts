import { test, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { signUpFresh, runTag } from './helpers';
import {
  pairDevice, seedDisk, authHeader, cleanupSeeded, publishTestRelease,
  cleanupTestReleases, setDesiredFirmware, clearDesiredFirmware,
} from './device-helpers';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// Releases first: firmware_releases is global, so the window in which a
// seeded release is the newest one production compares real boards against
// closes with this file rather than with the whole suite.
test.afterAll(async () => { await cleanupTestReleases(); await cleanupSeeded(); });

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

/**
 * The poll long-holds and returns a body only when desiredVersion moves, and a
 * 204 carries no update object -- so an update has to release the hold by
 * itself. It must do that exactly ONCE: releasing while the update merely
 * stays pending would turn the 25 s hold into a busy loop.
 */
test('a pending update releases the hold and rides the poll body', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await publishTestRelease('0.0.0-e2e.20+gaa20000');
  await setDesiredFirmware(deviceId, '0.0.0-e2e.20+gaa20000');

  const res = await request.get('/api/device/poll?since=0', { headers: authHeader(token) });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.update).toMatchObject({
    version: '0.0.0-e2e.20+gaa20000',
    sha256: 'e'.repeat(64),
    keyId: 'e2e',
  });
  expect(typeof body.update.sequence).toBe('number');
});

test('once the device acknowledges, the poll holds normally again', async ({ page, request }) => {
  // The hold is 25 s and the default test timeout is 30 s, which the setup
  // below eats into. Raised so the assertion is about the poll's behaviour
  // rather than about the clock.
  test.setTimeout(60_000);
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await publishTestRelease('0.0.0-e2e.21+gaa21000');
  await setDesiredFirmware(deviceId, '0.0.0-e2e.21+gaa21000');

  // Acknowledge the way a board does: echo back the instruction cursor the
  // poll body carried. Reporting a STATE is telemetry and deliberately does
  // NOT count as acknowledgement -- a board that says "downloading" without
  // echoing the cursor has not told the server which instruction it means.
  const first = await request.get('/api/device/poll?since=0', { headers: authHeader(token) });
  const seen = (await first.json()).update.instructionVersion;
  await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: null, firmwareUpdateState: 'downloading',
            firmwareInstructionAck: seen },
  });

  // since=0 against a device whose desiredVersion is also 0: no disk change to
  // report. `since=1` would NOT work here and the difference matters -- a
  // `since` ahead of the real version trips the existing clamp path, which
  // delivers immediately by design, and the test would pass for the wrong
  // reason whether or not the update rule were correct.
  //
  // Asserted by whether the request has SETTLED after 3 s rather than by
  // measuring how long it took: the question is "did it answer at once",
  // and waiting out the full 25 s hold to find out would make a fast,
  // precise check slow and flaky.
  let settled = false;
  const polling = request.get('/api/device/poll?since=0', { headers: authHeader(token) })
    .then((r) => { settled = true; return r; });
  await new Promise((r) => setTimeout(r, 3000));
  expect(settled, 'an acknowledged update must not keep releasing the hold').toBe(false);

  const res = await polling;
  expect([200, 204]).toContain(res.status());
});

test('a device with no update gets no update field', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request);
  const res = await request.get('/api/device/poll?since=999999', { headers: authHeader(token) });
  if (res.status() === 200) expect((await res.json()).update).toBeUndefined();
});

/**
 * The case the first design could not express at all. A board that has
 * acknowledged and is waiting for an eject must LEARN that the operator stood
 * the update down -- otherwise it flashes a withdrawn release the moment the
 * disk comes out. Cancelling moves the cursor, so the cancellation is itself
 * a wake, and the body that arrives simply has no `update` in it.
 */
test('a cancelled update wakes an already-acknowledged board, with no instruction', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await publishTestRelease('0.0.0-e2e.22+gaa22000');
  await setDesiredFirmware(deviceId, '0.0.0-e2e.22+gaa22000');

  const told = await request.get('/api/device/poll?since=0', { headers: authHeader(token) });
  const seen = (await told.json()).update.instructionVersion;
  await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: null, firmwareUpdateState: 'queued', firmwareInstructionAck: seen },
  });

  await clearDesiredFirmware(deviceId);

  const after = await request.get('/api/device/poll?since=0', { headers: authHeader(token) });
  expect(after.status()).toBe(200);
  expect((await after.json()).update).toBeUndefined();
});
