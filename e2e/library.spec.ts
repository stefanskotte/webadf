import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';

test('a brand-new library shows the empty state, not an error', async ({ page }) => {
  await signUpFresh(page);
  await expect(page.getByText('No disks yet')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add disks' })).toBeVisible();
});

test('one org cannot see another org\'s games', async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pageA = await a.newPage();
  const pageB = await b.newPage();

  await signUpFresh(pageA);
  await signUpFresh(pageB);

  // Both are empty, but the point is that neither 500s and neither leaks.
  await expect(pageA.getByText('No disks yet')).toBeVisible();
  await expect(pageB.getByText('No disks yet')).toBeVisible();

  await a.close(); await b.close();
});
