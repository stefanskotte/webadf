import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { signUpFresh, runTag } from './helpers';
import { pairDevice, seedDisk, cleanupSeeded } from './device-helpers';

test.afterAll(cleanupSeeded);

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function deviceRow(deviceId: string) {
  const r = await getDb().select().from(devices).where(eq(devices.id, deviceId));
  return r[0];
}

test('a freshly paired device wears its MAC, and can be given a name', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  const mac = (await deviceRow(deviceId)).macAddress;

  await page.goto('/devices');

  // The starting state, asserted rather than assumed: this is the thing the
  // feature exists to fix, so if it ever stops being true the test should say
  // so rather than quietly testing nothing.
  await expect(page.getByTestId(`device-name-${deviceId}`)).toHaveText(`Device ${mac}`);
  // The invitation reads "Name" while it is still a MAC.
  await expect(page.getByTestId(`alias-edit-${deviceId}`)).toHaveText('Name');

  await page.getByTestId(`alias-edit-${deviceId}`).click();
  // The editor opens EMPTY on a default name -- nobody wants to delete a MAC
  // before typing.
  await expect(page.getByTestId(`alias-input-${deviceId}`)).toHaveValue('');

  await page.getByTestId(`alias-input-${deviceId}`).fill('Bench drive');
  await Promise.all([
    page.waitForResponse((r) =>
      r.url().includes(`/api/devices/${deviceId}`) && r.request().method() === 'PATCH'),
    page.getByTestId(`alias-save-${deviceId}`).click(),
  ]);

  await expect(page.getByTestId(`device-name-${deviceId}`)).toHaveText('Bench drive');
  expect((await deviceRow(deviceId)).name).toBe('Bench drive');
  // Renaming must not touch the identity: the MAC is a separate column and is
  // still on the card, which is what keeps a renamed drive identifiable.
  expect((await deviceRow(deviceId)).macAddress).toBe(mac);
  await expect(page.getByTestId(`device-${deviceId}`)).toContainText(mac!);
  await expect(page.getByTestId(`alias-edit-${deviceId}`)).toHaveText('Rename');
});

test('clearing the alias restores the MAC label rather than leaving it blank', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  const mac = (await deviceRow(deviceId)).macAddress;

  await page.goto('/devices');
  await page.getByTestId(`alias-edit-${deviceId}`).click();
  await page.getByTestId(`alias-input-${deviceId}`).fill('Temporary');
  await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/devices/${deviceId}`)),
    page.getByTestId(`alias-save-${deviceId}`).click(),
  ]);
  await expect(page.getByTestId(`device-name-${deviceId}`)).toHaveText('Temporary');

  // Now empty it. devices.name is NOT NULL, so "" cannot simply be stored --
  // and a drive with no label at all is harder to pick out of a list than one
  // wearing its MAC.
  await page.getByTestId(`alias-edit-${deviceId}`).click();
  await page.getByTestId(`alias-input-${deviceId}`).fill('   ');
  await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/devices/${deviceId}`)),
    page.getByTestId(`alias-save-${deviceId}`).click(),
  ]);

  await expect(page.getByTestId(`device-name-${deviceId}`)).toHaveText(`Device ${mac}`);
  expect((await deviceRow(deviceId)).name).toBe(`Device ${mac}`);
});

test('Escape abandons an edit without saving it', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  const before = (await deviceRow(deviceId)).name;

  await page.goto('/devices');
  await page.getByTestId(`alias-edit-${deviceId}`).click();
  await page.getByTestId(`alias-input-${deviceId}`).fill('Never committed');
  await page.keyboard.press('Escape');

  await expect(page.getByTestId(`alias-input-${deviceId}`)).toHaveCount(0);
  await expect(page.getByTestId(`device-name-${deviceId}`)).toHaveText(before);
  expect((await deviceRow(deviceId)).name).toBe(before);
});

test('the alias is what the library mount picker shows — the reason this exists', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId: aId } = await pairDevice(page, request);
  const { deviceId: bId } = await pairDevice(page, request);
  const tag = runTag();
  const { gameId, diskId } = await seedDisk(orgId, {
    title: `AliasPicker-${tag}`, diskNo: 1, sha256: sha(tag),
  });

  // Two devices, so the picker is a list rather than a single button -- which
  // is exactly the case where same-shaped MACs are unusable.
  await page.goto('/devices');
  for (const [id, alias] of [[aId, 'Workshop'], [bId, 'Living room']] as const) {
    await page.getByTestId(`alias-edit-${id}`).click();
    await page.getByTestId(`alias-input-${id}`).fill(alias);
    await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/devices/${id}`)),
      page.getByTestId(`alias-save-${id}`).click(),
    ]);
    await expect(page.getByTestId(`device-name-${id}`)).toHaveText(alias);
  }

  await page.goto(`/games/${gameId}`);
  await page.getByTestId(`mount-${diskId}`).click();
  const menu = page.getByTestId(`mount-${diskId}-menu`);
  await expect(menu).toContainText('Workshop');
  await expect(menu).toContainText('Living room');
  // And the MAC is gone from the choosing surface, which was the complaint.
  await expect(menu).not.toContainText('Device ');
});

test('a device in another org cannot be renamed, and says nothing about existing', async ({ page, request }) => {
  // Pair under org A, then sign in as a fresh org B and aim at A's device.
  await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  const before = (await deviceRow(deviceId)).name;

  await signUpFresh(page);
  const res = await page.request.patch(`/api/devices/${deviceId}`, { data: { alias: 'Stolen' } });

  // 404, not 403: a caller must not learn that the id exists. Same boundary as
  // /api/device/image.
  expect(res.status()).toBe(404);
  expect((await deviceRow(deviceId)).name).toBe(before);
});

test('an over-long alias is refused rather than truncated silently', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  const before = (await deviceRow(deviceId)).name;

  const res = await page.request.patch(`/api/devices/${deviceId}`, {
    data: { alias: 'x'.repeat(81) },
  });
  expect(res.status()).toBe(400);
  expect((await deviceRow(deviceId)).name).toBe(before);
});
