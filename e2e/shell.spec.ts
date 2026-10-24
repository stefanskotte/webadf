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
  await page.screenshot({ path: 'test-results/shell.png', fullPage: true });
});
