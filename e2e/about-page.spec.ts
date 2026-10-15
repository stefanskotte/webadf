import { test, expect } from '@playwright/test';
import { signUpFresh, createAdf } from './helpers';

test('the (i) opens About: build, hosting, platform, firmware and an empty library', async ({ page }) => {
  await signUpFresh(page);
  await page.getByRole('link', { name: 'About this server' }).click();
  await expect(page).toHaveURL(/\/about$/);
  for (const id of ['web-app', 'hosting', 'platform', 'firmware', 'library', 'about-webadf']) {
    await expect(page.getByTestId(`about-${id}`)).toBeVisible();
  }
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

test('stored bytes are a sum over distinct disk images, not 0 or NaN', async ({ page }) => {
  await signUpFresh(page);
  await createAdf(page, 'FFS');
  await expect(page.getByTestId('game-card')).toHaveCount(1);
  await createAdf(page, 'FFS');
  await expect(page.getByTestId('game-card')).toHaveCount(2);
  await page.goto('/about');
  await expect(page.getByTestId('about-library-disks')).toHaveText('2');
  await expect(page.getByTestId('about-library-titles')).toHaveText('2');
  // Two blank 880 KB images: identical bytes count once, different bytes twice.
  const exact = Number(await page.getByTestId('about-library-bytes').getAttribute('data-bytes'));
  expect(exact).toBeGreaterThanOrEqual(901_120);
  expect(exact).toBeLessThanOrEqual(2 * 901_120);
});
