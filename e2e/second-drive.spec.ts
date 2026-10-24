import { test, expect, type APIRequestContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { PAULANET_DISK_SHA256 } from '@/lib/paulanet-disk';
import { signUpFresh, runTag } from './helpers';
import { pairDevice, authHeader, cleanupSeeded, seedDisk, df1OnBoard, pickSecondDrive } from './device-helpers';

test.afterAll(cleanupSeeded);

async function report(request: APIRequestContext, token: string, extra: Record<string, unknown>) {
  const res = await request.post('/api/device/status', {
    headers: authHeader(token), data: { mountedSha256: null, firmwareVersion: '1.9.0', ...extra },
  });
  expect(res.status()).toBe(204);
}
/** LiveRefresh polls every 3 s while the tab is in use; allow a few ticks plus the RSC refresh. */
const LIVE = 15_000;
/** Wait until React has hydrated the radiogroup: a key pressed before that reaches DOM with no handler. */
async function hydrated(page: import('@playwright/test').Page, deviceId: string) {
  await page.waitForFunction((id) => {
    const el = document.querySelector(`[data-testid="second-drive-${id}"]`);
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$') && typeof (el as unknown as Record<string, { onKeyDown?: unknown }>)[k]?.onKeyDown === 'function');
  }, deviceId);
}
const row = async (id: string) => (await getDb().select().from(devices).where(eq(devices.id, id)))[0];

test('a board without DF1 support is told which firmware it needs', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await report(request, token, { firmwareVersion: '1.7.4' });
  await page.goto('/devices');
  await expect(page.getByTestId(`second-drive-status-${deviceId}`)).toHaveText('Needs firmware 1.9.0 or newer');
  for (const m of ['off', 'df1', 'net', 'any']) await expect(page.getByTestId(`second-drive-${deviceId}-${m}`)).toBeDisabled();
});

test('switching DF1 on reaches the board through the poll and reads applied once acked', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await report(request, token, { secondDrive: 'off', driveVersion: 0, sel1Wired: true, df1Seen: false });
  await page.goto('/devices');
  await expect(page.getByTestId(`device-df1seen-${deviceId}`)).toHaveText('Other DF1 drive: none seen');
  await pickSecondDrive(page, deviceId, 'df1');
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
  await pickSecondDrive(page, deviceId, 'df1');
  await expect(page.getByTestId(`second-drive-refused-${deviceId}`)).toContainText('A drive already answers as DF1 on this Amiga');
  expect((await row(deviceId)).secondDriveVersion).toBe(0);           // nothing saved
  await page.getByTestId(`second-drive-override-${deviceId}`).click();
  expect((await row(deviceId)).secondDriveVersion).toBe(0);           // one click is not enough
  await page.getByTestId(`second-drive-override-confirm-${deviceId}`).click();
  await expect.poll(async () => (await row(deviceId)).secondDrive).toBe('df1');
});

test('a failed save shows the error and leaves the radiogroup at the stored value', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await report(request, token, { secondDrive: 'off', driveVersion: 0, sel1Wired: true, df1Seen: false });
  await page.goto('/devices');
  await page.route(`**/api/devices/${deviceId}/second-drive`, (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ reason: 'Database unavailable' }) }));
  const group = page.getByTestId(`second-drive-${deviceId}`);
  await pickSecondDrive(page, deviceId, 'df1');
  await expect(page.getByTestId(`second-drive-error-${deviceId}`)).toHaveText('Database unavailable');
  await expect(group).toHaveAttribute('data-value', 'off');
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

test('Network needs 1.11.0: the radio says so, and the route refuses', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await report(request, token, { firmwareVersion: '1.10.2+gabc1234', secondDrive: 'off', driveVersion: 0 });
  await page.goto('/devices');
  await expect(page.getByTestId(`second-drive-${deviceId}-net`)).toBeDisabled();
  await expect(page.getByTestId(`second-drive-net-note-${deviceId}`)).toHaveText('Network needs firmware 1.11.0 or newer');
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
  await pickSecondDrive(page, deviceId, 'net');
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
  await pickSecondDrive(page, deviceId, 'net');
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
  await pickSecondDrive(page, deviceId, 'net');
  await expect(page.getByTestId(`second-drive-refused-${deviceId}`)).toContainText('A drive already answers as DF1 on this Amiga');
  expect((await row(deviceId)).secondDriveVersion).toBe(0);
  await page.getByTestId(`second-drive-override-${deviceId}`).click();
  await page.getByTestId(`second-drive-override-confirm-${deviceId}`).click();
  await expect.poll(async () => (await row(deviceId)).secondDrive).toBe('net');
});

const sha = (s: string) => createHash('sha256').update(`df1-any-${s}`).digest('hex');
const FW = '1.12.0+gabc1234';

test('the setting reads Off / Next disk of the set / Any disk / Network, with the help line under it (D4, A4)', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId } = await df1OnBoard(page, request);
  await page.goto('/devices');
  const group = page.getByTestId(`second-drive-${deviceId}`);
  await expect(group).toHaveAttribute('data-value', 'df1');             // the stored value is unchanged
  await expect(group.getByRole('radio')).toHaveText(['Off', 'Next disk of the set', 'Network (PaulaNET)', 'Any disk']);
  await expect(page.getByTestId(`second-drive-help-${deviceId}`))
    .toHaveText('DF1 holds the next disk of the set, read-only, so a game asking for its next disk finds it.');
  await expect(page.getByTestId(`device-df1-disk-${deviceId}`)).toHaveText('DF1: next disk of the set — empty');
});

test('a disk mounted into DF1 reaches the board by its own cursor, shows on the card, and Eject DF1 drops it', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await df1OnBoard(page, request);
  const tag = runTag();
  const pick = sha(`pick-${tag}`);
  const { diskId } = await seedDisk(orgId, { title: `Pick-${tag}`, diskNo: 1, sha256: pick });
  const m = await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId, drive: 'df1' } });
  expect(m.status()).toBe(200);
  expect(await m.json()).toEqual({ version: 1, undo: { diskId: null } });   // DF1 had no pick: Undo would eject it (A3)
  expect((await row(deviceId)).df1DiskId).toBe(diskId);
  expect((await row(deviceId)).desiredDiskId).toBeNull();               // DF0 untouched

  const poll = await request.get('/api/device/poll?since=0&driveAck=1&df1Ack=0', { headers: authHeader(token) });
  expect(poll.status()).toBe(200);
  expect((await poll.json()).df1).toEqual({ v: 1, sha256: pick });
  // A 1.11 board sends no df1Ack and is never sent the key (Review Focus 4). since=5 > version 0 answers at once.
  const old = await request.get('/api/device/poll?since=5&driveAck=1', { headers: authHeader(token) });
  expect((await old.json()).df1).toBeUndefined();

  await page.goto('/devices');
  await expect(page.getByTestId(`device-df1-disk-${deviceId}`)).toHaveText(`DF1: Pick-${tag} disk 1 — read-only, loading`);
  await report(request, token, { firmwareVersion: FW, secondDrive: 'df1', driveVersion: 1, df1Sha256: pick });
  await expect(page.getByTestId(`device-df1-disk-${deviceId}`))
    .toHaveText(`DF1: Pick-${tag} disk 1 — read-only`, { timeout: LIVE });

  await page.getByTestId(`eject-df1-${deviceId}`).click();
  await expect.poll(async () => (await row(deviceId)).df1DiskId).toBeNull();
  expect((await row(deviceId)).df1Version).toBe(2);
  const after = await request.get('/api/device/poll?since=0&driveAck=1&df1Ack=1', { headers: authHeader(token) });
  expect((await after.json()).df1).toEqual({ v: 2, sha256: null });
});

test('mounting into DF0 the disk in DF1 moves it; switching DF1 Off drops a pick', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await df1OnBoard(page, request);
  const tag = runTag();
  const { diskId } = await seedDisk(orgId, { title: `Move-${tag}`, diskNo: 1, sha256: sha(`move-${tag}`) });
  expect((await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId, drive: 'df1' } })).status()).toBe(200);
  expect((await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } })).status()).toBe(200);
  let r = await row(deviceId);
  expect(r.desiredDiskId).toBe(diskId);
  expect(r.df1DiskId).toBeNull();
  expect(r.df1Version).toBe(2);
  const other = await seedDisk(orgId, { title: `Off-${tag}`, diskNo: 1, sha256: sha(`off-${tag}`) });
  expect((await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId: other.diskId, drive: 'df1' } })).status()).toBe(200);
  expect((await page.request.patch(`/api/devices/${deviceId}/second-drive`, { data: { mode: 'off' } })).status()).toBe(200);
  r = await row(deviceId);
  expect(r.secondDrive).toBe('off');
  expect(r.df1DiskId).toBeNull();
  expect(r.df1Version).toBe(4);
});

test('deleting the disk in DF1 drops the pick and tells the board (Review Focus 5)', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await df1OnBoard(page, request);
  const tag = runTag();
  const { diskId } = await seedDisk(orgId, { title: `Gone-${tag}`, diskNo: 1, sha256: sha(`gone-${tag}`) });
  expect((await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId, drive: 'df1' } })).status()).toBe(200);
  const del = await page.request.delete(`/api/disks/${diskId}`);
  expect(del.status()).toBe(200);
  const r = await row(deviceId);
  expect(r.df1DiskId).toBeNull();
  expect(r.df1Version).toBe(2);
  const poll = await request.get('/api/device/poll?since=0&driveAck=1&df1Ack=1', { headers: authHeader(token) });
  expect((await poll.json()).df1).toEqual({ v: 2, sha256: null });
});

test('the server refuses DF1 on a board before 1.12.0, in words', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await df1OnBoard(page, request, '1.11.1+g0a157eb');
  const tag = runTag();
  const { diskId } = await seedDisk(orgId, { title: `Old-${tag}`, diskNo: 1, sha256: sha(`old-${tag}`) });
  const res = await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId, drive: 'df1' } });
  expect(res.status()).toBe(409);
  expect(await res.json()).toEqual({ error: 'firmware_too_old', reason: 'Needs firmware 1.12.0' });
  expect((await row(deviceId)).df1Version).toBe(0);
});

test('fw 1.12.1 (netPick): the driver disk comes as DF1\'s pick, and leaving Network takes it away', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const fw = '1.12.1+gabc1234';
  await report(request, token, { firmwareVersion: fw, secondDrive: 'off', driveVersion: 0, sel1Wired: true, df1Seen: false });
  await page.goto('/devices');
  await pickSecondDrive(page, deviceId, 'net');
  await expect(page.getByTestId(`second-drive-status-${deviceId}`)).toHaveText('Waiting for the board');
  const q = (driveAck: number, df1Ack: number) =>
    `/api/device/poll?since=0&driveAck=${driveAck}&df1Ack=${df1Ack}&netPick=1`;
  const b1 = await (await request.get(q(0, 0), { headers: authHeader(token) })).json();
  expect(b1.secondDrive).toEqual({ seq: 1, mode: 'net' });
  expect(b1.df1).toEqual({ v: 0, sha256: null });   // not applied yet: nothing for DF1
  await report(request, token, { firmwareVersion: fw, secondDrive: 'net', driveVersion: 1, df1Sha256: null,
    net: { framesIn: 0, framesOut: 0 } });
  // Applied: the one-shot wake moves the DF1 cursor and names the driver disk as DF1's pick, never as `next`.
  const r2 = await request.get(q(1, 0), { headers: authHeader(token) });
  expect(r2.status()).toBe(200);
  const b2 = await r2.json();
  expect(b2.df1).toEqual({ v: 1, sha256: PAULANET_DISK_SHA256 });
  expect(b2).not.toHaveProperty('next');            // nothing in DF0, no set: no next at all
  expect((await row(deviceId)).df1Version).toBe(1);
  // Off: the setting write moves the cursor too, so the board hears the driver disk go.
  await pickSecondDrive(page, deviceId, 'off');
  await expect.poll(async () => (await row(deviceId)).secondDrive).toBe('off');
  expect((await row(deviceId)).df1Version).toBe(2);
  const b3 = await (await request.get(q(1, 1), { headers: authHeader(token) })).json();
  expect(b3.secondDrive).toEqual({ seq: 2, mode: 'off' });
  expect(b3.df1).toEqual({ v: 2, sha256: null });
});

// A4: "Any disk" is its own choice, stored as the same 'df1' as "Next disk of the set"; what DF1 holds tells them
// apart.
test('Any disk shows while DF1 holds a disk mounted into it; Next disk of the set ejects that disk', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await df1OnBoard(page, request);
  const tag = runTag();
  const { diskId } = await seedDisk(orgId, { title: `AnyPick-${tag}`, diskNo: 1, sha256: sha(`anypick-${tag}`) });
  expect((await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId, drive: 'df1' } })).status()).toBe(200);

  await page.goto('/devices');
  const group = page.getByTestId(`second-drive-${deviceId}`);
  await expect(group).toHaveAttribute('data-value', 'any');
  await expect(page.getByTestId(`second-drive-help-${deviceId}`))
    .toHaveText('DF1 holds a disk you mount into DF1 from the library, read-only.');

  await pickSecondDrive(page, deviceId, 'df1');
  await expect.poll(async () => (await row(deviceId)).df1DiskId).toBeNull();
  await expect(group).toHaveAttribute('data-value', 'df1');
  expect((await row(deviceId)).secondDrive).toBe('df1');
});

test('Any disk on a board with DF1 Off switches DF1 on and says how to fill it', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId } = await df1OnBoard(page, request);
  expect((await page.request.patch(`/api/devices/${deviceId}/second-drive`, { data: { mode: 'off' } })).status()).toBe(200);

  await page.goto('/devices');
  const group = page.getByTestId(`second-drive-${deviceId}`);
  await expect(group).toHaveAttribute('data-value', 'off');
  await pickSecondDrive(page, deviceId, 'any');
  await expect.poll(async () => (await row(deviceId)).secondDrive).toBe('df1');
  await expect(group).toHaveAttribute('data-value', 'any');
  await expect(page.getByTestId(`second-drive-help-${deviceId}`)).toHaveText(
    'DF1 holds a disk you mount into DF1 from the library, read-only. Mount one with a title’s Mount → DF1; until then DF1 holds the next disk of the set.');
});

// Ruling 14: the radiogroup roves. Tab enters on the checked radio; an arrow key moves the selection and saves it.
test('arrow keys move the DF1 selection and save it; Tab enters on the checked radio only', async ({ page, request }) => {
  await signUpFresh(page);
  // 1.10.2: DF1 modes but no Network, so ArrowRight from "Next disk" must skip the disabled Network radio.
  const { deviceId } = await df1OnBoard(page, request, '1.10.2+gabc1234');
  await page.goto('/devices');
  const radio = (m: string) => page.getByTestId(`second-drive-${deviceId}-${m}`);
  await expect(radio('df1')).toHaveAttribute('aria-checked', 'true');
  for (const m of ['off', 'net', 'any']) await expect(radio(m)).toHaveAttribute('tabindex', '-1');
  await expect(radio('df1')).toHaveAttribute('tabindex', '0');
  await hydrated(page, deviceId);
  await radio('df1').focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await row(deviceId)).secondDrive).toBe('off');
  await expect(page.getByTestId(`second-drive-${deviceId}`)).toHaveAttribute('data-value', 'off');
  await expect(radio('off')).toBeFocused();   // focus moved with the arrow and stayed
  await expect(radio('off')).toHaveAttribute('aria-disabled', 'false');   // presses during a save are ignored: wait it out
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await row(deviceId)).secondDrive).toBe('df1');
  await expect(radio('df1')).toBeFocused();
  await expect(page.getByTestId(`second-drive-${deviceId}`)).toHaveAttribute('data-value', 'df1');
  await expect(radio('df1')).toHaveAttribute('aria-disabled', 'false');
  await page.keyboard.press('ArrowRight');   // Network is disabled on 1.10.2: skipped, Any disk is next
  await expect(page.getByTestId(`second-drive-${deviceId}`)).toHaveAttribute('data-value', 'any');
  await expect(radio('any')).toBeFocused();
});

test('a Network board shows the Transfer box inside the DF1 box', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await report(request, token, { firmwareVersion: '1.21.1+gabc1234', secondDrive: 'net', driveVersion: 0, sel1Wired: true, df1Seen: false,
    net: { framesIn: 0, framesOut: 0 } });
  await page.goto('/devices');
  const box = page.getByTestId(`device-df1-${deviceId}`);
  await expect(box.getByTestId(`net-checklist-${deviceId}`)).toBeVisible({ timeout: LIVE });
  await expect(box.getByTestId(`device-transfer-${deviceId}`)).toBeVisible();
  await expect(page.getByTestId(`device-transfer-${deviceId}`)).toHaveCount(1);
});

// Fix round 1: while a save runs the radios are aria-disabled (not disabled), so focus never drops to body, and
// finishing the save never pulls focus back to the group once the user has moved on.
test('during a DF1 save focus stays on the radio, and moving on is not undone when the save ends', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId } = await df1OnBoard(page, request);
  await page.goto('/devices');
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route(`**/api/devices/${deviceId}/second-drive`, async (route) => { await held; await route.continue(); });
  const radio = (m: string) => page.getByTestId(`second-drive-${deviceId}-${m}`);
  await expect(radio('df1')).toHaveAttribute('aria-checked', 'true');
  await hydrated(page, deviceId);
  await radio('df1').focus();
  await page.keyboard.press('ArrowRight');
  await expect(radio('net')).toBeFocused();                       // focus did not drop while the save is held
  await expect(radio('net')).toHaveAttribute('aria-disabled', 'true');
  await expect(radio('net')).not.toHaveAttribute('disabled', '');
  await page.keyboard.press('ArrowRight');                         // ignored during the save
  await expect(radio('net')).toBeFocused();
  const tip = page.getByTestId('help-tip-second-drive').first();
  await tip.focus();
  release();
  await expect.poll(async () => (await row(deviceId)).secondDrive).toBe('net');
  await expect(page.getByTestId(`second-drive-${deviceId}`)).toHaveAttribute('data-value', 'net');
  await expect(radio('net')).toHaveAttribute('aria-disabled', 'false');
  await expect(tip).toBeFocused();
});

test('a failed Any disk save does not leave Any disk shown', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId } = await df1OnBoard(page, request);
  expect((await page.request.patch(`/api/devices/${deviceId}/second-drive`, { data: { mode: 'off' } })).status()).toBe(200);
  await page.goto('/devices');
  await page.route(`**/api/devices/${deviceId}/second-drive`, (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ reason: 'Database unavailable' }) }));
  await pickSecondDrive(page, deviceId, 'any');
  await expect(page.getByTestId(`second-drive-error-${deviceId}`)).toHaveText('Database unavailable');
  await expect(page.getByTestId(`second-drive-${deviceId}`)).toHaveAttribute('data-value', 'off');
  await page.unroute(`**/api/devices/${deviceId}/second-drive`);
  expect((await row(deviceId)).secondDrive).toBe('off');
});
