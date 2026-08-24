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

  const orgBefore = await page.getByTestId('active-org').textContent();
  expect(orgBefore).toBeTruthy();

  await page.getByRole('button', { name: /sign out/i }).click();
  await expect(page).toHaveURL(/\/sign-in/);

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/library/);

  const orgAfter = await page.getByTestId('active-org').textContent();
  expect(orgAfter).toBeTruthy();
  expect(orgAfter).toBe(orgBefore);
});

// "/" was the untouched create-next-app scaffold ("edit this page", Next.js
// and Vercel marketing links) -- on the live deployment's landing page. It now
// redirects into the app, which for a signed-out visitor means sign-in.
test('the root path leads into the app, never the create-next-app scaffold', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in/);
  await expect(page.getByText('To get started, edit the')).toHaveCount(0);

  await signUpFresh(page);
  await page.goto('/');
  await expect(page).toHaveURL(/\/library/);
});
