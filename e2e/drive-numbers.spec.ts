import { test, expect } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { signUpFresh } from './helpers';
import { pairDevice, authHeader, cleanupSeeded, openBoardSettings } from './device-helpers';

/**
 * Drive numbers (src/lib/drive-numbers.ts, 2026-11-11): DF0 + DF1 | DF1 + DF2 | DF2 + DF3 | DF3 only. The setting
 * names both drives everywhere; the second drive stays usable except at DF3, where saving turns it off (the board
 * hears it through its poll) and switching it on is refused.
 */
test.afterAll(cleanupSeeded);

const row = async (id: string) => (await getDb().select().from(devices).where(eq(devices.id, id)))[0];

async function saveBase(page: import('@playwright/test').Page, deviceId: string, base: number) {
  await openBoardSettings(page, deviceId);
  await page.getByTestId(`drive-base-${deviceId}-${base}`).click();
  await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/devices/${deviceId}/drive-base`) && r.request().method() === 'PATCH' && r.status() === 200),
    page.getByTestId('board-settings-save').click(),
  ]);
  await expect(page.getByTestId('board-settings-dialog')).toHaveCount(0);
}

test('DF1 + DF2 names both drives and keeps the second; DF3 turns it off and refuses it', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'Numbers');
  expect((await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: '1.21.1+ge2e', secondDrive: 'off', driveVersion: 0, sel1Wired: false, df1Seen: false },
  })).status()).toBe(204);
  expect((await page.request.patch(`/api/devices/${deviceId}/second-drive`, { data: { mode: 'df1' } })).status()).toBe(200);

  await page.goto('/devices');
  await openBoardSettings(page, deviceId);
  await expect(page.getByTestId(`drive-base-${deviceId}`)).toHaveAttribute('data-value', '0');
  await page.getByTestId('board-settings-cancel').click();
  await expect(page.getByTestId(`device-df1-${deviceId}`)).toContainText('Second drive (DF1)');

  // DF1 + DF2: the second drive stays on, now named DF2, with the wiring hint (no select seen on its line).
  await saveBase(page, deviceId, 1);
  expect((await row(deviceId)).driveBase).toBe(1);
  expect((await row(deviceId)).secondDrive).toBe('df1');
  const box = page.getByTestId(`device-df1-${deviceId}`);
  await expect(box).toContainText('Second drive (DF2)');
  await expect(page.getByTestId(`device-sel1-${deviceId}`)).toHaveText('DF2 line: no signal yet');
  await expect(page.getByTestId(`second-drive-unwired-${deviceId}`)).toContainText("DF2's select line");
  await openBoardSettings(page, deviceId);
  await expect(page.getByTestId(`boot-disk-hint-${deviceId}`)).toHaveText('The board puts the last disk back in DF1 when it starts.');
  await page.getByTestId('board-settings-cancel').click();

  // DF3 only: saving warns, then turns the second drive off; the board hears Off; switching it on is refused.
  const before = await row(deviceId);
  await openBoardSettings(page, deviceId);
  await page.getByTestId(`drive-base-${deviceId}-3`).click();
  await expect(page.getByTestId(`drive-base-drops-second-${deviceId}`)).toBeVisible();
  await page.getByTestId('board-settings-cancel').click();
  await saveBase(page, deviceId, 3);
  const after = await row(deviceId);
  expect([after.driveBase, after.secondDrive, after.secondDriveVersion]).toEqual([3, 'off', before.secondDriveVersion + 1]);
  const poll = await request.get(`/api/device/poll?since=0&driveAck=${before.secondDriveVersion}`, { headers: authHeader(token) });
  expect((await poll.json()).secondDrive).toEqual({ seq: after.secondDriveVersion, mode: 'off' });
  await expect(page.getByTestId(`device-df1-none-${deviceId}`)).toContainText('Second drive: none');
  const refused = await page.request.patch(`/api/devices/${deviceId}/second-drive`, { data: { mode: 'df1' } });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error).toBe('no_second_drive');

  // Back to DF0 + DF1: the usual names, and the second drive can be switched on again.
  await saveBase(page, deviceId, 0);
  await expect(page.getByTestId(`device-df1-${deviceId}`)).toContainText('Second drive (DF1)');
  expect((await page.request.patch(`/api/devices/${deviceId}/second-drive`, { data: { mode: 'df1' } })).status()).toBe(200);
});

test('the route takes only 0-3 and only the caller\'s board', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  expect((await page.request.patch(`/api/devices/${deviceId}/drive-base`, { data: { base: 4 } })).status()).toBe(400);
  expect((await page.request.patch(`/api/devices/${deviceId}/drive-base`, { data: { base: '1' } })).status()).toBe(400);
  expect((await page.request.patch('/api/devices/not-a-board/drive-base', { data: { base: 1 } })).status()).toBe(404);
});

test('at phone width the four choices stay inside the dialog', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request, 'Phone Fit');
  await page.goto('/devices');
  await openBoardSettings(page, deviceId);
  const dialog = await page.getByTestId('board-settings-dialog').boundingBox();
  const group = await page.getByTestId(`drive-base-${deviceId}`).boundingBox();
  expect(group!.x).toBeGreaterThanOrEqual(dialog!.x);
  expect(group!.x + group!.width).toBeLessThanOrEqual(dialog!.x + dialog!.width);
  await page.getByTestId(`drive-base-${deviceId}`).screenshot({ path: 'test-results/drive-numbers-phone.png' });
});
