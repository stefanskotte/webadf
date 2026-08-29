import { test, expect } from '@playwright/test';

test('sign-up without an invite code is rejected', async ({ page }) => {
  await page.goto('/sign-up');
  await page.getByLabel('Email').fill(`no-invite-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('correct-horse-battery-staple');
  await page.getByLabel('Invite code').fill('AAAAAAAA');
  await page.getByRole('button', { name: 'Sign up' }).click();

  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page).not.toHaveURL(/\/library/);
});

test('an invite code cannot be used twice', async ({ page, browser }) => {
  // First use succeeds via the helper, which mints and consumes a fresh code.
  const { inviteCode } = await import('./helpers').then((m) => m.signUpFresh(page));

  const ctx = await browser.newContext();
  const second = await ctx.newPage();
  await second.goto('/sign-up');
  await second.getByLabel('Email').fill(`reuse-${Date.now()}@example.test`);
  await second.getByLabel('Password').fill('correct-horse-battery-staple');
  await second.getByLabel('Invite code').fill(inviteCode);
  await second.getByRole('button', { name: 'Sign up' }).click();

  await expect(second.getByRole('alert')).toBeVisible();
  await expect(second).not.toHaveURL(/\/library/);
  await ctx.close();
});
