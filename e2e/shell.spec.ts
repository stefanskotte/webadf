import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';

test('the shell renders on the gradient with the right fonts', async ({ page }) => {
  await signUpFresh(page);

  const bodyFont = await page.evaluate(() =>
    getComputedStyle(document.body).fontFamily);
  expect(bodyFont).toContain('Space Grotesk');   // catches the shadcn self-reference bug

  const bg = await page.evaluate(() =>
    getComputedStyle(document.body).backgroundImage);
  expect(bg).toContain('linear-gradient');

  await expect(page.getByRole('link', { name: 'Library' })).toHaveAttribute('aria-current', 'page');
  await page.screenshot({ path: 'test-results/shell.png', fullPage: true });
});
