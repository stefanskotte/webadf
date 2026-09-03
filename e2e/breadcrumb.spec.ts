import { test, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks } from '@/db/schema/catalog';
import { syntheticVolume } from '@/lib/adffs/synthetic';
import { signUpFresh, runTag } from './helpers';
import { cleanupSeeded, seedDisk } from './device-helpers';

test.afterAll(cleanupSeeded);

const sha = (s: string) => createHash('sha256').update(`crumb-${s}`).digest('hex');

test('a title trails back to the library, and the crumb navigates', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const { gameId } = await seedDisk(u.orgId, { title: `Crumbed ${run}`, diskNo: 1, sha256: sha(`a-${run}`) });

  await page.goto(`/games/${gameId}`);
  const trail = page.getByTestId('breadcrumb');
  await expect(trail).toBeVisible();

  // Ancestors only: the title is the <h1>, and repeating it in the trail
  // directly above reads as a rendering bug.
  await expect(trail.getByRole('listitem')).toHaveCount(1);
  await expect(trail).not.toContainText(`Crumbed ${run}`);

  // It is navigation, not decoration -- which the old plain-text eyebrow
  // ("Library / Games") never was.
  await trail.getByRole('link', { name: 'Library' }).click();
  await expect(page).toHaveURL(/\/library/);
});

test('a disk trails Library / its title / which disk, and each crumb goes where it says', async ({ page }) => {
  const u = await signUpFresh(page);
  const tag = randomUUID().slice(0, 8);
  const adf = syntheticVolume({
    filesystem: 'FFS',
    volumeName: `Vol-${tag}`,
    entries: [{ name: 'README', bytes: new TextEncoder().encode('x') }],
  });
  const content = Buffer.from(adf);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const presign = await page.request.post('/api/ingest/presign', { data: { files: [{ sha256, sizeBytes: content.length }] } });
  const { uploads } = await presign.json();
  await fetch(uploads[0].url, { method: 'PUT', body: new Uint8Array(content) });
  await page.request.post('/api/ingest/complete', { data: { files: [{ sha256, sizeBytes: content.length, filename: `crumb-${tag}.adf` }] } });
  const row = (await getDb().select().from(disks).where(eq(disks.sha256, sha256)))[0];
  void u;

  await page.goto(`/disks/${row.id}/files`);
  const trail = page.getByTestId('breadcrumb');
  await expect(trail.getByRole('listitem')).toHaveCount(3);

  // "Disk 1" is the current location and therefore NOT a link -- and it is
  // not a duplicate of the heading either, which shows the volume's name.
  const current = trail.getByText('Disk 1', { exact: true });
  await expect(current).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('h1')).toContainText(`Vol-${tag}`);

  // The middle crumb goes to the entry's own page, and is named for the
  // entry rather than typed as "Game" -- which is wrong on a Workbench disk.
  await trail.getByRole('link').nth(1).click();
  await expect(page).toHaveURL(new RegExp(`/games/${row.gameId}$`));
});

test('the trail does not invent a collection it cannot know', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const { gameId } = await seedDisk(u.orgId, { title: `Filed ${run}`, diskNo: 1, sha256: sha(`b-${run}`) });

  const created = await page.request.post('/api/collections', { data: { name: `Faves ${run}` } });
  const collectionId = (await created.json()).id as string;
  expect((await page.request.post(`/api/collections/${collectionId}/games`, { data: { gameId } })).ok()).toBe(true);

  // Arrive at the title from INSIDE a collection.
  await page.goto(`/library?collection=${collectionId}`);
  await page.getByTestId('game-card').first().click();
  await expect(page).toHaveURL(new RegExp(`/games/${gameId}$`));

  // The root is hardcoded "Library" (operator's ruling): a game can be in many
  // collections and collection_games is many-to-many, so the trail cannot be
  // derived from a game id. It must not guess at one -- it says Library, and
  // Library is where it goes.
  const trail = page.getByTestId('breadcrumb');
  await expect(trail).not.toContainText(`Faves ${run}`);
  await trail.getByRole('link', { name: 'Library' }).click();
  await expect(page).toHaveURL(/\/library$/);

  await page.request.delete(`/api/collections/${collectionId}`);
});
