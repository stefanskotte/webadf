import { test, expect } from '@playwright/test';
import { signUpFresh, runTag } from './helpers';

// A1 States (roadmap 2026-10-23): what a page shows when it fails, when the thing it names is not there, and when
// the address matches nothing at all.

test('a title that is not in your library says so, inside the app shell', async ({ page }) => {
  await signUpFresh(page);
  // A 200, not a 404: the page streams behind its loading.tsx, so the status is sent before notFound() runs. Next
  // marks the streamed page noindex instead.
  await page.goto('/games/no-such-title');
  await expect(page.getByTestId('not-found-page')).toBeVisible();
  await expect(page.getByText("That isn't in your library")).toBeVisible();
  await expect(page.getByTestId('wordmark-home')).toBeVisible();   // the header is still there
  await page.getByRole('link', { name: 'Back to the library' }).click();
  await expect(page).toHaveURL(/\/library/);
});

test('a disk that is not in your library says so too', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/disks/no-such-disk/files');
  await expect(page.getByTestId('not-found-page')).toBeVisible();
  await expect(page.getByTestId('wordmark-home')).toBeVisible();
});

test('an address that matches nothing gets "Page not found"', async ({ page }) => {
  const res = await page.goto('/no-such-page-at-all');
  expect(res?.status()).toBe(404);
  await expect(page.getByTestId('page-not-found')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to the start page' })).toHaveAttribute('href', '/');
});

test('a page that fails shows the error card with a reference, and Try again loads it again', async ({ page }) => {
  await signUpFresh(page);
  // /dev/fail exists only on a development server: it fails the first time a token is seen, then renders.
  const res = await page.goto(`/dev/fail?once=${runTag()}`);
  test.skip(res?.status() === 404, 'production build: the test page does not exist');
  await expect(page.getByTestId('error-page')).toBeVisible();
  await expect(page.getByText("This page didn't load")).toBeVisible();
  await expect(page.getByTestId('error-reference')).toContainText(/Reference: \S+/);
  await expect(page.getByTestId('wordmark-home')).toBeVisible();   // inside the shell
  await expect(page.getByRole('link', { name: 'Back to the library' })).toHaveAttribute('href', '/library');
  await page.getByTestId('error-retry').click();
  await expect(page.getByTestId('dev-fail-ok')).toBeVisible();
  await expect(page.getByTestId('error-page')).toHaveCount(0);
});

test('a page that is still loading shows placeholders under the header, then the page', async ({ page }) => {
  await signUpFresh(page);
  const res = await page.goto('/dev/slow?ms=3000', { waitUntil: 'commit' });
  test.skip(res?.status() === 404, 'production build: the test page does not exist');
  await expect(page.getByTestId('page-skeleton')).toBeVisible();
  await expect(page.getByTestId('wordmark-home')).toBeVisible();
  await expect(page.getByTestId('dev-slow-ok')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('page-skeleton')).toHaveCount(0);
});
