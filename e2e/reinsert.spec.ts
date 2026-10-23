import { test, expect } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { signUpFresh, runTag } from './helpers';
import { cleanupSeeded, pairDevice, seedDisk, authHeader } from './device-helpers';

// A4 "Re-insert last disk": an empty drive offers the disk the last web eject took out.

test.afterAll(async () => { await cleanupSeeded(); });

const sha = (s: string) => createHash('sha256').update(`reinsert-${s}`).digest('hex');
const deviceRow = async (id: string) => (await getDb().select().from(devices).where(eq(devices.id, id)))[0];

test('after an eject the empty drive offers the disk back, and one click mounts it; deleting the disk drops the offer', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const run = runTag();
  const { gameId, diskId } = await seedDisk(orgId, { title: `Again ${run}`, diskNo: 2, sha256: sha(run) });
  const { deviceId, token } = await pairDevice(page, request, `Bench ${run.slice(0, 6)}`);
  const confirm = async () => {
    const r = await deviceRow(deviceId);
    expect((await request.post('/api/device/status', {
      headers: authHeader(token), data: { mountedSha256: r.desiredSha256, mountedDiskId: r.desiredDiskId, version: r.desiredVersion },
    })).status()).toBe(204);
  };

  // Mounted and confirmed, then ejected and confirmed: the drive is empty.
  expect((await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } })).status()).toBe(200);
  await confirm();
  await page.goto('/devices');
  await expect(page.getByTestId(`reinsert-${deviceId}`)).toHaveCount(0);   // nothing ejected yet
  expect((await page.request.post(`/api/devices/${deviceId}/eject`)).status()).toBe(200);
  await confirm();

  await page.reload();
  const again = page.getByTestId(`reinsert-${deviceId}`);
  await expect(again).toContainText('Re-insert last disk');
  await expect(again).toContainText(`Again ${run}, disk 2`);
  await again.click();
  await expect(page.getByText('Mount requested')).toBeVisible();
  await expect.poll(async () => (await deviceRow(deviceId)).desiredDiskId).toBe(diskId);
  await expect(again).toHaveCount(0);   // no longer empty

  // Ejected again, then the title deleted: no offer of a disk that is gone.
  expect((await page.request.post(`/api/devices/${deviceId}/eject`)).status()).toBe(200);
  await confirm();
  expect((await page.request.delete(`/api/games/${gameId}`)).status()).toBe(200);
  await page.reload();
  await expect(page.getByTestId(`device-${deviceId}`)).toHaveAttribute('data-state', 'empty');
  await expect(page.getByTestId(`reinsert-${deviceId}`)).toHaveCount(0);
});
