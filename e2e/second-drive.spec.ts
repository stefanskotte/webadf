import { test, expect, type APIRequestContext } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { PAULANET_DISK_SHA256 } from '@/lib/paulanet-disk';
import { signUpFresh } from './helpers';
import { pairDevice, authHeader, cleanupSeeded } from './device-helpers';

test.afterAll(cleanupSeeded);

async function report(request: APIRequestContext, token: string, extra: Record<string, unknown>) {
  const res = await request.post('/api/device/status', {
    headers: authHeader(token), data: { mountedSha256: null, firmwareVersion: '1.9.0', ...extra },
  });
  expect(res.status()).toBe(204);
}
/** LiveRefresh polls every 3 s while the tab is in use; allow a few ticks plus the RSC refresh. */
const LIVE = 15_000;
const row = async (id: string) => (await getDb().select().from(devices).where(eq(devices.id, id)))[0];

test('a board without DF1 support is told which firmware it needs', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await report(request, token, { firmwareVersion: '1.7.4' });
  await page.goto('/devices');
  await expect(page.getByTestId(`second-drive-status-${deviceId}`)).toHaveText('Needs firmware 1.9.0 or newer');
  await expect(page.getByTestId(`second-drive-${deviceId}`)).toBeDisabled();
});

test('switching DF1 on reaches the board through the poll and reads applied once acked', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await report(request, token, { secondDrive: 'off', driveVersion: 0, sel1Wired: true, df1Seen: false });
  await page.goto('/devices');
  await expect(page.getByTestId(`device-df1seen-${deviceId}`)).toHaveText('Other DF1 drive: none seen');
  await page.getByTestId(`second-drive-${deviceId}`).selectOption('df1');
  await expect(page.getByTestId(`second-drive-status-${deviceId}`)).toHaveText('Waiting for the board');
  expect((await row(deviceId)).secondDriveVersion).toBe(1);

  const poll = await request.get('/api/device/poll?since=0&driveAck=0', { headers: authHeader(token) });
  expect(poll.status()).toBe(200);
  expect((await poll.json()).secondDrive).toEqual({ seq: 1, mode: 'df1' });

  await report(request, token, { secondDrive: 'df1', driveVersion: 1, sel1Wired: true, df1Seen: false });
  // No reload (HANDOFF backlog "DF1 card status does not update live"): the live-state poll brings it.
  await expect(page.getByTestId(`second-drive-status-${deviceId}`))
    .toHaveText('Set on the board — takes effect when the Amiga restarts', { timeout: LIVE });
  // A SEL1 reading the board changes reaches the open card the same way.
  await report(request, token, { secondDrive: 'df1', driveVersion: 1, sel1Wired: true, df1Seen: true });
  await expect(page.getByTestId(`device-df1seen-${deviceId}`)).toHaveAttribute('data-value', 'true', { timeout: LIVE });
});

test('a seen DF1 refuses the switch; the override needs a second confirmation', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await report(request, token, { secondDrive: 'off', driveVersion: 0, sel1Wired: true, df1Seen: true });
  await page.goto('/devices');
  await page.getByTestId(`second-drive-${deviceId}`).selectOption('df1');
  await expect(page.getByTestId(`second-drive-refused-${deviceId}`)).toContainText('A drive already answers as DF1 on this Amiga');
  expect((await row(deviceId)).secondDriveVersion).toBe(0);           // nothing saved
  await page.getByTestId(`second-drive-override-${deviceId}`).click();
  expect((await row(deviceId)).secondDriveVersion).toBe(0);           // one click is not enough
  await page.getByTestId(`second-drive-override-confirm-${deviceId}`).click();
  await expect.poll(async () => (await row(deviceId)).secondDrive).toBe('df1');
});

test('a failed save shows the error and leaves the select at the stored value', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await report(request, token, { secondDrive: 'off', driveVersion: 0, sel1Wired: true, df1Seen: false });
  await page.goto('/devices');
  await page.route(`**/api/devices/${deviceId}/second-drive`, (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ reason: 'Database unavailable' }) }));
  const select = page.getByTestId(`second-drive-${deviceId}`);
  await select.selectOption('df1');
  await expect(page.getByTestId(`second-drive-error-${deviceId}`)).toHaveText('Database unavailable');
  await expect(select).toHaveValue('off');
  expect((await row(deviceId)).secondDriveVersion).toBe(0);
});

test('the help tip opens and names the caveats', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request);
  await report(request, token, { secondDrive: 'off', driveVersion: 0 });
  await page.goto('/devices');
  await page.getByTestId('help-tip-second-drive').first().click();
  const pop = page.getByTestId('help-pop-second-drive');
  await expect(pop).toBeVisible();
  await expect(pop).toContainText(/next disk of the set/i);
});

test('Network needs 1.11.0: the option says so, and the route refuses', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await report(request, token, { firmwareVersion: '1.10.2+gabc1234', secondDrive: 'off', driveVersion: 0 });
  await page.goto('/devices');
  const opt = page.getByTestId(`second-drive-${deviceId}`).locator('option[value="net"]');
  await expect(opt).toHaveAttribute('disabled', '');   // toBeDisabled() does not read an <option>'s own attribute
  await expect(opt).toHaveText('Network (PaulaNET) — needs firmware 1.11.0');
  const res = await page.request.patch(`/api/devices/${deviceId}/second-drive`, { data: { mode: 'net' } });
  expect(res.status()).toBe(409);
  expect(await res.json()).toEqual({ error: 'firmware_too_old', reason: 'Needs firmware 1.11.0 or newer' });
  expect((await row(deviceId)).secondDriveVersion).toBe(0);
});

test('the firmware guard per version: 1.9.0 and 1.10.2 are refused Network, 1.11.0 is accepted, no version is refused', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const patch = () => page.request.patch(`/api/devices/${deviceId}/second-drive`, { data: { mode: 'net' } });
  for (const v of ['1.9.0+g1', '1.10.2+g1']) {
    await report(request, token, { firmwareVersion: v, secondDrive: 'off', driveVersion: 0 });
    const res = await patch();
    expect(res.status(), v).toBe(409);
    expect((await res.json()).error, v).toBe('firmware_too_old');
    expect((await row(deviceId)).secondDrive, v).toBe('off');
    expect((await row(deviceId)).secondDriveVersion, v).toBe(0);
  }
  // A board that never reported a version: unknown is refused too.
  await getDb().update(devices).set({ firmwareVersion: null }).where(eq(devices.id, deviceId));
  const none = await patch();
  expect(none.status()).toBe(409);
  expect((await none.json()).error).toBe('firmware_too_old');
  expect((await row(deviceId)).secondDriveVersion).toBe(0);
  // 1.11.0 is accepted.
  await report(request, token, { firmwareVersion: '1.11.0+g1', secondDrive: 'off', driveVersion: 0 });
  const ok = await patch();
  expect(ok.status()).toBe(200);
  expect((await ok.json()).version).toBe(1);
  expect((await row(deviceId)).secondDrive).toBe('net');
});

test('choosing Network reaches the board and reads applied once acked', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await report(request, token, { firmwareVersion: '1.11.0+gabc1234', secondDrive: 'off', driveVersion: 0, sel1Wired: true, df1Seen: false });
  await page.goto('/devices');
  await page.getByTestId(`second-drive-${deviceId}`).selectOption('net');
  await expect(page.getByTestId(`second-drive-status-${deviceId}`)).toHaveText('Waiting for the board');
  const poll = await request.get('/api/device/poll?since=0&driveAck=0', { headers: authHeader(token) });
  const b1 = await poll.json();
  expect(b1.secondDrive).toEqual({ seq: 1, mode: 'net' });
  // Not applied yet: the driver disk is not named (it would be preloaded under the old mode).
  expect(b1.next ?? null).toBeNull();
  await report(request, token, { firmwareVersion: '1.11.0+gabc1234', secondDrive: 'net', driveVersion: 1,
    net: { framesIn: 0, framesOut: 0 } });
  await expect(page.getByTestId(`second-drive-status-${deviceId}`))
    .toHaveText('Set on the board — takes effect when the Amiga restarts', { timeout: LIVE });
  // Nothing in DF0 (a hard-drive boot): the poll still names the driver disk (Review Focus 2).
  // driveAck=0 against seq 1 wakes the poll at once (the hold would otherwise run 25 s).
  const poll2 = await request.get('/api/device/poll?since=0&driveAck=0', { headers: authHeader(token) });
  expect(poll2.status()).toBe(200);
  const b2 = await poll2.json();
  expect(b2.desired).toBeNull();
  expect(b2.next).toEqual({ diskId: 'paulanet', sha256: PAULANET_DISK_SHA256, diskNo: 1 });
  // Nothing loaded, nothing heard yet: both values named.
  await expect(page.getByTestId(`net-disk-${deviceId}`)).toContainText('Driver disk: loading');
  await expect(page.getByTestId(`net-driver-${deviceId}`))
    .toContainText('Driver: not heard from yet — run Install, then AddNetInterface eth0');
  await expect(page.getByTestId(`net-ip-${deviceId}`)).toContainText('Amiga address: none yet');
  await expect(page.getByTestId(`net-traffic-${deviceId}`)).toHaveCount(0);
});

test('the checklist reads the board\'s net report: all three good, and traffic', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await report(request, token, { firmwareVersion: '1.11.0+gabc1234', secondDrive: 'off', driveVersion: 0 });
  await page.goto('/devices');
  await page.getByTestId(`second-drive-${deviceId}`).selectOption('net');
  await expect.poll(async () => (await row(deviceId)).secondDrive).toBe('net');
  await report(request, token, { firmwareVersion: '1.11.0+gabc1234', mountedSha256: 'a'.repeat(64),
    secondDrive: 'net', driveVersion: 1, df1Sha256: PAULANET_DISK_SHA256,
    net: { driver: 4, amigaIp: '172.16.10.231', framesIn: 1234, framesOut: 56 } });
  // Live, no reload: the checklist's state transitions move the fingerprint.
  await expect(page.getByTestId(`net-disk-${deviceId}`)).toContainText('Driver disk: in DF1', { timeout: LIVE });
  await expect(page.getByTestId(`net-driver-${deviceId}`)).toContainText(/Driver: talking \(last seen \d+ s ago\)/);
  await expect(page.getByTestId(`net-ip-${deviceId}`)).toContainText('Amiga address: 172.16.10.231');
  await expect(page.getByTestId(`net-traffic-${deviceId}`)).toHaveText('Traffic: 1,234 frames from the Amiga, 56 to it');
  for (const k of ['net-disk', 'net-driver', 'net-ip']) await expect(page.getByTestId(`${k}-${deviceId}`)).toHaveAttribute('data-ok', 'true');
  // Back to Off: the checklist goes.
  await report(request, token, { firmwareVersion: '1.11.0+gabc1234', secondDrive: 'off', driveVersion: 1 });
  await expect(page.getByTestId(`net-checklist-${deviceId}`)).toHaveCount(0, { timeout: LIVE });
});

test('a seen DF1 refuses Network; the override saves Network (Review Focus 5)', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await report(request, token, { firmwareVersion: '1.11.0+gabc1234', secondDrive: 'off', driveVersion: 0, sel1Wired: true, df1Seen: true });
  await page.goto('/devices');
  await page.getByTestId(`second-drive-${deviceId}`).selectOption('net');
  await expect(page.getByTestId(`second-drive-refused-${deviceId}`)).toContainText('A drive already answers as DF1 on this Amiga');
  expect((await row(deviceId)).secondDriveVersion).toBe(0);
  await page.getByTestId(`second-drive-override-${deviceId}`).click();
  await page.getByTestId(`second-drive-override-confirm-${deviceId}`).click();
  await expect.poll(async () => (await row(deviceId)).secondDrive).toBe('net');
});
