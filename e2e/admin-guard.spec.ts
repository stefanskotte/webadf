import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';
import { signInAsSuperAdmin } from './admin-helpers';
import { cleanupSeeded } from './device-helpers';

test.afterAll(cleanupSeeded);

// '/admin/invites' is deliberately absent from this loop until task 4 creates
// the page: an unrouted path 404s before any layout guard runs, so including
// it here would assert Next's routing rather than requireSuperAdmin().
const ADMIN_ROUTES = ['/admin', '/admin/users'];

test('a signed-in non-admin is redirected away from every admin route', async ({ page }) => {
  await signUpFresh(page); // a random @example.test user, NOT the allowlisted one
  for (const route of ADMIN_ROUTES) {
    await page.goto(route);
    // /library, not a 404 -- the response must not confirm the route exists.
    await expect(page).toHaveURL(/\/library/);
  }
});

test('a signed-out visitor is sent to sign-in, not to the admin plane', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/sign-in/);
});

test('the app shell shows a non-admin no way to reach the admin plane', async ({ page }) => {
  await signUpFresh(page);
  // Non-disclosure, the same property the /library redirect protects: an
  // ordinary user's markup must not reveal that /admin exists at all.
  await expect(page.getByRole('link', { name: 'Library' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Admin' })).toHaveCount(0);
  expect(await page.content()).not.toContain('/admin');
});

test('the admin reaches the plane from the top nav without typing a URL', async ({ page }) => {
  await signInAsSuperAdmin(page);
  await page.goto('/library');
  // The whole point of the link: the operator is an ordinary user of the app
  // too, and should not have to remember the admin URL.
  await page.getByRole('link', { name: 'Admin' }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('heading', { name: /overview/i })).toBeVisible();
});

test('the allowlisted admin sees the overview with real counts', async ({ page }) => {
  await signInAsSuperAdmin(page);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: /overview/i })).toBeVisible();
  // The database has thousands of e2e users; assert the shape, not a number.
  await expect(page.getByTestId('count-users')).toHaveText(/^\d+$/);
  await expect(page.getByTestId('count-orgs')).toHaveText(/^\d+$/);
  await expect(page.getByTestId('count-blobs')).toHaveText(/^\d+$/);
});

test('the admin user list paginates rather than rendering thousands of rows', async ({ page }) => {
  await signInAsSuperAdmin(page);
  await page.goto('/admin/users');
  const rows = page.getByTestId('admin-user-row');
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeLessThanOrEqual(50);
});

test('paging forward shows a different set of users, not the same one again', async ({ page }) => {
  await signInAsSuperAdmin(page);
  await page.goto('/admin/users');
  const firstPage = await page.getByTestId('admin-user-row').evaluateAll(
    (rows) => rows.map((r) => r.getAttribute('data-email')),
  );

  await page.getByRole('link', { name: 'Next' }).click();
  await expect(page).toHaveURL(/page=2/);
  const secondPage = await page.getByTestId('admin-user-row').evaluateAll(
    (rows) => rows.map((r) => r.getAttribute('data-email')),
  );

  // The tiebreaker on adminListUsers' ORDER BY is what makes this reliable:
  // created_at alone is not unique in this database, and an unstable sort
  // repeats a user across the page boundary instead of advancing past them.
  expect(secondPage.length).toBeGreaterThan(0);
  const overlap = secondPage.filter((e) => firstPage.includes(e));
  expect(overlap).toEqual([]);
});

test('an out-of-range page number clamps instead of showing an empty table', async ({ page }) => {
  await signInAsSuperAdmin(page);
  await page.goto('/admin/users?page=999999');
  await expect(page.getByTestId('admin-user-row').first()).toBeVisible();
  await page.goto('/admin/users?page=0');
  await expect(page.getByTestId('admin-user-row').first()).toBeVisible();
});
