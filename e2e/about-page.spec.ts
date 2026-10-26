import { test, expect } from '@playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks } from '@/db/schema/catalog';
import { diskVersions } from '@/db/schema/disk-history';
import { libraryUsage } from '@/lib/about/library-usage';
import { signUpFresh, createAdf } from './helpers';
import { hydrated } from './device-helpers';

test('Settings > About this server: the list jumps to #about, focuses its heading, and shows the six groups', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signUpFresh(page);
  await page.goto('/settings');
  // The nav and the radios hydrate in the same pass (c5-layout's Settings test).
  await hydrated(page, 'pref-start-page', 'onKeyDown');
  await page.getByTestId('settings-nav').getByRole('link', { name: 'About this server' }).click();
  await expect(page).toHaveURL(/\/settings#about$/);
  await expect(page.locator('#about-heading')).toBeFocused();
  for (const id of ['web-app', 'hosting', 'platform', 'firmware', 'library', 'about-webadf']) {
    await expect(page.getByTestId(`about-${id}`)).toBeVisible();
  }
  await expect(page.getByTestId('about-about-webadf')).toContainText('WebFloppy');
  await expect(page.getByTestId('about-commit')).toHaveText(/\S/);
  await expect(page.getByTestId('about-hosting-mode')).toHaveText(/^(Hosted \(webadf\.vercel\.app\)|Self-hosted)$/);
  await expect(page.getByTestId('about-firmware')).toContainText('No boards paired');
  await expect(page.getByTestId('about-library-disks')).toHaveText('0');
  await expect(page.getByTestId('about-library-bytes')).toHaveText('0 B');
  const text = await page.locator('body').innerText();
  for (const secret of ['postgres://', 'postgresql://', 'vercel_blob_rw_', 'BETTER_AUTH', 'DATABASE_URL']) {
    expect(text).not.toContain(secret);
  }
});

test('/about is a 307 to /settings#about: signed in it lands on the section at 1280 and 390, signed out on sign-in (Review Focus 1)', async ({ page, browser }) => {
  await signUpFresh(page);
  const res = await page.request.get('/about', { maxRedirects: 0 });
  expect(res.status()).toBe(307);
  expect(res.headers()['location']).toMatch(/\/settings#about$/);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/about');
    await expect(page).toHaveURL(/\/settings#about$/);
    // Below lg the section list is hidden but mounted: its arrival jump still lands here.
    await expect(page.locator('#about-heading')).toBeInViewport();
  }
  const other = await browser.newContext();
  const anon = await other.newPage();
  await anon.goto('/about');
  await expect(anon).toHaveURL(/\/sign-in/);
  await other.close();
});

test('stored bytes are a sum over distinct disk images, not 0 or NaN', async ({ page }) => {
  await signUpFresh(page);
  await createAdf(page, 'FFS');
  await expect(page.getByTestId('game-card')).toHaveCount(1);
  await createAdf(page, 'FFS');
  await expect(page.getByTestId('game-card')).toHaveCount(2);
  await page.goto('/about');
  await expect(page).toHaveURL(/\/settings#about$/);   // the redirect (C7 spec §10.3)
  await expect(page.getByTestId('about-library-disks')).toHaveText('2');
  await expect(page.getByTestId('about-library-titles')).toHaveText('2');
  // Two blank 880 KB images: identical bytes count once, different bytes twice.
  const exact = Number(await page.getByTestId('about-library-bytes').getAttribute('data-bytes'));
  expect(exact).toBeGreaterThanOrEqual(901_120);
  expect(exact).toBeLessThanOrEqual(2 * 901_120);
});

test('stored bytes count each distinct image once, including the full image a history version keeps', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  await createAdf(page, 'FFS', 'dd');
  await expect(page.getByTestId('game-card')).toHaveCount(1);
  await createAdf(page, 'FFS', 'hd');
  await expect(page.getByTestId('game-card')).toHaveCount(2);
  const db = getDb();
  const rows = await db.select().from(disks).where(eq(disks.orgId, orgId));
  const dd = rows.find((r) => r.sizeBytes === 901_120)!;
  const hd = rows.find((r) => r.sizeBytes === 1_802_240)!;

  // A saved version whose FULL image is named only by image_sha256 (its own
  // blob is a delta, which has no blobs row) -- as recordVersion writes an
  // Amiga save. Then the HD disk goes, so that image is reachable ONLY
  // through history: the weekly blob GC keeps it, and so must the count.
  await db.insert(diskVersions).values({
    id: randomUUID(), diskId: dd.id, orgId, seq: 999, kind: 'delta',
    blobSha256: randomBytes(32).toString('hex'), imageSha256: hd.sha256,
    source: 'amiga', sectorCount: 1,
  });
  await db.delete(disks).where(eq(disks.id, hd.id));
  expect((await libraryUsage(orgId)).bytes).toBe(901_120 + 1_802_240);

  // A second disk holding the very same image adds a disk, not bytes.
  await db.insert(disks).values({
    id: randomUUID(), gameId: dd.gameId, orgId, diskNo: 2, sha256: dd.sha256, sizeBytes: dd.sizeBytes,
  });
  const usage = await libraryUsage(orgId);
  expect(usage.disks).toBe(2);
  expect(usage.bytes).toBe(901_120 + 1_802_240);
});
