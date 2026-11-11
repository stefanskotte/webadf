import { test, expect } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { signUpFresh } from './helpers';
import { pairDevice, authHeader, cleanupSeeded, openBoardSettings } from './device-helpers';

/**
 * Fitted as (src/lib/fitted-as.ts, 2026-11-11): a board in an external drive case is DF1 to the Amiga. The setting
 * names it so, and keeps its second drive Off -- switching to External turns a running one off through the same path
 * the card's own Off uses, and the second drive then refuses to switch on.
 */
test.afterAll(cleanupSeeded);

const row = async (id: string) => (await getDb().select().from(devices).where(eq(devices.id, id)))[0];

test('External names the drive DF1, switches the second drive off, and keeps it off', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'Ext Case');
  expect((await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: '1.21.1+ge2e', secondDrive: 'off', driveVersion: 0, sel1Wired: true, df1Seen: false },
  })).status()).toBe(204);
  expect((await page.request.patch(`/api/devices/${deviceId}/second-drive`, { data: { mode: 'df1' } })).status()).toBe(200);
  const before = await row(deviceId);
  expect(before.fittedAs).toBe('internal');

  await page.goto('/devices');
  await expect(page.getByTestId(`device-df1-${deviceId}`)).toBeVisible();
  await openBoardSettings(page, deviceId);
  const group = page.getByTestId(`fitted-as-${deviceId}`);
  await expect(group).toHaveAttribute('data-value', 'internal');
  await expect(page.getByTestId(`boot-disk-hint-${deviceId}`)).toHaveText('The board puts the last disk back in DF0 when it starts.');
  await expect(page.getByTestId('board-settings-save')).toBeDisabled();

  await page.getByTestId(`fitted-as-${deviceId}-external`).click();
  await expect(group).toHaveAttribute('data-value', 'external');
  await expect(page.getByTestId(`fitted-as-drops-df1-${deviceId}`)).toBeVisible();
  await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/devices/${deviceId}/fitted-as`) && r.request().method() === 'PATCH' && r.status() === 200),
    page.getByTestId('board-settings-save').click(),
  ]);
  await expect(page.getByTestId('board-settings-dialog')).toHaveCount(0);
  await expect(page.getByText('Board settings saved.')).toBeVisible();

  const after = await row(deviceId);
  expect(after.fittedAs).toBe('external');
  expect(after.secondDrive).toBe('off');
  expect(after.secondDriveVersion).toBe(before.secondDriveVersion + 1);
  // The board hears Off through its poll, as from the card's own Off.
  const poll = await request.get(`/api/device/poll?since=0&driveAck=${before.secondDriveVersion}`, { headers: authHeader(token) });
  expect((await poll.json()).secondDrive).toEqual({ seq: after.secondDriveVersion, mode: 'off' });

  // The card says why there is no second drive, in words; the setting names the drive DF1.
  await expect(page.getByTestId(`device-df1-external-${deviceId}`)).toContainText('Second drive: Off');
  await expect(page.getByTestId(`device-df1-${deviceId}`)).toHaveCount(0);
  await openBoardSettings(page, deviceId);
  await expect(page.getByTestId(`boot-disk-hint-${deviceId}`)).toHaveText('The board puts the last disk back in DF1 when it starts.');
  await page.getByTestId('board-settings-cancel').click();

  // Switching the second drive on is refused while External.
  const refused = await page.request.patch(`/api/devices/${deviceId}/second-drive`, { data: { mode: 'df1' } });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error).toBe('external');

  // Back inside the Amiga: DF0 again, and the second drive setting returns (still Off).
  await openBoardSettings(page, deviceId);
  await page.getByTestId(`fitted-as-${deviceId}-internal`).click();
  await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/devices/${deviceId}/fitted-as`) && r.status() === 200),
    page.getByTestId('board-settings-save').click(),
  ]);
  await expect(page.getByTestId(`device-df1-${deviceId}`)).toBeVisible();
  expect((await row(deviceId)).fittedAs).toBe('internal');
  expect((await page.request.patch(`/api/devices/${deviceId}/second-drive`, { data: { mode: 'df1' } })).status()).toBe(200);
});

test('the route takes only the two values and only the caller\'s board', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  expect((await page.request.patch(`/api/devices/${deviceId}/fitted-as`, { data: { fittedAs: 'sideways' } })).status()).toBe(400);
  expect((await page.request.patch('/api/devices/not-a-board/fitted-as', { data: { fittedAs: 'external' } })).status()).toBe(404);
});
