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

// ---- Overview (spec §2, Rulings 13–16) --------------------------------------------------------------------

test('Overview: six tiles that are links, the nested figures digits only, the firmware card and its footnote', async ({ page }) => {
  await signInAsSuperAdmin(page);
  await page.goto('/admin');
  const TILES = [
    ['count-users', 'Users', '/admin/users'], ['count-orgs', 'Organizations', '/admin/users'],
    ['count-games', 'Titles', '/admin/scan'], ['count-blobs', 'Blobs', '/admin/scan'],
    ['count-boardsOnline', 'Boards online', '/admin/firmware'], ['count-liveInvites', 'Live invites', '/admin/invites'],
  ] as const;
  for (const [id, label, href] of TILES) {
    const tile = page.locator(`a:has(> [data-testid="${id}"])`);
    await expect(tile).toHaveAttribute('href', href);
    await expect(tile.locator(':scope > span').first()).toHaveText(label);
    await expect(page.getByTestId(id)).toHaveText(/^\d+$/);
    await expect(tile).toHaveAttribute('data-warn', /^(true|false)$/);
  }
  for (const id of ['count-disks', 'count-boardsPaired', 'count-boardsSeen7d']) {
    await expect(page.getByTestId(id)).toHaveText(/^\d+$/);
  }
  await expect(page.locator('a:has(> [data-testid="count-users"]) > span:last-child'))
    .toHaveText(/^(newest \d{4}-\d{2}-\d{2}|none yet)$/);
  await expect(page.locator('a:has(> [data-testid="count-games"])')).toContainText(/\d+ disks?$/);
  await expect(page.locator('a:has(> [data-testid="count-boardsOnline"])')).toContainText(/of \d+ paired$/);
  // Both values of the warning: it follows the number.
  const live = Number(await page.getByTestId('count-liveInvites').textContent());
  await expect(page.locator('a:has(> [data-testid="count-liveInvites"])'))
    .toHaveAttribute('data-warn', live === 0 ? 'true' : 'false');

  await expect(page.getByRole('heading', { name: 'Boards by firmware' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Firmware registry' })).toHaveAttribute('href', '/admin/firmware');
  await expect(page.getByText(/^Boards that reported in the last 7 days: \d+\.$/)).toBeVisible();
  await expect(page.getByRole('heading', { name: /overview/i })).toHaveCount(1);

  await page.locator('a:has(> [data-testid="count-users"])').click();
  await expect(page).toHaveURL(/\/admin\/users$/);
});

test('Needs attention: the server items follow the tile numbers and come first, then the boards', async ({ page }) => {
  await signInAsSuperAdmin(page);
  await page.goto('/admin');
  const live = Number(await page.getByTestId('count-liveInvites').textContent());
  const invites = page.getByTestId('attention-invites');
  if (live === 0) {
    await expect(invites).toHaveAttribute('href', '/admin/invites');
    await expect(invites).toContainText('No live invite codes');
  } else {
    await expect(invites).toHaveCount(0);
  }
  const note = (await page.locator('a:has(> [data-testid="count-blobs"]) > span:last-child').textContent()) ?? '';
  const scan = page.getByTestId('attention-scan');
  const unchecked = /^(\d+) not yet scanned$/.exec(note)?.[1];
  if (unchecked) {
    await expect(scan).toHaveAttribute('href', '/admin/scan');
    await expect(scan.locator('[data-attn="title"]')).toHaveText(new RegExp(`^${unchecked} blobs? not yet scanned$`));
  } else {
    expect(note).toBe('all scanned');
    await expect(scan).toHaveCount(0);
  }
  // Order: server items, then board rows; "Nothing needs attention." only when there is nothing else.
  const order = await page.getByTestId('attention').locator(':scope > li').evaluateAll((lis) =>
    lis.map((li) => li.getAttribute('data-testid') ?? li.firstElementChild?.getAttribute('data-testid') ?? ''));
  const firstRow = order.indexOf('attention-row');
  const lastServer = Math.max(order.lastIndexOf('attention-invites'), order.lastIndexOf('attention-scan'));
  if (firstRow !== -1) expect(lastServer).toBeLessThan(firstRow);
  expect(order.includes('attention-empty')).toBe(order.every((id) => id === 'attention-empty'));
  expect(order.length).toBeGreaterThan(0);
});
