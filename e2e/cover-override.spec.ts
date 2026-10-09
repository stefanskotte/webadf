import { test, expect } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { getDb } from '@/db';
import { games } from '@/db/schema/catalog';
import { signUpFresh } from './helpers';
import { cleanupSeeded, seedDisk } from './device-helpers';

// A title's own cover (HANDOFF backlog "Override a title's main image").
// The image is a real 40x50 PNG made by ImageMagick (the unit tests' fixture).
// Its stored object, cover/<sha256>, is shared by every run (same bytes) and is
// left for the weekly blob GC once no title names it.

test.afterAll(async () => { await cleanupSeeded(); });

const PNG = join(process.cwd(), 'src/lib/__fixtures__/cover/cover.png');
const freshSha = () => randomUUID().replace(/-/g, '').padEnd(64, '0');
const overrideOf = async (id: string) =>
  (await getDb().select({ s: games.coverOverrideSha256 }).from(games).where(eq(games.id, id)))[0]?.s ?? null;

test('upload a cover on an un-enriched title, see it on the page and the card, then revert', async ({ page }) => {
  const u = await signUpFresh(page);
  const { gameId } = await seedDisk(u.orgId, { title: 'Cover Utility', diskNo: 1, sha256: freshSha() });

  await page.goto(`/games/${gameId}`);
  // Un-enriched: no cover yet, nothing to revert.
  await expect(page.getByTestId('game-cover')).toHaveCount(0);
  await expect(page.getByTestId('cover-revert')).toHaveCount(0);
  await expect(page.getByTestId('cover-change')).toBeVisible();

  await page.getByTestId('cover-file').setInputFiles(PNG);

  const cover = page.getByTestId('game-cover');
  await expect(cover).toBeVisible();
  await expect(cover).toHaveAttribute('src', new RegExp(`^/api/games/${gameId}/cover/[0-9a-f]{64}$`));
  // The bytes really arrive (not a broken image): naturalWidth is the PNG's 40.
  await expect.poll(() => cover.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(40);
  const sha = await overrideOf(gameId);
  expect(sha).toMatch(/^[0-9a-f]{64}$/);

  // The library card shows the same image.
  await page.goto('/library');
  await expect(page.locator(`img[data-testid="cover-image"][src="/api/games/${gameId}/cover/${sha}"]`)).toBeVisible();

  // Revert.
  await page.goto(`/games/${gameId}`);
  await page.getByTestId('cover-revert').click();
  await expect(page.getByTestId('game-cover')).toHaveCount(0);
  await expect(page.getByTestId('cover-revert')).toHaveCount(0);
  expect(await overrideOf(gameId)).toBeNull();

  // After Revert the old URL no longer serves the image.
  const after = await page.request.get(`/api/games/${gameId}/cover/${sha}`);
  expect(after.status()).toBe(404);
});

test('a non-image is refused with a message, and nothing changes', async ({ page }) => {
  const u = await signUpFresh(page);
  const { gameId } = await seedDisk(u.orgId, { title: 'Cover Refusal', diskNo: 1, sha256: freshSha() });
  await page.goto(`/games/${gameId}`);
  await page.getByTestId('cover-file').setInputFiles({
    name: 'evil.png', mimeType: 'image/png',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
  });
  await expect(page.getByText('Use a PNG, JPEG, GIF or WebP image.')).toBeVisible();
  expect(await overrideOf(gameId)).toBeNull();
});

test('another organization can neither see nor change the cover', async ({ page, browser }) => {
  const owner = await signUpFresh(page);
  const { gameId } = await seedDisk(owner.orgId, { title: 'Cover Private', diskNo: 1, sha256: freshSha() });
  await page.goto(`/games/${gameId}`);
  await page.getByTestId('cover-file').setInputFiles(PNG);
  await expect(page.getByTestId('game-cover')).toBeVisible();
  const sha = await overrideOf(gameId);

  const other = await browser.newContext();
  const otherPage = await other.newPage();
  try {
    await signUpFresh(otherPage);
    const get = await otherPage.request.get(`/api/games/${gameId}/cover/${sha}`);
    expect(get.status()).toBe(404);
    const del = await otherPage.request.delete(`/api/games/${gameId}/cover`);
    expect(del.status()).toBe(404);
    expect(await overrideOf(gameId)).toBe(sha);
  } finally {
    await other.close();
  }
});

test('the controls fit a 390 px phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const u = await signUpFresh(page);
  const { gameId } = await seedDisk(u.orgId, { title: 'Cover Phone', diskNo: 1, sha256: freshSha() });
  await page.goto(`/games/${gameId}`);
  await page.getByTestId('cover-file').setInputFiles(PNG);
  await expect(page.getByTestId('cover-revert')).toBeVisible();
  for (const id of ['cover-change', 'cover-revert', 'help-tip-cover-image']) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
  // No horizontal page scroll.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
