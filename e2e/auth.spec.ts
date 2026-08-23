import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';

test('signing up creates an organization and lands on the library', async ({ page }) => {
  await signUpFresh(page);
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
});

test('an anonymous visitor is redirected away from the library', async ({ page }) => {
  await page.goto('/library');
  await expect(page).toHaveURL(/\/sign-in/);
});

test('signing out then back in returns to the same library', async ({ page }) => {
  const { email, password } = await signUpFresh(page);

  await page.getByRole('button', { name: /sign out/i }).click();
  await expect(page).toHaveURL(/\/sign-in/);

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/library/);
});
