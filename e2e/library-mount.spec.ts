import { test, expect } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getDb } from '@/db';
import { disks } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { stableId } from '@/lib/ingest';
import { signUpFresh, runTag } from './helpers';
import { cleanupSeeded, pairDevice, seedDisk, authHeader } from './device-helpers';

test.afterAll(async () => { await cleanupSeeded(); });

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function deviceRow(id: string) {
  return (await getDb().select().from(devices).where(eq(devices.id, id)))[0];
}

/** The card for `title` in the library grid. */
const card = (page: import('@playwright/test').Page, title: string) =>
  page.locator('[data-testid="game-card"]', { hasText: title });

test('a card mounts its disk, rings dashed until the board confirms, then solid with Eject', async ({ page, request }) => {
  const u = await signUpFresh(page);
  const run = runTag();
  const title = `Ring ${run}`;
  const { gameId, diskId } = await seedDisk(u.orgId, { title, diskNo: 1, sha256: sha(`ring-${run}`) });
  const { deviceId, token } = await pairDevice(page, request, `Bench ${run.slice(0, 6)}`);

  await page.goto('/library');
  const c = card(page, title);
  await expect(c).not.toHaveAttribute('data-drive', /.+/);

  // One disk, one board: one click mounts.
  await c.getByTestId(`card-mount-${gameId}`).click();
  await expect(page.getByText('Mount requested')).toBeVisible();
  const row = await deviceRow(deviceId);
  expect(row.desiredDiskId).toBe(diskId);
  // Asked for, not confirmed: dashed.
  await expect(c).toHaveAttribute('data-drive', 'fetching');

  // The board reports it holds the disk: solid, and the control is Eject.
  expect((await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: row.desiredSha256, mountedDiskId: diskId, version: row.desiredVersion },
  })).status()).toBe(204);
  await page.reload();
  await expect(c).toHaveAttribute('data-drive', 'mounted');
  const eject = c.getByTestId(`card-eject-${gameId}`);
  // The board's own name, read back rather than assumed from the pairing call.
  const { name } = await deviceRow(deviceId);
  await expect(eject).toHaveAttribute('title', `In ${name} · Eject`);
  // The ring is its own element outside the card: solid once confirmed, and
  // the card's own outline (the keyboard focus ring) is left alone.
  expect(await c.getByTestId('drive-ring').evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('solid');
  expect(await c.evaluate((el) => el.style.outline)).toBe('');

  await eject.click();
  await expect(page.getByText('Eject requested')).toBeVisible();
  expect((await deviceRow(deviceId)).desiredDiskId).toBeNull();
  await expect(c).not.toHaveAttribute('data-drive', /.+/);
  await expect(c.getByTestId(`card-mount-${gameId}`)).toBeVisible();
});

test('a disk set asks which disk, and the ring names it', async ({ page, request }) => {
  const u = await signUpFresh(page);
  const run = runTag();
  const title = `Set ${run}`;
  const { gameId } = await seedDisk(u.orgId, { title, diskNo: 1, sha256: sha(`set1-${run}`) });
  // Disk 2 of the same title, shaped as seedDisk shapes disk 1.
  const sha2 = sha(`set2-${run}`);
  const disk2 = stableId('disk', gameId, sha2);
  await seedDisk(u.orgId, { title: `Donor ${run}`, diskNo: 1, sha256: sha2 }); // blob + entitlement for sha2
  await getDb().insert(disks).values({
    id: disk2, gameId, orgId: u.orgId, diskNo: 2, sha256: sha2, label: `${title} (Disk 2)`, sizeBytes: 901120,
  });
  const { deviceId } = await pairDevice(page, request, `Bench ${run.slice(0, 6)}`);

  try {
    await page.goto('/library');
    const c = card(page, title);
    await c.getByTestId(`card-mount-${gameId}`).click();
    const dialog = page.getByTestId('card-mount-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('card-mount-confirm')).toBeDisabled();
    await dialog.getByTestId(`card-mount-disk-${disk2}`).click();
    await page.getByTestId('card-mount-confirm').click();
    await expect(page.getByText('Mount requested')).toBeVisible();
    expect((await deviceRow(deviceId)).desiredDiskId).toBe(disk2);
    await expect(c).toHaveAttribute('data-drive', 'fetching');
    // Never reported, so offline: asked for, not confirmed -- the same words
    // the title page uses (mount-choice.ts), never "In".
    const { name } = await deviceRow(deviceId);
    await expect(c.getByTestId(`card-eject-${gameId}`))
      .toHaveAttribute('title', `Requested on ${name} — disk 2 — not confirmed · Cancel`);
  } finally {
    await getDb().update(devices).set({ desiredDiskId: null, desiredSha256: null }).where(eq(devices.id, deviceId));
    await getDb().delete(disks).where(eq(disks.id, disk2));
  }
});

test('Cancel on a swap keeps the disk the board holds, rather than emptying the drive', async ({ page, request }) => {
  const u = await signUpFresh(page);
  const run = runTag();
  const held = await seedDisk(u.orgId, { title: `Held ${run}`, diskNo: 1, sha256: sha(`held-${run}`) });
  const next = await seedDisk(u.orgId, { title: `Next ${run}`, diskNo: 1, sha256: sha(`next-${run}`) });
  const { deviceId, token } = await pairDevice(page, request, `Bench ${run.slice(0, 6)}`);

  // The board confirms `held`, then is asked for `next`.
  expect((await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId: held.diskId } })).status()).toBe(200);
  const r = await deviceRow(deviceId);
  expect((await request.post('/api/device/status', {
    headers: authHeader(token), data: { mountedSha256: r.desiredSha256, mountedDiskId: held.diskId, version: r.desiredVersion },
  })).status()).toBe(204);
  expect((await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId: next.diskId } })).status()).toBe(200);

  await page.goto('/library');
  const nextCard = card(page, `Next ${run}`);
  await expect(nextCard).toHaveAttribute('data-drive', 'fetching');
  await nextCard.getByTestId(`card-eject-${next.gameId}`).click();
  await expect(page.getByText('Mount cancelled')).toBeVisible();

  // The drive is asked for `held` again -- not emptied -- so the board is
  // back in step with what it holds, and that card rings solid.
  const after = await deviceRow(deviceId);
  expect(after.desiredDiskId).toBe(held.diskId);
  expect(after.mountedDiskId).toBe(held.diskId);
  await expect(card(page, `Held ${run}`)).toHaveAttribute('data-drive', 'mounted');
  await expect(nextCard).not.toHaveAttribute('data-drive', /.+/);
});

