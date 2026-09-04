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

test('the trail leads back to the collection you came from', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const { gameId } = await seedDisk(u.orgId, { title: `Filed ${run}`, diskNo: 1, sha256: sha(`b-${run}`) });

  const created = await page.request.post('/api/collections', { data: { name: `Faves ${run}` } });
  const collectionId = (await created.json()).id as string;
  expect((await page.request.post(`/api/collections/${collectionId}/games`, { data: { gameId } })).ok()).toBe(true);

  // Arrive at the title from INSIDE a collection.
  await page.goto(`/library?collection=${collectionId}`);
  await page.getByTestId('game-card').first().click();
  await expect(page).toHaveURL(new RegExp(`/games/${gameId}`));

  // The collection cannot be DERIVED here -- a game is in many collections
  // and collection_games is many-to-many -- so it is carried in the link and
  // resolved against this org's own collections before its name is shown.
  const trail = page.getByTestId('breadcrumb');
  await expect(trail).toContainText(`Faves ${run}`);
  // Library stays first and stays clickable: a collection is a view of the
  // library, not a replacement, and the way out still has to be there.
  await expect(trail.getByRole('link', { name: 'Library' })).toBeVisible();

  await trail.getByRole('link', { name: `Faves ${run}` }).click();
  await expect(page).toHaveURL(new RegExp(`collection=${collectionId}`));

  await page.request.delete(`/api/collections/${collectionId}`);
});

test('the collection survives the step down into a disk', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const tag = randomUUID().slice(0, 8);
  const adf = syntheticVolume({
    filesystem: 'FFS', volumeName: `Vol-${tag}`,
    entries: [{ name: 'README', bytes: new TextEncoder().encode('x') }],
  });
  const content = Buffer.from(adf);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const presign = await page.request.post('/api/ingest/presign', { data: { files: [{ sha256, sizeBytes: content.length }] } });
  const { uploads } = await presign.json();
  await fetch(uploads[0].url, { method: 'PUT', body: new Uint8Array(content) });
  await page.request.post('/api/ingest/complete', { data: { files: [{ sha256, sizeBytes: content.length, filename: `deep-${tag}.adf` }] } });
  const row = (await getDb().select().from(disks).where(eq(disks.sha256, sha256)))[0];
  void u;

  const created = await page.request.post('/api/collections', { data: { name: `Deep ${run}` } });
  const collectionId = (await created.json()).id as string;
  expect((await page.request.post(`/api/collections/${collectionId}/games`, { data: { gameId: row.gameId } })).ok()).toBe(true);

  await page.goto(`/library?collection=${collectionId}`);
  await page.getByTestId('game-card').first().click();
  await page.getByRole('link', { name: 'Browse' }).first().click();
  await expect(page).toHaveURL(/\/files/);

  // Four crumbs now: Library / the collection / the title / which disk. The
  // collection has to survive TWO steps, or the trail forgets it halfway.
  const trail = page.getByTestId('breadcrumb');
  await expect(trail.getByRole('listitem')).toHaveCount(4);
  await expect(trail).toContainText(`Deep ${run}`);

  // Stepping back up to the title keeps it too.
  await trail.getByRole('link').nth(2).click();
  await expect(page).toHaveURL(new RegExp(`/games/${row.gameId}`));
  await expect(page.getByTestId('breadcrumb')).toContainText(`Deep ${run}`);

  await page.request.delete(`/api/collections/${collectionId}`);
});

test('a ?from= naming a collection that is not yours is ignored, not rendered', async ({ browser }) => {
  const run = runTag();
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pa = await a.newPage();
  const pb = await b.newPage();
  const ua = await signUpFresh(pa);
  await signUpFresh(pb);
  const { gameId } = await seedDisk(ua.orgId, { title: `Guarded ${run}`, diskNo: 1, sha256: sha(`c-${run}`) });

  // Org B makes a collection with a distinctive name.
  const theirs = await pb.request.post('/api/collections', { data: { name: `SECRET ${run}` } });
  const theirId = (await theirs.json()).id as string;

  // Org A forges a ?from= naming it. collection_games carries no org_id, so
  // an unchecked id here would print another tenant's collection NAME on the
  // page -- a cross-tenant leak through a breadcrumb.
  await pa.goto(`/games/${gameId}?from=${theirId}`);
  const trail = pa.getByTestId('breadcrumb');
  await expect(trail).toBeVisible();
  await expect(trail).not.toContainText('SECRET');
  // ...and it degrades to the plain library rather than 404ing: a stale link
  // should quietly show the library, not break.
  await expect(trail.getByRole('link', { name: 'Library' })).toBeVisible();

  await pb.request.delete(`/api/collections/${theirId}`);
  await a.close();
  await b.close();
});
