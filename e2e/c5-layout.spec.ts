import { test, expect, type Page } from '@playwright/test';
import { signUpFresh } from './helpers';
import { cleanupSeeded, hydrated } from './device-helpers';

/**
 * Phase C5: Settings, Help + the "?" popover, the header search, Sign in & Create account in the InfSettings /
 * InfHelp / InfSearch / InfSignIn layouts (spec 2026-10-25-phase-c5-settings-help-search-signin-design.md). Every
 * test signs up fresh (or stays signed out) and asserts only on rows it made: the e2e DB is the shared live one.
 */
test.describe.configure({ timeout: 90_000 });
test.afterAll(async () => { await cleanupSeeded(); });

const prefsSaved = (page: Page) =>
  page.waitForResponse((r) => r.url().endsWith('/api/me/prefs') && r.request().method() === 'PATCH');

// ---- Settings (spec §2) ---------------------------------------------------------------------------------------

test('Settings: a preference radiogroup moves and saves with the arrows, Home and End, and ignores a modified key', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/settings');
  const group = page.getByTestId('pref-library-page-size');
  await hydrated(page, 'pref-library-page-size', 'onKeyDown');
  await expect(group).toHaveAttribute('data-value', '48');
  await expect(page.getByTestId('pref-library-page-size-48')).toHaveAttribute('tabindex', '0');
  await expect(page.getByTestId('pref-library-page-size-24')).toHaveAttribute('tabindex', '-1');

  await page.getByTestId('pref-library-page-size-48').focus();
  await Promise.all([prefsSaved(page), page.keyboard.press('ArrowRight')]);
  await expect(group).toHaveAttribute('data-value', '96');
  await expect(page.getByTestId('pref-library-page-size-96')).toBeFocused();
  await expect(page.getByTestId('pref-library-page-size-96')).toHaveAttribute('aria-checked', 'true');
  await Promise.all([prefsSaved(page), page.keyboard.press('End')]);
  await expect(group).toHaveAttribute('data-value', 'all');
  await Promise.all([prefsSaved(page), page.keyboard.press('ArrowRight')]);   // wraps to the first
  await expect(group).toHaveAttribute('data-value', '24');
  await page.keyboard.press('Alt+ArrowRight');                               // left to the browser
  await expect(group).toHaveAttribute('data-value', '24');
  await expect(page.getByTestId('prefs-state')).toHaveText('All changes saved');
  expect((await (await page.request.get('/api/me/prefs')).json()).library.pageSize).toBe(24);
});

test('Settings: the firmware setting is a switch with words in both values; Escape closes its form and returns focus', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/settings');
  const sw = page.getByRole('switch', { name: "Don't ask for my password when updating board firmware" });
  await expect(sw).toHaveAttribute('data-testid', 'fw-skip-password');
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('fw-password-state')).toHaveText('Password asked');
  await hydrated(page, 'fw-skip-password');
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('fw-skip-password-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('fw-skip-password-input')).toHaveCount(0);
  await expect(sw).toBeFocused();
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('fw-password-state')).toHaveText('Password asked');
});

test('Settings: the section list marks the section in view, and a click moves focus to its heading', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signUpFresh(page);
  await page.goto('/settings');
  const nav = page.getByTestId('settings-nav');
  await expect(nav).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Preferences' })).toHaveAttribute('aria-current', 'true');
  const about = nav.getByRole('link', { name: 'About this server' });
  await expect(about).toHaveAttribute('href', '/about');
  // The nav and the radios hydrate in the same pass (no Suspense boundary between them).
  await hydrated(page, 'pref-start-page', 'onKeyDown');
  const danger = nav.getByRole('link', { name: 'Delete account' });
  await danger.click();
  await expect(page).toHaveURL(/#danger$/);
  await expect(page.locator('#danger-heading')).toBeFocused();
  // The last card cannot scroll to the top; the click still marks it, and nothing else.
  await expect(danger).toHaveAttribute('aria-current', 'true');
  await page.waitForTimeout(800);   // past SideNav's 600 ms click lock: a scroll-derived mark would land by now
  await expect(danger).toHaveAttribute('aria-current', 'true');
  await expect(nav.getByRole('link', { name: 'Preferences' })).not.toHaveAttribute('aria-current', 'true');
  await expect(about).not.toHaveAttribute('aria-current', 'true');
});

test('Settings: closing a form hands focus back to its opener; Sign out everywhere else hands it to the heading', async ({ page, browser }) => {
  const { email, password } = await signUpFresh(page);
  // A second browser, so Sign out everywhere else shows.
  const other = await browser.newContext();
  const p2 = await other.newPage();
  await p2.goto('/sign-in');
  await p2.getByLabel('Email').fill(email);
  await p2.getByLabel('Password').fill(password);
  await p2.getByRole('button', { name: 'Sign in' }).click();
  await expect(p2).toHaveURL(/\/library/);

  await page.goto('/settings');
  await hydrated(page, 'password-change-open');
  await page.getByTestId('password-change-open').click();
  await expect(page.getByTestId('password-current')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('password-form')).toHaveCount(0);
  await expect(page.getByTestId('password-change-open')).toBeFocused();

  await page.getByTestId('account-delete-open').click();
  await expect(page.getByTestId('account-delete-password')).toBeFocused();
  await page.getByTestId('delete-account').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('account-delete-open')).toBeFocused();

  await expect(page.getByTestId('sessions-count')).toHaveText('Signed in on 2 browsers');
  await page.getByTestId('sessions-revoke').click();
  await expect(page.getByTestId('sessions-count')).toHaveText('Signed in on this browser only');
  await expect(page.locator('#account-heading')).toBeFocused();
  await other.close();
});

test('Settings: the section mark follows Back and Forward, and an arrival at #danger marks it after hydration', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signUpFresh(page);
  await page.goto('/settings#danger');
  const nav = page.getByTestId('settings-nav');
  await hydrated(page, 'pref-start-page', 'onKeyDown');
  // The server marks the first item; once the observer runs the hash target is the mark.
  await expect(nav.getByRole('link', { name: 'Delete account' })).toHaveAttribute('aria-current', 'true');
  await expect(nav.getByRole('link', { name: 'Preferences' })).not.toHaveAttribute('aria-current', 'true');

  await nav.getByRole('link', { name: 'Firmware updates' }).click();
  await expect(page).toHaveURL(/#firmware$/);
  await expect(nav.getByRole('link', { name: 'Firmware updates' })).toHaveAttribute('aria-current', 'true');
  await page.goBack();
  await expect(page).toHaveURL(/#danger$/);
  await expect(nav.getByRole('link', { name: 'Delete account' })).toHaveAttribute('aria-current', 'true');
  await expect(nav.getByRole('link', { name: 'Firmware updates' })).not.toHaveAttribute('aria-current', 'true');
  await page.goForward();
  await expect(page).toHaveURL(/#firmware$/);
  await expect(nav.getByRole('link', { name: 'Firmware updates' })).toHaveAttribute('aria-current', 'true');
});

test('Settings: a successful firmware turn-on returns focus to the switch', async ({ page }) => {
  const { password } = await signUpFresh(page);
  await page.goto('/settings');
  const sw = page.getByTestId('fw-skip-password');
  await hydrated(page, 'fw-skip-password');
  await sw.click();
  await page.getByTestId('fw-skip-password-input').fill(password);
  await page.getByTestId('fw-skip-password-confirm').click();
  await expect(page.getByTestId('fw-password-state')).toHaveText('Password not asked');
  await expect(page.getByTestId('fw-skip-password-input')).toHaveCount(0);
  await expect(sw).toBeFocused();
});

test('Settings: arrow keys and Home/End on the Start page radiogroup move and save', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/settings');
  await hydrated(page, 'pref-start-page', 'onKeyDown');
  const group = page.getByTestId('pref-start-page');
  await expect(group).toHaveAttribute('data-value', 'library');
  await page.getByTestId('pref-start-page-library').focus();
  await Promise.all([prefsSaved(page), page.keyboard.press('ArrowRight')]);
  await expect(group).toHaveAttribute('data-value', 'devices');
  await Promise.all([prefsSaved(page), page.keyboard.press('ArrowLeft')]);
  await expect(group).toHaveAttribute('data-value', 'library');
  await Promise.all([prefsSaved(page), page.keyboard.press('End')]);
  await expect(group).toHaveAttribute('data-value', 'upload');
  await Promise.all([prefsSaved(page), page.keyboard.press('Home')]);
  await expect(group).toHaveAttribute('data-value', 'library');
  expect((await (await page.request.get('/api/me/prefs')).json()).startPage).toBe('library');
});
