import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';

test('the view toggle switches between grid and table and survives reload', async ({ page }) => {
  await signUpFresh(page);

  await page.getByLabel('Table view').click();
  await expect(page).toHaveURL(/view=table/);

  await page.reload();
  await expect(page.getByLabel('Table view')).toHaveAttribute('aria-pressed', 'true');

  await page.getByLabel('Grid view').click();
  await expect(page).toHaveURL(/view=grid/);
});
