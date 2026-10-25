import { test, expect, type Page } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDb } from '@/db';
import { blobs } from '@/db/schema/catalog';
import { signUpFresh, runTag } from './helpers';
import { cleanupSeeded, hydrated, seedDisk } from './device-helpers';
import { seedTosecEntry, cleanupTosec } from './tosec-helpers';

/**
 * Phase C5: Settings, Help + the "?" popover, the header search, Sign in & Create account in the InfSettings /
 * InfHelp / InfSearch / InfSignIn layouts (spec 2026-10-25-phase-c5-settings-help-search-signin-design.md). Every
 * test signs up fresh (or stays signed out) and asserts only on rows it made: the e2e DB is the shared live one.
 */
test.describe.configure({ timeout: 90_000 });
test.afterAll(async () => { await cleanupTosec(); await cleanupSeeded(); });

const prefsSaved = (page: Page) =>
  page.waitForResponse((r) => r.url().endsWith('/api/me/prefs') && r.request().method() === 'PATCH');

const sha = (tag: string) => randomUUID().replace(/-/g, '').padEnd(64, tag);

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

// ---- The "?" (spec §4) ----------------------------------------------------------------------------------------

test('the "?" popover: a 24 px round trigger, the ink card, and a uniquely named link to the topic', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/settings');
  const tip = page.getByTestId('help-tip-preferences');
  await expect(tip).toHaveAccessibleName('About Preferences');
  const box = (await tip.boundingBox())!;
  expect(Math.round(box.width)).toBe(24);
  expect(Math.round(box.height)).toBe(24);
  await expect(tip.locator('svg')).toHaveCount(0);
  await hydrated(page, 'help-tip-preferences');
  await tip.click();
  await expect(tip).toHaveAttribute('data-popup-open', '');
  const pop = page.getByTestId('help-pop-preferences');
  await expect(pop).toBeVisible();
  await expect(pop).toBeInViewport({ ratio: 1 });
  const more = page.getByTestId('help-more-preferences');
  await expect(more).toHaveAccessibleName('Read the full topic: Preferences');
  await expect(more).toHaveAttribute('href', '/help#preferences');
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  await expect(tip).toBeFocused();
});

// ---- Search (spec §5) -----------------------------------------------------------------------------------------

test('Search: the field is a combobox over a listbox of option links; the arrows move aria-activedescendant', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  // The query is one ILIKE substring (search-query.ts), so the run tag sits between the shared word and the name.
  const a = await seedDisk(u.orgId, { title: `Combo ${run} Alpha`, diskNo: 1, sha256: sha('a') });
  await seedDisk(u.orgId, { title: `Combo ${run} Beta`, diskNo: 1, sha256: sha('b') });
  const input = page.getByRole('combobox', { name: 'Search titles' });
  await expect(input).toHaveAttribute('data-testid', 'search-input');
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await input.fill(`Combo ${run}`);   // both seeded titles, nothing else (the run tag is unique)
  await expect(page.locator('[data-testid="search-result"][data-result-kind="title"]')).toHaveCount(2);
  await expect(input).toHaveAttribute('aria-expanded', 'true');
  await expect(input).toHaveAttribute('aria-controls', 'search-listbox');
  await expect(page.getByRole('listbox', { name: 'Search results' })).toBeVisible();
  await expect(page.getByTestId('search-group-title')).toHaveText('Titles');
  const first = page.getByRole('option').first();
  await expect(first).toHaveAttribute('id', 'search-opt-0');
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await expect(first).toHaveAttribute('tabindex', '-1');
  await expect(first).toHaveAttribute('href', `/games/${a.gameId}`);
  await expect(input).toHaveAttribute('aria-activedescendant', 'search-opt-0');
  await input.press('ArrowDown');
  await expect(input).toHaveAttribute('aria-activedescendant', 'search-opt-1');
  await expect(page.locator('#search-opt-1')).toHaveAttribute('aria-selected', 'true');
});

test('Search: the panel closes when focus leaves or the scrim is pressed, keeps the query, opens again on focus; a row press navigates', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const { gameId } = await seedDisk(u.orgId, { title: `Scrim Target ${run}`, diskNo: 1, sha256: sha('s') });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/settings');   // its aside below y=320 is empty: a press there lands on nothing but the scrim
  const input = page.getByTestId('search-input');
  await hydrated(page, 'search-input', 'onChange');
  await input.fill(`Scrim Target ${run}`);
  const panel = page.getByTestId('search-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('search-scrim')).toBeVisible();
  await expect(page.getByTestId('search-keys')).toContainText('Esc to close');
  expect(Math.round((await panel.boundingBox())!.width)).toBe(600);

  await page.mouse.click(150, 600);   // the scrim
  await expect(panel).toHaveCount(0);
  await expect(input).toHaveValue(`Scrim Target ${run}`);
  await input.focus();
  await expect(panel).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(panel).toHaveCount(0);
  await expect(input).toHaveValue(`Scrim Target ${run}`);

  // A press on a row keeps the input focused (the panel would otherwise vanish under the pointer); the click opens it.
  await input.focus();
  const row = page.locator(`[data-testid="search-result"][data-result-id="${gameId}"]`);
  await row.hover();
  await page.mouse.down();
  await expect(input).toBeFocused();
  await expect(panel).toBeVisible();
  await page.mouse.up();
  await expect(page).toHaveURL(new RegExp(`/games/${gameId}$`));
  await expect(input).toHaveValue('');
  await expect(page.getByTestId('search-panel')).toHaveCount(0);
});

test("Search: a row shows its disk, kind and facts; a help row its '?' tile; the API carries the four new fields", async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const plain = await seedDisk(u.orgId, { title: `Rowfacts ${run} Plain`, diskNo: 1, sha256: sha('p') });
  const typedSha = sha('t');
  const typed = await seedDisk(u.orgId, { title: `Rowfacts ${run} Typed`, diskNo: 1, sha256: typedSha });
  const entryId = await seedTosecEntry({
    setName: 'Commodore Amiga - Games - [ADF]', gameName: `Rowfacts ${run} Typed (1991)(Test)`, romName: `rowfacts-${run}.adf`,
    title: `Rowfacts ${run} Typed`, sortTitle: `rowfacts ${run} typed`, year: 1991,
  });
  await getDb().update(blobs).set({ tosecEntryId: entryId, matchState: 'matched', matchCheckedAt: new Date() })
    .where(eq(blobs.sha256, typedSha));

  const body = await (await page.request.get(`/api/search?q=${encodeURIComponent(`Rowfacts ${run}`)}`)).json();
  const byId = Object.fromEntries((body.titles as { id: string }[]).map((x) => [x.id, x]));
  expect(byId[plain.gameId]).toMatchObject({ authored: false, hasHd: false, hasHfe: false, kind: null });
  expect(byId[typed.gameId]).toMatchObject({ authored: false, hasHd: false, hasHfe: false, kind: 'Game' });

  await page.getByTestId('search-input').fill(`Rowfacts ${run}`);
  const row = (id: string) => page.locator(`[data-testid="search-result"][data-result-id="${id}"]`);
  await expect(row(plain.gameId).getByTestId('search-result-sub')).toHaveText(/^Unidentified · .*Uncategorized$/);
  await expect(row(typed.gameId).getByTestId('search-result-sub')).toHaveText(/^Game · /);
  await expect(row(plain.gameId).locator('[data-disk-color]')).toHaveAttribute('data-disk-color', 'cream');
  await expect(row(typed.gameId).locator('[data-disk-color]')).not.toHaveAttribute('data-disk-color', 'cream');

  await page.getByTestId('search-input').fill('preload');
  const help = page.locator('[data-testid="search-result"][data-result-kind="help"]').first();
  await expect(help.locator('[data-tile]')).toHaveText('?');
  await expect(page.getByTestId('search-group-help')).toHaveText('Help');
});

test('Search: an empty answer names what was searched', async ({ page }) => {
  await signUpFresh(page);
  const q = `Nothing Here ${runTag()}`;
  await page.getByTestId('search-input').fill(q);
  await expect(page.getByTestId('search-empty')).toHaveText(`Nothing in your library or Help matches “${q}”.`);
});

test('Search: at 390 px the panel stays on screen and below the box', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  await seedDisk(u.orgId, { title: `Phone Panel ${run}`, diskNo: 1, sha256: sha('f') });
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/library');
  await hydrated(page, 'search-input', 'onChange');
  await page.getByTestId('search-input').fill(`Phone Panel ${run}`);
  const panel = page.getByTestId('search-panel');
  await expect(panel).toBeVisible();
  const b = (await panel.boundingBox())!;
  const i = (await page.getByTestId('search-input').boundingBox())!;
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(390);
  expect(b.y).toBeGreaterThanOrEqual(i.y + i.height);
  await expect(page.getByTestId('search-scrim')).toBeHidden();
});

// ---- Search, fix round 1 --------------------------------------------------------------------------------------

test('Search: modified arrows and Enter and IME composition keys are ignored', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  await seedDisk(u.orgId, { title: `Keys ${run} Alpha`, diskNo: 1, sha256: sha('k') });
  await seedDisk(u.orgId, { title: `Keys ${run} Beta`, diskNo: 1, sha256: sha('l') });
  const input = page.getByTestId('search-input');
  await hydrated(page, 'search-input', 'onChange');
  await input.fill(`Keys ${run}`);
  await expect(page.locator('[data-testid="search-result"]')).toHaveCount(2);
  await expect(input).toHaveAttribute('aria-activedescendant', 'search-opt-0');
  for (const m of ['Alt', 'Control', 'Meta']) await input.press(`${m}+ArrowDown`);
  await input.evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', isComposing: true, bubbles: true })));
  await expect(input).toHaveAttribute('aria-activedescendant', 'search-opt-0');
  const url = page.url();
  for (const m of ['Alt', 'Control', 'Meta']) await input.press(`${m}+Enter`);
  await input.evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
  await page.waitForTimeout(500);
  expect(page.url()).toBe(url);
  await expect(page.getByTestId('search-panel')).toBeVisible();
});

test('Search: the highlight is clamped when the rows shrink, and an error or empty panel claims no listbox', async ({ page }) => {
  await signUpFresh(page);
  const input = page.getByTestId('search-input');
  await hydrated(page, 'search-input', 'onChange');
  let mode: 'ok' | 'slow' | 'fail' = 'ok';
  await page.route('**/api/search?*', async (route) => {
    if (mode === 'slow') await new Promise((r) => setTimeout(r, 8000));
    if (mode === 'fail') return route.fulfill({ status: 500, body: '{}' });
    return route.fulfill({ json: { titles: [], collections: [] } });
  });
  // Three Help rows, then one: the help rows are matched in the browser, ahead of the (delayed) response.
  await input.fill('disk');
  await expect(page.locator('[data-testid="search-result"]')).toHaveCount(3);
  await page.waitForTimeout(800);   // let the first (empty) response land: it resets the highlight to the top row
  await input.press('ArrowDown');
  await input.press('ArrowDown');
  await expect(input).toHaveAttribute('aria-activedescendant', 'search-opt-2');
  mode = 'slow';
  await input.fill('disk hist');
  await expect(page.locator('[data-testid="search-result"]')).toHaveCount(1);
  await expect(input).toHaveAttribute('aria-activedescendant', 'search-opt-0');
  await expect(page.locator('#search-opt-0')).toHaveAttribute('aria-selected', 'true');

  mode = 'ok';
  await input.fill(`Nothing Here ${runTag()}`);
  await expect(page.getByTestId('search-empty')).toBeVisible();
  await expect(input).not.toHaveAttribute('aria-controls', /.+/);
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  mode = 'fail';
  await input.fill(`Broken ${runTag()}`);
  await expect(page.getByTestId('search-error')).toBeVisible();
  await expect(input).not.toHaveAttribute('aria-controls', /.+/);
  await expect(input).toHaveAttribute('aria-expanded', 'false');
});

// ---- Sign in & Create account (spec §6) -----------------------------------------------------------------------

test('Sign in: the split page, the switch, the heading, and the error in words with focus kept on the button', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/sign-in');
  await expect(page).toHaveTitle('Sign in · WebFloppy');
  await expect(page.getByTestId('auth-hero')).toBeVisible();
  await expect(page.getByTestId('auth-hero')).toContainText('Invite-only — ask the person who runs this server for a code.');
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome back');
  const sw = page.getByTestId('auth-switch');
  await expect(sw.getByRole('link', { name: 'Sign in' })).toHaveAttribute('aria-current', 'page');
  await expect(sw.getByRole('link', { name: 'Create account' })).toHaveAttribute('href', '/sign-up');
  await hydrated(page, 'sign-in-form', 'onSubmit');
  await page.getByLabel('Email').fill(`nobody-${runTag()}@example.test`);
  await page.getByLabel('Password').fill('not-a-real-password');
  const submit = page.getByRole('button', { name: 'Sign in' });
  await submit.click();
  const err = page.getByTestId('auth-error');
  await expect(err).toHaveText('The email or password is not right.');
  await expect(err).toHaveAttribute('role', 'alert');
  await expect(submit).toBeFocused();
  await expect(page).toHaveURL(/\/sign-in$/);
});

test('Create account: invite code first with its hint, the words for a bad code, the page title', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/sign-up?invite=ABCD2345');
  await expect(page).toHaveTitle('Create account · WebFloppy');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Create your account');
  await expect(page.getByTestId('auth-switch').getByRole('link', { name: 'Create account' })).toHaveAttribute('aria-current', 'page');
  const ids = await page.getByTestId('sign-up-form').locator('input').evaluateAll((els) => els.map((e) => e.id));
  expect(ids).toEqual(['invite-code', 'email', 'password']);
  await expect(page.getByLabel('Invite code')).toHaveValue('ABCD2345');
  await expect(page.getByLabel('Invite code')).toHaveAccessibleDescription('Ask the person who runs this server for one. Each code works once.');
  await expect(page.getByLabel('Password')).toHaveAccessibleDescription('At least 8 characters.');
  await hydrated(page, 'sign-up-form', 'onSubmit');
  await page.getByLabel('Invite code').fill('AAAAAAAA');
  await page.getByLabel('Email').fill(`badcode-${runTag()}@example.test`);
  await page.getByLabel('Password').fill('correct-horse-battery-staple');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByTestId('auth-error')).toHaveText('That invite code is not valid, or it has been used.');
  await expect(page).toHaveURL(/\/sign-up/);
});

// ---- Phone (spec §8: only what the boards and today's specs pin; the full pass is C7) -------------------------

test('at 390 px: Settings stacks with no list, Help folds its topics, Search has no scrim or keys, sign-in has no hero', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const noSideways = async () =>
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.goto('/sign-in');
  await expect(page.getByTestId('auth-hero')).toBeHidden();
  await expect(page.getByTestId('auth-switch')).toBeVisible();
  await noSideways();

  const run = runTag();
  const u = await signUpFresh(page);
  await seedDisk(u.orgId, { title: `Phone Find ${run}`, diskNo: 1, sha256: sha('f') });
  await page.goto('/settings');
  await expect(page.getByTestId('settings-nav')).toBeHidden();
  expect(await page.locator('h1').evaluate((h) => getComputedStyle(h).fontSize)).toBe('30px');
  // A row stacks: its control sits under its words.
  await expect(page.getByTestId('pref-start-page')).toBeVisible();
  const labelId = await page.getByTestId('pref-start-page').getAttribute('aria-labelledby');
  const words = (await page.locator(`[id="${labelId}"]`).boundingBox())!;
  const control = (await page.getByTestId('pref-start-page').boundingBox())!;
  expect(control.y).toBeGreaterThan(words.y + words.height - 1);
  await noSideways();

  await page.goto('/help');
  await expect(page.getByTestId('help-nav-toggle')).toHaveText('Topics · 17');
  await noSideways();

  await page.getByTestId('search-input').fill(`Phone Find ${run}`);
  const panel = page.getByTestId('search-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('search-scrim')).toBeHidden();
  await expect(page.getByTestId('search-keys')).toBeHidden();
  const box = (await panel.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await noSideways();
});

test('at 1040 px the hero clips its third disk: no disk box crosses the hero right edge', async ({ page }) => {
  await page.setViewportSize({ width: 1040, height: 800 });
  await page.goto('/sign-in');
  const hero = (await page.getByTestId('auth-hero').boundingBox())!;
  const form = (await page.getByTestId('sign-in-form').boundingBox())!;
  expect(form.x).toBeGreaterThanOrEqual(hero.x + hero.width - 1);
  // The third disk (left 290 + rotation) can reach past the hero here; a bounding box ignores clipping, so assert the clip.
  expect(await page.getByTestId('auth-hero').evaluate((h) => getComputedStyle(h).overflow)).toBe('hidden');
});

for (const path of ['/sign-in', '/sign-up']) {
  test(`at 390 px ${path} has no hero, no sideways scroll, a visible form and a 44 px submit`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(path);
    await expect(page.getByTestId('auth-hero')).toBeHidden();
    await expect(page.getByTestId('auth-switch')).toBeVisible();
    const form = page.getByTestId(path === '/sign-in' ? 'sign-in-form' : 'sign-up-form');
    await expect(form).toBeVisible();
    const fb = (await form.boundingBox())!;
    expect(fb.x).toBeGreaterThanOrEqual(0);
    expect(fb.x + fb.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const submit = form.locator('button[type=submit]');
    await expect(submit).toBeVisible();
    expect((await submit.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });
}
