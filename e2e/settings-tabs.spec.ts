import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';
import { hydrated } from './device-helpers';

// Settings reorganisation (2026-10-28): Account | Library | Server tabs, each its own page; the old one-page
// anchors #sharing and #about go on to their tabs.

test('the tabs switch pages, mark the current one, and keep each group to its own tab', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signUpFresh(page);
  await page.goto('/settings');
  const tabs = page.getByTestId('settings-sections');
  await expect(tabs.getByRole('link')).toHaveText(['Account', 'Library', 'Server']);
  await expect(tabs.getByRole('link', { name: 'Account' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('preferences')).toBeVisible();
  await expect(page.getByTestId('delete-account')).toBeVisible();
  await expect(page.getByTestId('sharing-settings')).toHaveCount(0);
  await expect(page.locator('#about')).toHaveCount(0);
  await expect(page.getByTestId('help-tip-preferences')).toBeVisible();

  await hydrated(page, 'pref-start-page', 'onKeyDown');
  await tabs.getByRole('link', { name: 'Library' }).click();
  await expect(page).toHaveURL(/\/settings\/library$/);
  await expect(tabs.getByRole('link', { name: 'Library' })).toHaveAttribute('aria-current', 'page');
  await expect(tabs.getByRole('link', { name: 'Account' })).not.toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('sharing-settings')).toBeVisible();
  await expect(page.getByTestId('preferences')).toHaveCount(0);
  await expect(page.getByTestId('help-tip-sharing')).toBeVisible();
  await expect(page).toHaveTitle(/Library settings/);

  await tabs.getByRole('link', { name: 'Server' }).click();
  await expect(page).toHaveURL(/\/settings\/server$/);
  await expect(tabs.getByRole('link', { name: 'Server' })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#about-heading')).toBeVisible();
  await expect(page.getByTestId('sharing-settings')).toHaveCount(0);
  await expect(page.getByTestId('help-tip-about')).toHaveCount(1);   // the card's own; the heading has none here

  await tabs.getByRole('link', { name: 'Account' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByTestId('preferences')).toBeVisible();
});

test('old one-page links go on to their tab: #sharing to Library, #about to Server', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/settings#sharing');
  await expect(page).toHaveURL(/\/settings\/library$/);
  await expect(page.getByTestId('sharing-settings')).toBeVisible();
  await page.goto('/settings#about');
  await expect(page).toHaveURL(/\/settings\/server$/);
  await expect(page.locator('#about-heading')).toBeVisible();
  // An Account anchor stays where it is.
  await page.goto('/settings#danger');
  await expect(page.getByTestId('delete-account')).toBeVisible();
  await expect(page).toHaveURL(/\/settings#danger$/);
});
