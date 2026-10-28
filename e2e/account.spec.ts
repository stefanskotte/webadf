import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { games } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { session, user } from '@/db/schema/auth';
import { signUpFresh, runTag } from './helpers';
import { seedDisk, pairDevice, authHeader, cleanupSeeded, hydrated } from './device-helpers';

// A2 Settings / account (roadmap 2026-10-23): Preferences save as they change, change password, sign out everywhere
// else, delete your own account.

test.afterAll(cleanupSeeded);

const prefsSaved = (page: Page) =>
  page.waitForResponse((r) => r.url().endsWith('/api/me/prefs') && r.request().method() === 'PATCH');

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('a preference saves as it changes, with no Save button, and survives a reload', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/settings');
  await expect(page.getByTestId('prefs-save')).toHaveCount(0);
  await hydrated(page, 'pref-library-view-table');
  await Promise.all([prefsSaved(page), page.getByTestId('pref-library-view-table').click()]);
  await expect(page.getByTestId('prefs-state')).toHaveText('All changes saved');
  await page.reload();
  await expect(page.getByTestId('pref-library-view')).toHaveAttribute('data-value', 'table');
});

test('a preference that fails to save says so and shows what is stored', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/settings');
  await page.route('**/api/me/prefs', (route) =>
    route.request().method() === 'PATCH' ? route.fulfill({ status: 500, body: '{}' }) : route.continue());
  await hydrated(page, 'pref-library-view-table');
  await page.getByTestId('pref-library-view-table').click();
  await expect(page.getByTestId('prefs-state')).toHaveText("Couldn't save. Try again");
  await expect(page.getByTestId('pref-library-view')).toHaveAttribute('data-value', 'grid');
});

test('changing the password: the old one stops working and the new one signs in', async ({ page }) => {
  const { email, password } = await signUpFresh(page);
  await page.goto('/settings');
  await expect(page.getByTestId('account-email')).toHaveText(email);
  await page.getByTestId('password-change-open').click();

  // A wrong current password changes nothing.
  await page.getByTestId('password-current').fill('not-the-password');
  await page.getByTestId('password-new').fill('a-brand-new-password');
  await page.getByTestId('password-confirm').fill('a-brand-new-password');
  await page.getByTestId('password-save').click();
  await expect(page.getByTestId('password-error')).toHaveText('That is not your current password.');

  // Two new passwords that differ are caught before anything is sent.
  await page.getByTestId('password-current').fill(password);
  await page.getByTestId('password-confirm').fill('a-different-password');
  await page.getByTestId('password-save').click();
  await expect(page.getByTestId('password-error')).toHaveText("The new passwords don't match.");

  await page.getByTestId('password-confirm').fill('a-brand-new-password');
  await page.getByTestId('password-save').click();
  await expect(page.getByTestId('password-done')).toHaveText('Password changed. Your other browsers were signed out.');

  await page.getByRole('button', { name: /sign out/i }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  await signIn(page, email, password);
  await expect(page).toHaveURL(/\/sign-in/);   // the old password is refused
  await signIn(page, email, 'a-brand-new-password');
  await expect(page).toHaveURL(/\/library/);
});

test('Sign out everywhere else signs out the other browser and keeps this one', async ({ page, browser }) => {
  const { email, password } = await signUpFresh(page);
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  try {
    await signIn(otherPage, email, password);
    await expect(otherPage).toHaveURL(/\/library/);

    await page.goto('/settings');
    await expect(page.getByTestId('sessions-count')).toHaveText('Signed in on 2 browsers');
    await page.getByTestId('sessions-revoke').click();
    await expect(page.getByTestId('sessions-count')).toHaveText('Signed in on this browser only');
    await expect(page.getByTestId('sessions-revoke')).toHaveCount(0);

    await otherPage.goto('/library');
    await expect(otherPage).toHaveURL(/\/sign-in/);
    await page.goto('/library');
    await expect(page).toHaveURL(/\/library/);
  } finally {
    await other.close();
  }
});

test('deleting the account takes the password and DELETE, then removes the library, boards and user', async ({ page, request }) => {
  const { email, password, orgId } = await signUpFresh(page);
  const tag = runTag();
  await seedDisk(orgId, { title: `Doomed ${tag}`, diskNo: 1, sha256: createHash('sha256').update(`acct-${tag}`).digest('hex') });
  const { deviceId, token } = await pairDevice(page, request);

  await page.goto('/settings');
  await page.getByTestId('account-delete-open').click();
  const submit = page.getByTestId('account-delete-submit');

  // Not until DELETE is typed.
  await page.getByTestId('account-delete-password').fill(password);
  await expect(submit).toBeDisabled();
  await page.getByTestId('account-delete-confirm').fill('delete');
  await expect(submit).toBeDisabled();

  // A wrong password deletes nothing.
  await page.getByTestId('account-delete-password').fill('not-the-password');
  await page.getByTestId('account-delete-confirm').fill('DELETE');
  await submit.click();
  await expect(page.getByTestId('account-delete-error')).toHaveText('That is not your password.');
  expect(await getDb().select().from(games).where(eq(games.orgId, orgId))).toHaveLength(1);

  await page.getByTestId('account-delete-password').fill(password);
  await submit.click();
  await expect(page).toHaveURL(/\/sign-in/);

  const db = getDb();
  expect(await db.select().from(games).where(eq(games.orgId, orgId))).toHaveLength(0);
  expect(await db.select().from(devices).where(eq(devices.id, deviceId))).toHaveLength(0);
  expect(await db.select().from(user).where(eq(user.email, email))).toHaveLength(0);
  // The board's next check-in is refused, which the firmware takes as "pair again".
  expect((await request.get('/api/device/poll?since=0', { headers: authHeader(token) })).status()).toBe(401);
  await signIn(page, email, password);
  await expect(page).toHaveURL(/\/sign-in/);
});

// Better Auth's listSessions refuses a session older than freshAge (a day) with SESSION_NOT_FRESH; Settings used to
// fail the whole page on it (production 2026-10-28, digest 3297751167). Now it goes back through sign-in and returns.
test('Settings with a day-old session asks for sign-in again and comes back', async ({ page }) => {
  const { email, password } = await signUpFresh(page);
  const db = getDb();
  const [u] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
  await db.update(session).set({ createdAt: new Date(Date.now() - 2 * 24 * 3600_000) }).where(eq(session.userId, u.id));

  await page.goto('/settings');
  await expect(page).toHaveURL(/\/sign-in\?expired=1&next=%2Fsettings/);
  await expect(page.getByTestId('session-expired')).toHaveText('Your session has expired. Please sign in again.');

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
});

test('sign-in ignores a next= that leaves the site', async ({ page }) => {
  const { email, password } = await signUpFresh(page);
  await page.context().clearCookies();
  await page.goto('/sign-in?next=%2F%2Fevil.example');
  await expect(page.getByTestId('session-expired')).toHaveCount(0);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/localhost:\d+\/library/);
});
