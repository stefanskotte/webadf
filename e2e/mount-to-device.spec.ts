import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { signUpFresh, runTag } from './helpers';
import { pairDevice, seedDisk, addDisk, cleanupSeeded, df1OnBoard } from './device-helpers';

test.afterAll(cleanupSeeded);

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });

async function deviceRow(deviceId: string) {
  const r = await getDb().select().from(devices).where(eq(devices.id, deviceId));
  return r[0];
}

/** Make a device look like it polled just now, so an outstanding request reads
 *  as `pending` rather than `stale`. Registering does not touch last_seen_at. */
async function seenNow(deviceId: string) {
  await getDb().update(devices).set({ lastSeenAt: new Date() })
    .where(eq(devices.id, deviceId));
}

/** Drive a real mount through the API and have the device confirm it, so the
 *  row reaches `converged` the way the protocol actually gets it there. */
async function mountAndConfirm(
  page: import('@playwright/test').Page,
  request: import('@playwright/test').APIRequestContext,
  deviceId: string, token: string, diskId: string, sha256: string,
) {
  const res = await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } });
  expect(res.status()).toBe(200);
  const { version } = await res.json();
  const report = await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: sha256, mountedDiskId: diskId, version },
  });
  expect(report.status()).toBe(204);
  await seenNow(deviceId);
}

test('a device holding the disk offers Eject, and ejecting clears it', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const tag = runTag();
  const { gameId, diskId } = await seedDisk(orgId, {
    title: `EjectOne-${tag}`, diskNo: 1, sha256: sha(tag),
  });

  await mountAndConfirm(page, request, deviceId, token, diskId, sha(tag));

  await page.goto(`/games/${gameId}`);

  // The whole point of the change: from the LIBRARY, on the disk itself, the
  // action is now the one that applies. Before this, the only affordance here
  // was Mount -- recalling a disk meant leaving for the Devices tab.
  const eject = page.getByTestId(`eject-${diskId}`);
  await expect(eject).toBeVisible();
  await expect(eject).toHaveText('Eject');
  // And prove Mount is genuinely gone, not merely restyled: offering both
  // would let someone re-mount what is already mounted and wonder why nothing
  // happened.
  await expect(page.getByTestId(`mount-${diskId}`)).toHaveCount(0);

  await Promise.all([
    page.waitForResponse((r) =>
      r.url().includes(`/api/devices/${deviceId}/eject`) && r.request().method() === 'POST'),
    eject.click(),
  ]);

  await expect.poll(async () => (await deviceRow(deviceId)).desiredSha256).toBeNull();
  expect((await deviceRow(deviceId)).desiredDiskId).toBeNull();
});

test('the picker says what each device is holding, not just its name', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId: busyId, token: busyToken } = await pairDevice(page, request, 'Busy Drive');
  const { deviceId: freeId } = await pairDevice(page, request, 'Free Drive');
  const tag = runTag();

  // The disk the page is about, and a different one already in the first drive.
  const { gameId, diskId } = await seedDisk(orgId, {
    title: `Subject-${tag}`, diskNo: 1, sha256: sha(`${tag}-subject`),
  });
  const { diskId: otherId } = await addDisk(orgId, gameId, {
    diskNo: 2, sha256: sha(`${tag}-other`),
  });
  await mountAndConfirm(page, request, busyId, busyToken, otherId, sha(`${tag}-other`));
  await seenNow(freeId);

  await page.goto(`/games/${gameId}`);
  await page.getByTestId(`mount-${diskId}`).click();
  const menu = page.getByTestId(`mount-${diskId}-menu`);
  await expect(menu).toBeVisible();

  // This is the half the old picker left out. Without it a person had to open
  // the Devices tab to find out which unit was free -- which is precisely the
  // trip this feature exists to remove.
  await expect(menu.getByTestId(`mount-status-${diskId}-${busyId}`)).toHaveText(/disk 2/);
  await expect(menu.getByTestId(`mount-status-${diskId}-${freeId}`)).toHaveText('empty');

  // Neither holds THIS disk, so both offer to take it.
  await expect(menu.getByTestId(`mount-${diskId}-to-${busyId}`)).toHaveText('Mount here');
  await expect(menu.getByTestId(`mount-${diskId}-to-${freeId}`)).toHaveText('Mount here');
});

test('with several devices, only the one holding the disk offers Eject', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId: holderId, token: holderToken } = await pairDevice(page, request, 'Holder');
  const { deviceId: otherId } = await pairDevice(page, request, 'Other');
  const tag = runTag();
  const { gameId, diskId } = await seedDisk(orgId, {
    title: `EjectMany-${tag}`, diskNo: 1, sha256: sha(tag),
  });

  await mountAndConfirm(page, request, holderId, holderToken, diskId, sha(tag));
  await seenNow(otherId);

  await page.goto(`/games/${gameId}`);

  // The trigger answers "where is this disk?" before it is even opened.
  //
  // Asserted against the name the row ACTUALLY carries rather than the one
  // passed to pairDevice. Since plan 2026-10-17 R8 a name given at pairing is
  // kept (one omitted leaves "Device <MAC>"); reading it back keeps this test
  // honest either way.
  const holderName = (await deviceRow(holderId)).name;
  const trigger = page.getByTestId(`mount-${diskId}`);
  await expect(trigger).toHaveText(`In ${holderName} ▾`);

  await trigger.click();
  const menu = page.getByTestId(`mount-${diskId}-menu`);
  await expect(menu.getByTestId(`eject-${diskId}-from-${holderId}`)).toHaveText('Eject');
  await expect(menu.getByTestId(`mount-${diskId}-to-${otherId}`)).toHaveText('Mount here');
  // The holder must not also offer a mount, and the other must not offer an
  // eject -- a picker that offered both everywhere would be no help at all.
  await expect(menu.getByTestId(`mount-${diskId}-to-${holderId}`)).toHaveCount(0);
  await expect(menu.getByTestId(`eject-${diskId}-from-${otherId}`)).toHaveCount(0);

  await Promise.all([
    page.waitForResponse((r) =>
      r.url().includes(`/api/devices/${holderId}/eject`) && r.request().method() === 'POST'),
    menu.getByTestId(`eject-${diskId}-from-${holderId}`).click(),
  ]);

  // The chosen device changed and the other did not. Asserting only "something
  // was ejected" would pass even if the wrong drive were targeted.
  await expect.poll(async () => (await deviceRow(holderId)).desiredSha256).toBeNull();
  expect((await deviceRow(otherId)).desiredSha256).toBeNull();
  expect((await deviceRow(otherId)).desiredDiskId).toBeNull();
});

test('a mount still in flight offers Cancel, and never claims to be mounted', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request, 'Fetching Drive');
  const { deviceId: otherId } = await pairDevice(page, request, 'Spare');
  const tag = runTag();
  const { gameId, diskId } = await seedDisk(orgId, {
    title: `Pending-${tag}`, diskNo: 1, sha256: sha(tag),
  });

  // Asked for, never confirmed -- no status report. The device is polling, so
  // this is progress rather than a problem, and must read that way.
  const res = await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } });
  expect(res.status()).toBe(200);
  await seenNow(deviceId);
  await seenNow(otherId);

  await page.goto(`/games/${gameId}`);
  await page.getByTestId(`mount-${diskId}`).click();
  const menu = page.getByTestId(`mount-${diskId}-menu`);

  // "Cancel", not "Eject": nothing has landed, so there is nothing to eject,
  // and a person who picked the wrong drive is looking for the former.
  const cancel = menu.getByTestId(`eject-${diskId}-from-${deviceId}`);
  await expect(cancel).toHaveText('Cancel');
  await expect(menu.getByTestId(`mount-status-${diskId}-${deviceId}`)).toHaveText(/^fetching /);

  // The §7 rule, guarded where a person actually reads it: desired state is
  // never presented as fact.
  await expect(menu.getByTestId(`mount-status-${diskId}-${deviceId}`)).not.toHaveText(/^Pending-/);

  await Promise.all([
    page.waitForResponse((r) =>
      r.url().includes(`/api/devices/${deviceId}/eject`) && r.request().method() === 'POST'),
    cancel.click(),
  ]);
  await expect.poll(async () => (await deviceRow(deviceId)).desiredDiskId).toBeNull();
});

test('with DF1 On, a disk row offers DF0 and DF1; DF1 mounts into DF1 and leaves DF0 alone', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await df1OnBoard(page, request);
  const tag = runTag();
  const { gameId, diskId } = await seedDisk(orgId, { title: `DF1Row-${tag}`, diskNo: 1, sha256: sha(`df1row-${tag}`) });
  await page.goto(`/games/${gameId}`);
  await expect(page.getByTestId(`mount-${diskId}`)).toHaveText('DF0');
  await expect(page.getByTestId(`mount-${diskId}-df1`)).toHaveText('DF1');
  await expect(page.getByTestId(`mount-${diskId}-df1-note`)).toHaveText('DF1 is read-only');
  await page.getByTestId(`mount-${diskId}-df1`).click();
  await expect(page.getByText('Mount into DF1 requested')).toBeVisible();
  await expect.poll(async () => (await deviceRow(deviceId)).df1DiskId).toBe(diskId);
  expect((await deviceRow(deviceId)).desiredDiskId).toBeNull();
  // After the refresh the same row takes it out of DF1.
  await expect(page.getByTestId(`eject-${diskId}-df1`)).toHaveText('Eject DF1');
  await page.getByTestId(`eject-${diskId}-df1`).click();
  await expect.poll(async () => (await deviceRow(deviceId)).df1DiskId).toBeNull();
});

test('the DF1 choice is disabled with its reason: an HFE, the disk DF0 is about to hold, firmware before 1.12.0', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await df1OnBoard(page, request);
  const tag = runTag();
  const hfe = await seedDisk(orgId, { title: `DF1Hfe-${tag}`, diskNo: 1, sha256: sha(`df1hfe-${tag}`), imageFormat: 'hfe', sizeBytes: 2_000_000 });
  await page.goto(`/games/${hfe.gameId}`);
  await expect(page.getByTestId(`mount-${hfe.diskId}-df1`)).toBeDisabled();
  await expect(page.getByTestId(`mount-${hfe.diskId}-df1-note`)).toHaveText('DF1 takes standard DD disks only');

  const dd = await seedDisk(orgId, { title: `DF1Dd-${tag}`, diskNo: 1, sha256: sha(`df1dd-${tag}`) });
  expect((await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId: dd.diskId } })).status()).toBe(200);
  await page.goto(`/games/${dd.gameId}`);
  await expect(page.getByTestId(`mount-${dd.diskId}-df1`)).toBeDisabled();
  await expect(page.getByTestId(`mount-${dd.diskId}-df1-note`)).toHaveText('Already in DF0');
  const refused = await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId: dd.diskId, drive: 'df1' } });
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toEqual({ error: 'in_df0', reason: 'Already in DF0' });

  // The board goes back to 1.11.1 (Review Focus 4).
  expect((await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: '1.11.1+g0a157eb', secondDrive: 'df1', driveVersion: 1 },
  })).status()).toBe(204);
  const old = await seedDisk(orgId, { title: `DF1Old-${tag}`, diskNo: 1, sha256: sha(`df1old-${tag}`) });
  await page.goto(`/games/${old.gameId}`);
  await expect(page.getByTestId(`mount-${old.diskId}-df1`)).toBeDisabled();
  await expect(page.getByTestId(`mount-${old.diskId}-df1-note`)).toHaveText('Needs firmware 1.12.0');
});

test('with two boards, only the one with DF1 On offers DF1 in the picker', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const on = await df1OnBoard(page, request, '1.12.0+gabc1234', 'Board On');
  const off = await pairDevice(page, request, 'Board Off');
  const tag = runTag();
  const { gameId, diskId } = await seedDisk(orgId, { title: `DF1Two-${tag}`, diskNo: 1, sha256: sha(`df1two-${tag}`) });
  await page.goto(`/games/${gameId}`);
  await page.getByTestId(`mount-${diskId}`).click();
  await expect(page.getByTestId(`mount-${diskId}-df1-to-${on.deviceId}`)).toBeVisible();
  await expect(page.getByTestId(`mount-${diskId}-df1-to-${off.deviceId}`)).toHaveCount(0);
  await expect(page.getByTestId(`mount-${diskId}-to-${off.deviceId}`)).toHaveText('Mount here');
  await expect(page.getByTestId(`mount-status-df1-${diskId}-${on.deviceId}`)).toHaveText('DF1 is read-only');
  await page.getByTestId(`mount-${diskId}-df1-to-${on.deviceId}`).click();
  await expect.poll(async () => (await deviceRow(on.deviceId)).df1DiskId).toBe(diskId);
});
