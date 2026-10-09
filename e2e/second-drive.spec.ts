import { test, expect, type APIRequestContext } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { signUpFresh } from './helpers';
import { pairDevice, authHeader, cleanupSeeded } from './device-helpers';

test.afterAll(cleanupSeeded);

async function report(request: APIRequestContext, token: string, extra: Record<string, unknown>) {
  const res = await request.post('/api/device/status', {
    headers: authHeader(token), data: { mountedSha256: null, firmwareVersion: '1.9.0', ...extra },
  });
  expect(res.status()).toBe(204);
}
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
  await page.reload();
  await expect(page.getByTestId(`second-drive-status-${deviceId}`))
    .toHaveText('Set on the board — takes effect when the Amiga restarts');
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
