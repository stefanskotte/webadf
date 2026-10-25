import { test, expect } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { signUpFresh } from './helpers';
import { pairDevice, authHeader, cleanupSeeded, openBoardSettings } from './device-helpers';

test.afterAll(cleanupSeeded);

async function expectFocusNotOnBody(page: import('@playwright/test').Page) {
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName ?? 'NONE')).not.toBe('BODY');
}

async function rowCount(deviceId: string) {
  return (await getDb().select({ id: devices.id }).from(devices).where(eq(devices.id, deviceId))).length;
}

test('Cancel keeps the device; Delete removes the card and the row, and the token stops working', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'Doomed Drive');
  await page.goto('/devices');
  await expect(page.getByTestId(`device-${deviceId}`)).toBeVisible();

  // Cancel leaves everything as it was.
  await openBoardSettings(page, deviceId);
  await page.getByTestId(`device-delete-${deviceId}`).click();
  await expect(page.getByTestId('device-delete-dialog')).toBeVisible();
  // The modal radius (20px, .wf-modal) beats the card's 16px (.glass-card):
  // both sit in the components layer with .wf-modal second (Phase B F3).
  await expect(page.getByTestId('device-delete-dialog')).toHaveCSS('border-top-left-radius', '20px');
  await page.getByTestId('device-delete-cancel').click();
  await expect(page.getByTestId('device-delete-dialog')).toHaveCount(0);
  await expect(page.getByTestId(`board-settings-${deviceId}`)).toBeFocused();   // focus returns to the opener
  expect(await rowCount(deviceId)).toBe(1);

  // Delete.
  await openBoardSettings(page, deviceId);
  await page.getByTestId(`device-delete-${deviceId}`).click();
  await Promise.all([
    page.waitForResponse((r) =>
      r.url().includes(`/api/devices/${deviceId}`) && r.request().method() === 'DELETE' && r.status() === 200),
    page.getByTestId('device-delete-confirm').click(),
  ]);

  await expect(page.getByTestId(`device-${deviceId}`)).toHaveCount(0);
  expect(await rowCount(deviceId)).toBe(0);
  await expectFocusNotOnBody(page);

  // The board's token is dead: this is the 401 that makes it drop back to its setup portal.
  const status = await request.get('/api/device/poll?since=0', { headers: authHeader(token) });
  expect(status.status()).toBe(401);

  // Deleting again is a 404, not a second success.
  const again = await page.request.delete(`/api/devices/${deviceId}`);
  expect(again.status()).toBe(404);
});

// Focus rule after a delete: the next card's Board settings button, else the page heading, else Pair a device.
test('after a delete focus lands on the next card, not on the page body', async ({ page, request }) => {
  await signUpFresh(page);
  const a = await pairDevice(page, request, 'Focus A');
  const b = await pairDevice(page, request, 'Focus B');
  await page.goto('/devices');
  await expect(page.getByTestId(`device-${a.deviceId}`)).toBeVisible();
  await expect(page.getByTestId(`device-${b.deviceId}`)).toBeVisible();
  const ids = await page.locator('article[data-testid^="device-"]').evaluateAll((els) => els.map((e) => e.id.replace('device-', '')));
  const [first, second] = ids;
  await openBoardSettings(page, first);
  await page.getByTestId(`device-delete-${first}`).click();
  await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/devices/${first}`) && r.request().method() === 'DELETE' && r.status() === 200),
    page.getByTestId('device-delete-confirm').click(),
  ]);
  await expect(page.getByTestId(`device-${first}`)).toHaveCount(0);
  await expect(page.getByTestId(`board-settings-${second}`)).toBeFocused();
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
