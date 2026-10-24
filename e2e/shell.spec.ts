import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';

test('the shell renders on the ground with the right fonts', async ({ page }) => {
  await signUpFresh(page);

  const bodyFont = await page.evaluate(() =>
    getComputedStyle(document.body).fontFamily);
  expect(bodyFont).toContain('Geist');   // catches the shadcn self-reference bug

  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(243, 239, 230)');

  const h1Font = await page.locator('h1').first().evaluate((el) => getComputedStyle(el).fontFamily);
  expect(h1Font).toContain('Bricolage Grotesque');

  await expect(page.getByRole('link', { name: 'Library' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('app-header')).toHaveCSS('background-color', 'rgb(255, 253, 248)');
  await page.screenshot({ path: 'test-results/shell.png', fullPage: true });

  // The gear is the current page on /settings, and only there.
  await expect(page.getByRole('link', { name: 'Settings' })).not.toHaveAttribute('aria-current', 'page');
  await page.getByTestId('settings-link').click();
  await expect(page.getByTestId('settings-link')).toHaveAttribute('aria-current', 'page');
});
