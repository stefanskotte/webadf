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

// ---- Settings: forms while a request is in flight (fix round 1) -------------------------------------------------

test('Settings: the firmware confirm cannot be cancelled or re-sent while its request is in flight', async ({ page }) => {
  const { password } = await signUpFresh(page);
  await page.goto('/settings');
  let posts = 0;
  await page.route('**/api/me/prefs/firmware-skip-password', async (route) => {
    posts += 1;
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await hydrated(page, 'fw-skip-password');
  await page.getByTestId('fw-skip-password').click();
  const input = page.getByTestId('fw-skip-password-input');
  await input.fill(password);
  const confirmBtn = page.getByTestId('fw-skip-password-confirm');
  await confirmBtn.click();
  await expect(confirmBtn).toHaveAttribute('aria-disabled', 'true');
  await confirmBtn.click({ force: true });   // Playwright treats aria-disabled as unclickable
  await input.press('Enter');
  await input.press('Escape');
  await page.getByTestId('firmware-prefs').getByRole('button', { name: 'Cancel' }).click({ force: true });
  await expect(input).toHaveCount(1);                       // still open: Cancel and Escape are ignored while busy
  await expect(page.getByTestId('fw-password-state')).toHaveText('Password not asked');
  await expect(input).toHaveCount(0);
  await expect(page.getByTestId('fw-skip-password')).toBeFocused();
  expect(posts).toBe(1);
});

test('Settings: the password form ignores Cancel, Escape and a second submit while busy, and reopens clean', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/settings');
  let calls = 0;
  await page.route('**/api/auth/change-password', async (route) => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await hydrated(page, 'password-change-open');
  await page.getByTestId('password-change-open').click();
  await page.getByTestId('password-current').fill('definitely-wrong-1');
  await page.getByTestId('password-new').fill('another-long-pass-1');
  await page.getByTestId('password-confirm').fill('another-long-pass-1');
  const save = page.getByTestId('password-save');
  await save.click();
  await expect(save).toHaveAttribute('aria-disabled', 'true');
  await save.click({ force: true });
  await page.getByTestId('password-confirm').press('Enter');
  await page.getByTestId('password-confirm').press('Escape');
  await page.getByTestId('password-form').getByRole('button', { name: 'Cancel' }).click({ force: true });
  await expect(page.getByTestId('password-form')).toHaveCount(1);
  await expect(page.getByTestId('password-error')).toHaveText('That is not your current password.');
  expect(calls).toBe(1);
  await page.getByTestId('password-form').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('password-form')).toHaveCount(0);
  await page.getByTestId('password-change-open').click();
  await expect(page.getByTestId('password-current')).toHaveValue('');
  await expect(page.getByTestId('password-new')).toHaveValue('');
  await expect(page.getByTestId('password-confirm')).toHaveValue('');
  await expect(page.getByTestId('password-error')).toHaveCount(0);
});

test('Settings: the delete form ignores Cancel, Escape and a second submit while busy, and reopens clean', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/settings');
  let calls = 0;
  await page.route('**/api/me/account', async (route) => {   // answered here: nothing is ever deleted
    calls += 1;
    await new Promise((r) => setTimeout(r, 1500));
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'bad_password' }) });
  });
  await hydrated(page, 'account-delete-open');
  await page.getByTestId('account-delete-open').click();
  await page.getByTestId('account-delete-password').fill('not-my-password');
  await page.getByTestId('account-delete-confirm').fill('DELETE');
  const submit = page.getByTestId('account-delete-submit');
  await submit.click();
  await expect(submit).toHaveAttribute('aria-disabled', 'true');
  await submit.click({ force: true });
  await page.getByTestId('account-delete-confirm').press('Enter');
  await page.getByTestId('account-delete-confirm').press('Escape');
  await page.getByTestId('delete-account').getByRole('button', { name: 'Cancel' }).click({ force: true });
  await expect(page.getByTestId('account-delete-password')).toHaveCount(1);
  await expect(page.getByTestId('account-delete-error')).toHaveText('That is not your password.');
  expect(calls).toBe(1);
  await page.getByTestId('delete-account').getByRole('button', { name: 'Cancel' }).click();
  await page.getByTestId('account-delete-open').click();
  await expect(page.getByTestId('account-delete-password')).toHaveValue('');
  await expect(page.getByTestId('account-delete-confirm')).toHaveValue('');
  await expect(page.getByTestId('account-delete-error')).toHaveCount(0);
});

// ---- Help (spec §3) -------------------------------------------------------------------------------------------

const HELP_LAST_TITLE = 'About this server';
const articles = (page: Page) => page.locator('article[data-testid^="help-section-"]:visible');

test('Help: topics in four groups, the one arrived at marked current, each article named by its group', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signUpFresh(page);
  await page.goto('/help#write-protect');
  const nav = page.getByTestId('help-nav');
  await expect(nav).toBeVisible();
  for (const g of ['drives', 'disks', 'network', 'server']) await expect(page.getByTestId(`help-group-${g}`)).toBeVisible();
  await expect(page.getByTestId('help-group-drives').getByRole('link')).toHaveCount(6);
  await expect(page.locator('#help-h-write-protect')).toBeInViewport();
  await expect(nav.getByRole('link', { name: 'Write protection' })).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('help-section-write-protect')).toContainText('Help · Drives');
  await expect(page.getByTestId('help-section-library')).toContainText('Help · Library and disks');
  const order = await page.locator('article[data-testid^="help-section-"]').evaluateAll((els) => els.map((e) => e.id));
  expect(order).toHaveLength(17);
  expect(order.slice(0, 3)).toEqual(['boards', 'display', 'second-drive']);
  await expect(page.getByTestId('help-nav-toggle')).toBeHidden();   // the phone summary is not drawn from lg
});

test('Help: the filter keeps only matching topics, says how many, and Escape brings all 17 back', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signUpFresh(page);
  await page.goto('/help');
  const filter = page.getByTestId('help-filter');
  await hydrated(page, 'help-filter', 'onChange');
  await filter.fill('d');
  await expect(page.getByTestId('help-filter-count')).toHaveText('');
  await expect(articles(page)).toHaveCount(17);
  // filterHelpTopics('drive') is second-drive, boards, network, send (pinned in src/lib/help/match.test.ts).
  await filter.fill('drive');
  await expect(page.getByTestId('help-filter-count')).toHaveText('4 of 17 topics');
  await expect(articles(page)).toHaveCount(4);
  await expect(page.getByTestId('help-section-library')).toBeHidden();
  await expect(page.getByTestId('help-group-disks')).toHaveCount(0);
  await expect(page.getByTestId('help-nav').getByRole('link')).toHaveCount(4);
  await filter.fill('zzqx');
  await expect(page.getByTestId('help-filter-empty')).toHaveText('No topic matches “zzqx”. Clear the search to see all 17.');
  await expect(articles(page)).toHaveCount(0);
  await expect(page.getByTestId('help-filter-count')).toHaveText('0 of 17 topics');
  await expect(page.getByTestId('help-group-server')).toBeVisible();
  await expect(page.getByTestId('help-nav').getByRole('link')).toHaveCount(0);
  await filter.press('Escape');
  await expect(filter).toHaveValue('');
  await expect(articles(page)).toHaveCount(17);
  await expect(page.getByTestId('help-filter-empty')).toHaveCount(0);
});

test('Help at 390 px: the filter and a closed Topics disclosure sit above the articles', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signUpFresh(page);
  await page.goto('/help');
  await hydrated(page, 'help-filter', 'onChange');
  const toggle = page.getByTestId('help-nav-toggle');
  await expect(toggle).toHaveText('Topics · 17');
  await expect(page.getByTestId('help-nav')).toBeHidden();
  await toggle.click();
  await expect(page.getByTestId('help-nav')).toBeVisible();
  await page.getByTestId('help-filter').fill('drive');
  await expect(toggle).toHaveText('Topics · 4 of 17');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

// ---- Help fix round 1 -------------------------------------------------------------------------------------------

test('Help at 1280x720: the sticky topic list scrolls inside itself, so the last topic is reachable', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await signUpFresh(page);
  await page.goto('/help');
  await hydrated(page, 'help-filter', 'onChange');
  const last = page.getByTestId('help-nav').getByRole('link', { name: HELP_LAST_TITLE });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  await last.click();
  await expect(page.locator('#help-h-about')).toBeInViewport();
});

// The app's loading.tsx streams every page behind a "Loading…" shell that only JS reveals, so a JS-disabled browser never
// shows /help at all; what this fix owns is the server HTML, so that is what is asserted: the topic list is in it, in a
// <details> that is already open.
test('Help: the server HTML carries the topic list inside an open <details>', async ({ page }) => {
  await signUpFresh(page);
  const res = await page.request.get('/help');
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toMatch(/<details[^>]*\sopen(=""|\s|>)[^>]*>\s*<summary[^>]*data-testid="help-nav-toggle"/);
  expect(html).toContain('data-testid="help-nav"');
  expect((html.match(/href="#[a-z-]+"/g) ?? []).length).toBeGreaterThanOrEqual(17);
});

test('Help at 390 px: the disclosure closes after hydration, and choosing a topic closes it again; no hydration warning', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (/hydrat/i.test(m.text())) errors.push(m.text()); });
  await page.setViewportSize({ width: 390, height: 844 });
  await signUpFresh(page);
  await page.goto('/help');
  await hydrated(page, 'help-filter', 'onChange');
  await expect(page.getByTestId('help-nav')).toBeHidden();
  await page.getByTestId('help-nav-toggle').click();
  await page.getByTestId('help-nav').getByRole('link', { name: 'Write protection' }).click();
  await expect(page.getByTestId('help-nav')).toBeHidden();
  expect(errors).toEqual([]);
});

test('Help: the count is a live region that is always in the page', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signUpFresh(page);
  await page.goto('/help');
  await hydrated(page, 'help-filter', 'onChange');
  await expect(page.getByTestId('help-filter-count')).toHaveText('');
  await expect(page.getByTestId('help-filter-count')).toHaveAttribute('role', 'status');
});
