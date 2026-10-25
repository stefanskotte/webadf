import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { signInAsSuperAdmin } from './admin-helpers';
import { cleanupSeeded, cleanupTestReleases } from './device-helpers';

// Phase C6 (spec 2026-10-25-phase-c6-admin-design.md §10.4): the admin layout. The DB is the live one: every
// assertion is about rows a test made, or follows a value the page itself shows (both values of a state).
test.afterAll(async () => { await cleanupTestReleases(); await cleanupSeeded(); });

const PAGES = [
  ['/admin', 'Overview'], ['/admin/users', 'Users'], ['/admin/invites', 'Invites'],
  ['/admin/scan', 'Scan'], ['/admin/firmware', 'Firmware'],
] as const;

// ---- Shell (spec §1, Rulings 1, 2, 6, 36) -----------------------------------------------------------------

test('the admin header carries the Main nav with Admin current, the gear and Sign out, and no drive chips', async ({ page }) => {
  await signInAsSuperAdmin(page);
  for (const [path] of PAGES) {
    await page.goto(path);
    const header = page.getByTestId('admin-header');
    const main = header.getByRole('navigation', { name: 'Main' });
    await expect(main.getByRole('link')).toHaveText(['Library', 'Devices', 'Upload', 'Help', 'Admin']);
    await expect(main.locator('[aria-current="page"]')).toHaveText(['Admin']);
    await expect(header.getByTestId('settings-link')).toBeVisible();
    await expect(header.getByTestId('sign-out')).toBeVisible();
    await expect(header.getByTestId('search-input')).toBeVisible();
    await expect(header.getByText('Back to library')).toHaveCount(0);
    await expect(header).toContainText('webfloppy admin');
    await expect(page.locator('[data-testid^=drive-chip]')).toHaveCount(0);
    await expect(page.getByTestId('drives-compact')).toHaveCount(0);
  }
});

test('every admin page opens with the Admin sections tabs, the current one marked, and its own title', async ({ page }) => {
  await signInAsSuperAdmin(page);
  for (const [path, name] of PAGES) {
    await page.goto(path);
    const tabs = page.getByTestId('admin-sections');
    await expect(tabs).toHaveAttribute('aria-label', 'Admin sections');
    await expect(tabs.getByRole('link')).toHaveText(['Overview', 'Users', 'Invites', 'Scan', 'Firmware']);
    await expect(tabs.locator('[aria-current="page"]')).toHaveText([name]);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
    await expect(page.getByText('Admin · this server', { exact: true })).toBeVisible();
    await expect(page).toHaveTitle(`Admin · ${name} · WebFloppy`);
  }
});

// ---- Loading frame and 390 px header (fix round 1: I1, M1) -------------------------------------------------

/**
 * The tabs' top offset under the loading frame and on the landed page. The dev server will not hold a loading.tsx
 * frame on screen (a delayed RSC response shows nothing until it lands), so the frame is rendered in isolation: the
 * real AdminLoading markup is put in place of the landed page's body, under the real header with the real CSS.
 */
async function loadingVsLanded(page: Page) {
  // Users: its one-line subtitle is the same height at 390 px as at 1280 (Overview's wraps).
  await page.goto('/admin/users');
  await page.getByTestId('admin-sections').waitFor();
  const landed = (await page.getByTestId('admin-sections').boundingBox())!.y;
  // Playwright's own JSX transform cannot compile the component, so a child process renders it (tsx handles the
  // alias through tsconfig paths).
  const html = execFileSync('npx', ['tsx', '-e',
    "import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server'; " +
    "import L from './src/app/(admin)/loading'; process.stdout.write(renderToStaticMarkup(createElement(L)));",
  ], { encoding: 'utf8' });
  await page.evaluate((markup) => {
    const header = document.querySelector('[data-testid=admin-header]')!;
    while (header.nextSibling) header.nextSibling.remove();
    header.insertAdjacentHTML('afterend', markup);
  }, html);
  const loading = (await page.getByTestId('page-skeleton').locator('.h-\\[42px\\]').boundingBox())!.y;
  return { loading, landed };
}

for (const [w, h] of [[1280, 800], [390, 844]] as const) {
  test(`the loading frame puts the tabs where the landed page does, at ${w}px`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await signInAsSuperAdmin(page);
    const { loading, landed } = await loadingVsLanded(page);
    expect(Math.abs(loading - landed), `loading ${loading} vs landed ${landed}`).toBeLessThanOrEqual(2);
  });
}

test('at 390px the admin header fits: no horizontal overflow, gear and Sign out visible, two lines at most', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsSuperAdmin(page);
  await page.goto('/admin');
  const header = page.getByTestId('admin-header');
  await expect(header.getByTestId('settings-link')).toBeVisible();
  await expect(header.getByTestId('sign-out')).toBeVisible();
  const o = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
  }));
  expect(o.sw).toBeLessThanOrEqual(o.cw);
  for (const id of ['settings-link', 'sign-out']) {
    const b = (await header.getByTestId(id).boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(390);
  }
  // wordmark on line one; search, gear and Sign out together on line two (not a third line)
  const search = (await header.getByTestId('search-input').boundingBox())!;
  const out = (await header.getByTestId('sign-out').boundingBox())!;
  expect(Math.abs((search.y + search.height / 2) - (out.y + out.height / 2)), 'search and Sign out share a line').toBeLessThan(8);
  await expect(header.getByTestId('admin-email')).toBeHidden();
});
