import { test, expect, type APIRequestContext } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { signUpFresh } from './helpers';
import { pairDevice, authHeader, cleanupSeeded, openBoardSettings } from './device-helpers';

/**
 * Original drive (rev C, 2026-11-19, src/lib/orig-drive.ts): Auto | Off in Board settings, shown only for a board whose
 * status carries origDrive (the expander). The board takes it through its poll (?origAck= / origDrive) and uses it at
 * its next power-on only. A status that starts using the original drive makes the board DF1 + DF2 and locks Drive
 * numbers; one that stops puts it back to DF0 + DF1.
 */
test.afterAll(cleanupSeeded);

const FW = '1.26.0+ge2e';
async function report(request: APIRequestContext, token: string, extra: Record<string, unknown>) {
  const res = await request.post('/api/device/status', {
    headers: authHeader(token), data: { mountedSha256: null, firmwareVersion: FW, ...extra },
  });
  expect(res.status()).toBe(204);
}
const orig = (mode: 'auto' | 'off', version: number, present: boolean, active: boolean) =>
  ({ origDrive: { mode, version, present, active } });
const row = async (id: string) => (await getDb().select().from(devices).where(eq(devices.id, id)))[0];
/** LiveRefresh polls every 3 s while the tab is in use; allow a few ticks plus the RSC refresh. */
const LIVE = 15_000;

test('a board without the expander shows no Original drive, and the route refuses it', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'No Expander');
  await report(request, token, {});
  await page.goto('/devices');
  await openBoardSettings(page, deviceId);
  await expect(page.getByTestId(`drive-base-${deviceId}`)).toBeVisible();
  await expect(page.getByTestId(`orig-drive-${deviceId}`)).toHaveCount(0);
  const refused = await page.request.patch(`/api/devices/${deviceId}/orig-drive`, { data: { mode: 'off' } });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error).toBe('not_capable');
});

test('Auto with a drive found makes it DF0 and locks Drive numbers; Off reaches the board and frees them at power-off', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'Rev C');
  // Power-on with a drive on EXT DRV and the default Auto: the board is DF1 + DF2 from this report.
  await report(request, token, orig('auto', 0, true, true));
  expect((await row(deviceId)).driveBase).toBe(1);

  await page.goto('/devices');
  await openBoardSettings(page, deviceId);
  await expect(page.getByTestId(`orig-drive-${deviceId}`)).toHaveAttribute('data-value', 'auto');
  await expect(page.getByTestId(`orig-drive-status-${deviceId}`)).toHaveText('In use as DF0');
  await expect(page.getByTestId(`orig-drive-applies-${deviceId}`)).toHaveText('Applies the next time the Amiga is switched on.');
  await expect(page.getByTestId(`drive-base-${deviceId}`)).toHaveAttribute('data-value', '1');
  for (const b of [0, 1, 2, 3]) await expect(page.getByTestId(`drive-base-${deviceId}-${b}`)).toBeDisabled();
  await expect(page.getByTestId(`drive-base-locked-${deviceId}`)).toHaveText('The original drive is DF0, so the board is DF1 + DF2.');
  // The route refuses too, with the reason.
  const refused = await page.request.patch(`/api/devices/${deviceId}/drive-base`, { data: { base: 0 } });
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toEqual({ error: 'orig_drive_active', reason: 'The original drive is DF0, so the board is DF1 + DF2' });

  // Off: saved, pending until the board acks; the board hears it through its poll.
  await page.getByTestId(`orig-drive-${deviceId}-off`).click();
  await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/devices/${deviceId}/orig-drive`) && r.request().method() === 'PATCH' && r.status() === 200),
    page.getByTestId('board-settings-save').click(),
  ]);
  await expect(page.getByTestId('board-settings-dialog')).toHaveCount(0);
  expect([(await row(deviceId)).origDrive, (await row(deviceId)).origDriveVersion]).toEqual(['off', 1]);
  const poll = await request.get('/api/device/poll?since=0&origAck=0', { headers: authHeader(token) });
  expect(poll.status()).toBe(200);
  expect((await poll.json()).origDrive).toEqual({ seq: 1, mode: 'off' });

  // The board stored it but is still running this power-on: still in use, still DF1 + DF2 (never live).
  await openBoardSettings(page, deviceId);
  await expect(page.getByTestId(`orig-drive-pending-${deviceId}`)).toBeVisible();
  await page.getByTestId('board-settings-cancel').click();
  await report(request, token, orig('off', 1, true, true));
  expect((await row(deviceId)).driveBase).toBe(1);

  // Next power-on: Off, so not in use -> DF0 + DF1, and Drive numbers are the user's again (no reload).
  await report(request, token, orig('off', 1, true, false));
  expect((await row(deviceId)).driveBase).toBe(0);
  await openBoardSettings(page, deviceId);
  await expect(page.getByTestId(`orig-drive-status-${deviceId}`)).toHaveText('Off', { timeout: LIVE });
  await expect(page.getByTestId(`orig-drive-pending-${deviceId}`)).toHaveCount(0);
  await expect(page.getByTestId(`drive-base-${deviceId}-2`)).toBeEnabled();
  await page.getByTestId('board-settings-cancel').click();
  expect((await page.request.patch(`/api/devices/${deviceId}/drive-base`, { data: { base: 2 } })).status()).toBe(200);

  // A further report with nothing changed leaves the user's numbers alone (transitions only).
  await report(request, token, orig('off', 1, true, false));
  expect((await row(deviceId)).driveBase).toBe(2);
});

test('Auto with no drive found says so and leaves Drive numbers free', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'Rev C Empty');
  await report(request, token, orig('auto', 0, false, false));
  await page.goto('/devices');
  await openBoardSettings(page, deviceId);
  await expect(page.getByTestId(`orig-drive-status-${deviceId}`)).toHaveText('No drive found at power-on');
  await expect(page.getByTestId(`drive-base-${deviceId}-1`)).toBeEnabled();
  await expect(page.getByTestId(`drive-base-locked-${deviceId}`)).toHaveCount(0);
});

test('the route takes only auto or off, and only the caller\'s board', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  expect((await page.request.patch(`/api/devices/${deviceId}/orig-drive`, { data: { mode: 'on' } })).status()).toBe(400);
  expect((await page.request.patch('/api/devices/not-a-board/orig-drive', { data: { mode: 'auto' } })).status()).toBe(404);
});
