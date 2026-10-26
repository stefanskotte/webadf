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
  // The name (spec §9): the wordmark is lowercase, titles and text say WebFloppy.
  // /library sets no title of its own, so it gets the root default.
  await expect(page.getByTestId('wordmark-home')).toHaveText('webfloppy');
  await expect(page).toHaveTitle('WebFloppy');
  await page.screenshot({ path: 'test-results/shell.png', fullPage: true });

  // The gear is the current page on /settings, and only there.
  await expect(page.getByRole('link', { name: 'Settings' })).not.toHaveAttribute('aria-current', 'page');
  await page.getByTestId('settings-link').click();
  await expect(page.getByTestId('settings-link')).toHaveAttribute('aria-current', 'page');

  // A child segment's own title goes through the root template.
  await page.goto('/help');
  await expect(page).toHaveTitle('Help · WebFloppy');
});

test('below lg the header is one 60 px row (home, search); from lg the search box keeps 16px from the next control', async ({ page }) => {
  await signUpFresh(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/library');
  const header = (await page.getByTestId('app-header').boundingBox())!;
  expect(header.height, 'one row').toBeLessThanOrEqual(61);
  const home = (await page.getByTestId('wordmark-home').boundingBox())!;
  // The search control is the field until Task 3 and the 44 px button after it: whichever is shown.
  const search = (await page.getByTestId('app-header')
    .locator('[data-testid="search-open"]:visible, [data-testid="search-input"]:visible').first().boundingBox())!;
  expect(Math.abs((home.y + home.height / 2) - (search.y + search.height / 2)), 'same line at 390').toBeLessThan(4);

  await page.setViewportSize({ width: 1280, height: 844 });
  await page.goto('/library');
  const box = (await page.getByTestId('search-input').boundingBox())!;
  const next = (await page.getByTestId('settings-link').boundingBox())!;
  // Same line, and spec §6.1's 16px between them (mr-2 + the group's gap-2).
  expect(Math.abs((box.y + box.height / 2) - (next.y + next.height / 2)), 'same line at 1280').toBeLessThan(4);
  expect(next.x - (box.x + box.width), 'gap at 1280').toBeCloseTo(16, 0);
});
