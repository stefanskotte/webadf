import { test, expect, type Page } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { collectionGames } from '@/db/schema/collections';
import { signUpFresh, runTag, openTitleMenu } from './helpers';
import { cleanupSeeded, pairDevice, seedDisk, authHeader } from './device-helpers';

// A3 Library (roadmap 2026-10-23): Move to collection…, Undo in the mount toast, and a header search that shows a
// title's collection and finds help topics.

test.afterAll(async () => { await cleanupSeeded(); });

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const card = (page: Page, title: string) => page.locator('[data-testid="game-card"]', { hasText: title });
const deviceRow = async (id: string) => (await getDb().select().from(devices).where(eq(devices.id, id)))[0];
const collectionsOf = async (gameId: string) =>
  (await getDb().select({ id: collectionGames.collectionId }).from(collectionGames).where(eq(collectionGames.gameId, gameId)))
    .map((r) => r.id).sort();

async function newCollection(page: Page, name: string) {
  const res = await page.request.post('/api/collections', { data: { name } });
  expect(res.status()).toBe(200);
  return (await res.json()).id as string;
}

test('Move to collection… from Uncategorized files the title, and inside a collection it moves it', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const run = runTag();
  const title = `Mover ${run}`;
  const { gameId } = await seedDisk(orgId, { title, diskNo: 1, sha256: sha(`mover-${run}`) });
  const games = await newCollection(page, `Games ${run}`);
  const demos = await newCollection(page, `Demos ${run}`);

  await page.goto('/library');   // Uncategorized
  await openTitleMenu(page, gameId);
  await page.getByTestId(`move-to-collection-${gameId}`).click();
  const picker = page.getByTestId('move-dialog');
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: `Games ${run}` }).click();
  await expect(page.getByText(`Moved to Games ${run}`)).toBeVisible();
  await expect(card(page, title)).toHaveCount(0);   // no longer uncategorized
  expect(await collectionsOf(gameId)).toEqual([games]);

  await page.goto(`/library?collection=${games}`);
  await openTitleMenu(page, gameId);
  await page.getByTestId(`move-to-collection-${gameId}`).click();
  // The collection you are standing in is not offered.
  await expect(page.getByTestId('move-dialog').getByRole('button', { name: `Games ${run}` })).toHaveCount(0);
  await page.getByTestId('move-dialog').getByRole('button', { name: `Demos ${run}` }).click();
  await expect(page.getByText(`Moved to Demos ${run}`)).toBeVisible();
  await expect(card(page, title)).toHaveCount(0);
  expect(await collectionsOf(gameId)).toEqual([demos]);
});

test('Undo in the mount toast puts back the disk the drive held, or empties it', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const run = runTag();
  const held = await seedDisk(orgId, { title: `Held ${run}`, diskNo: 1, sha256: sha(`uheld-${run}`) });
  const next = await seedDisk(orgId, { title: `Next ${run}`, diskNo: 1, sha256: sha(`unext-${run}`) });
  const { deviceId, token } = await pairDevice(page, request, `Bench ${run.slice(0, 6)}`);

  // An empty drive: Undo empties it again.
  await page.goto('/library');
  await openTitleMenu(page, held.gameId);
  await page.getByTestId(`card-mount-${held.gameId}`).click();
  await expect(page.getByText('Mount requested')).toBeVisible();
  expect((await deviceRow(deviceId)).desiredDiskId).toBe(held.diskId);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await deviceRow(deviceId)).desiredDiskId).toBeNull();

  // The board confirms `held`; a mount of `next` undone asks for `held` again.
  expect((await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId: held.diskId } })).status()).toBe(200);
  const r = await deviceRow(deviceId);
  expect((await request.post('/api/device/status', {
    headers: authHeader(token), data: { mountedSha256: r.desiredSha256, mountedDiskId: held.diskId, version: r.desiredVersion },
  })).status()).toBe(204);
  await page.reload();
  await openTitleMenu(page, next.gameId);
  await page.getByTestId(`card-mount-${next.gameId}`).click();
  await expect.poll(async () => (await deviceRow(deviceId)).desiredDiskId).toBe(next.diskId);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await deviceRow(deviceId)).desiredDiskId).toBe(held.diskId);
});

test('the ⋯ menu and its items neither navigate nor start a drag, and its dialog hands focus back to ⋯', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const run = runTag();
  const title = `Menu ${run}`;
  const { gameId } = await seedDisk(orgId, { title, diskNo: 1, sha256: sha(`menu-${run}`) });
  await newCollection(page, `Shelf ${run}`);

  await page.goto('/library');
  const c = card(page, title);
  // dragStyle (title-controls.tsx) drops a dragged card to 0.4.
  const opacity = () => c.evaluate((el) => getComputedStyle(el).opacity);
  const box = await c.boundingBox();

  // Opening it: the trigger sits inside the card's <a href>.
  await openTitleMenu(page, gameId);
  await expect(page).toHaveURL(/\/library$/);
  expect(await opacity()).toBe('1');

  // A press on an item that moves like a drag: the portalled popup's events bubble through React to the card's
  // dnd-kit listeners unless they are stopped.
  const item = page.getByTestId(`move-to-collection-${gameId}`);
  const b = (await item.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 - 60, b.y + b.height / 2 + 40, { steps: 8 });
  expect(await opacity()).toBe('1');
  await page.mouse.up();
  await expect(page).toHaveURL(/\/library$/);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('title-menu-panel')).toHaveCount(0);

  // Picking it: the dialog opens and outlives the popup; nothing navigates, nothing drags, the card did not move.
  await openTitleMenu(page, gameId);
  await item.click();
  await expect(page.getByTestId('title-menu-panel')).toHaveCount(0);
  const dialog = page.getByTestId('move-dialog');
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/library$/);
  expect(await opacity()).toBe('1');
  expect(await c.boundingBox()).toEqual(box);

  // Closing it puts focus back on the ⋯ trigger.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId(`title-menu-${gameId}`)).toBeFocused();
  await expect(page).toHaveURL(/\/library$/);
});

test("search shows each title's collection, or Uncategorized", async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const run = runTag();
  const filed = await seedDisk(orgId, { title: `Findme Filed ${run}`, diskNo: 1, sha256: sha(`sf-${run}`) });
  await seedDisk(orgId, { title: `Findme Loose ${run}`, diskNo: 1, sha256: sha(`sl-${run}`) });
  const col = await newCollection(page, `Shelf ${run}`);
  expect((await page.request.post(`/api/collections/${col}/games`, { data: { gameId: filed.gameId } })).status()).toBe(200);

  await page.goto('/library');
  await page.getByTestId('search-input').fill(`Findme`);
  const panel = page.getByTestId('search-panel');
  const result = (text: string) => panel.getByTestId('search-result').filter({ hasText: text });
  await expect(result(`Findme Filed ${run}`)).toContainText(`in Shelf ${run}`);
  await expect(result(`Findme Loose ${run}`)).toContainText('Uncategorized');
});

test('search finds help topics and opens the one picked', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/library');
  await page.getByTestId('search-input').fill('preload');
  const hit = page.getByTestId('search-panel').locator('[data-result-kind="help"]', { hasText: 'Next disk and preloading' });
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(page).toHaveURL(/\/help#next-disk/);
});
