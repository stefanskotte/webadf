import { test, expect } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { signUpFresh } from './helpers';
import { pairDevice, authHeader, cleanupSeeded } from './device-helpers';

test.afterAll(cleanupSeeded);

async function rowCount(deviceId: string) {
  return (await getDb().select({ id: devices.id }).from(devices).where(eq(devices.id, deviceId))).length;
}

test('Cancel keeps the device; Delete removes the card and the row, and the token stops working', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'Doomed Drive');
  await page.goto('/devices');
  await expect(page.getByTestId(`device-${deviceId}`)).toBeVisible();

  // Cancel leaves everything as it was.
  await page.getByTestId(`device-delete-${deviceId}`).click();
  await expect(page.getByTestId('device-delete-dialog')).toBeVisible();
  await page.getByTestId('device-delete-cancel').click();
  await expect(page.getByTestId('device-delete-dialog')).toHaveCount(0);
  expect(await rowCount(deviceId)).toBe(1);

  // Delete.
  await page.getByTestId(`device-delete-${deviceId}`).click();
  await Promise.all([
    page.waitForResponse((r) =>
      r.url().includes(`/api/devices/${deviceId}`) && r.request().method() === 'DELETE' && r.status() === 200),
    page.getByTestId('device-delete-confirm').click(),
  ]);

  await expect(page.getByTestId(`device-${deviceId}`)).toHaveCount(0);
  expect(await rowCount(deviceId)).toBe(0);

  // The board's token is dead: this is the 401 that makes it drop back to its setup portal.
  const status = await request.get('/api/device/poll?since=0', { headers: authHeader(token) });
  expect(status.status()).toBe(401);

  // Deleting again is a 404, not a second success.
  const again = await page.request.delete(`/api/devices/${deviceId}`);
  expect(again.status()).toBe(404);
});

test('another org cannot delete the device (404, row intact)', async ({ page, request, browser }) => {
  await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);

  const otherCtx = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const other = await otherCtx.newPage();
  await signUpFresh(other);
  const res = await other.request.delete(`/api/devices/${deviceId}`);
  expect(res.status()).toBe(404);
  expect(await rowCount(deviceId)).toBe(1);
  await otherCtx.close();
});
