import { test, expect, type Page } from '@playwright/test';
import { signUpFresh } from './helpers';
import { signInAsSuperAdmin } from './admin-helpers';
import { cleanupSeeded, hydrated, pairDevice } from './device-helpers';

/**
 * Phase C7 (spec 2026-10-26-phase-c7-phone-about-design.md §14): the phone pass, measured rather than read off
 * classes. The `mobile` project runs this file (390 x 844, hasTouch, isMobile); a test that needs another width sets
 * it. The DB is the live one: every assertion is about rows the test made. Names are C7-NN so batches can select
 * them with -g.
 */
test.afterAll(async () => { await cleanupSeeded(); });

const noSideways = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
/** The bar's visible cells: below lg, Library, Devices, Upload, More. */
const tabs = (page: Page) =>
  page.getByRole('navigation', { name: 'Main' }).locator(':scope > a, :scope > button').filter({ visible: true });
const ADMIN_PAGES = ['/admin', '/admin/users', '/admin/invites', '/admin/scan', '/admin/firmware'];

// ---- The shell (spec §2, Rulings 1-5, 8, 15) ---------------------------------------------------------------

test('C7-01 header at 390: one row of at most 60 px; home and the chip on it, 44 px; no gear, Sign out or (i)', async ({ page, request }) => {
  await signUpFresh(page);
  await pairDevice(page, request, 'C7 Phone');
  await page.goto('/library');
  const header = (await page.getByTestId('app-header').boundingBox())!;
  expect(header.height).toBeLessThanOrEqual(61);
  const home = (await page.getByTestId('wordmark-home').boundingBox())!;
  const chip = (await page.getByTestId('drives-compact').boundingBox())!;
  for (const [name, b] of [['home', home], ['chip', chip]] as const) {
    expect(b.height, name).toBeGreaterThanOrEqual(44);
    expect(b.y, name).toBeGreaterThanOrEqual(header.y - 0.5);
    expect(b.y + b.height, name).toBeLessThanOrEqual(header.y + header.height + 0.5);
  }
  expect(home.width).toBeGreaterThanOrEqual(44);
  expect(chip.x).toBeGreaterThanOrEqual(home.x + home.width);
  await expect(page.getByTestId('wordmark-home')).toHaveAccessibleName('webfloppy');
  for (const id of ['settings-link', 'sign-out', 'about-link']) await expect(page.getByTestId(id)).toBeHidden();
  await noSideways(page);
});

test('C7-01b at 360 px with a board, the header row and the four tabs fit and nothing scrolls sideways (Review Focus 4)', async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await signUpFresh(page);
  await pairDevice(page, request, 'A board with a rather long name for a small phone');
  for (const path of ['/library', '/settings']) {
    await page.goto(path);
    expect((await page.getByTestId('app-header').boundingBox())!.height, path).toBeLessThanOrEqual(61);
    await expect(tabs(page)).toHaveCount(4);
    for (const t of await tabs(page).all()) {
      const b = (await t.boundingBox())!;
      expect(b.x, path).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width, path).toBeLessThanOrEqual(360);
    }
    await noSideways(page);
  }
});

test('C7-02 bottom bar: four tabs at least 44 x 70, the current one per route, More current on Help and Settings', async ({ page }) => {
  await signUpFresh(page);
  for (const [path, current] of [
    ['/library', 'Library'], ['/devices', 'Devices'], ['/ingest', 'Upload'], ['/help', 'More'], ['/settings', 'More'],
  ] as const) {
    await page.goto(path);
    await expect(tabs(page)).toHaveText(['Library', 'Devices', 'Upload', 'More']);
    for (const t of await tabs(page).all()) {
      const b = (await t.boundingBox())!;
      expect(b.height, path).toBeGreaterThanOrEqual(44);
      expect(b.width, path).toBeGreaterThanOrEqual(70);
    }
    await expect(tabs(page).and(page.locator('[aria-current="page"]'))).toHaveText([current]);
    expect(await page.getByRole('navigation', { name: 'Main' }).evaluate((n) => n.scrollWidth <= n.clientWidth)).toBe(true);
  }
});

test('C7-02b the More menu: items at least 44 px and on screen, each reaches its page, Sign out signs out', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/library');
  const open = async () => {
    await hydrated(page, 'nav-more');
    await page.getByTestId('nav-more').tap();
    await expect(page.getByTestId('nav-more-menu')).toBeVisible();
  };
  await open();
  await expect(page.getByTestId('more-admin')).toHaveCount(0);   // a member has no Admin
  for (const id of ['more-help', 'more-settings', 'more-about', 'more-sign-out']) {
    const item = page.getByTestId(id);
    await expect(item).toBeVisible();
    // The popup opens with a zoom-in-95 animation: a box read mid-animation is 95 % of the truth.
    await expect.poll(async () => (await item.boundingBox())!.height, { message: id }).toBeGreaterThanOrEqual(44);
    const b = (await item.boundingBox())!;
    expect(b.x, id).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width, id).toBeLessThanOrEqual(390);
    expect(b.y, id).toBeGreaterThanOrEqual(0);
  }
  await page.getByTestId('more-help').tap();
  await expect(page).toHaveURL(/\/help$/);
  await open();
  await expect(page.getByTestId('more-help')).toHaveAttribute('aria-current', 'page');
  await page.getByTestId('more-settings').tap();
  await expect(page).toHaveURL(/\/settings$/);
  await open();
  await page.getByTestId('more-about').tap();
  await expect(page).toHaveURL(/\/settings#about$/);
  await open();
  await page.getByTestId('more-sign-out').tap();
  await expect(page).toHaveURL(/\/sign-in/);
});

test('C7-02c the admin bar: four tabs that fit on every admin page, More current, Admin current in the menu', async ({ page }) => {
  test.setTimeout(90_000);
  await signInAsSuperAdmin(page);
  for (const path of ADMIN_PAGES) {
    await page.goto(path);
    await expect(tabs(page)).toHaveText(['Library', 'Devices', 'Upload', 'More']);
    await expect(tabs(page).and(page.locator('[aria-current="page"]'))).toHaveText(['More']);
    expect(await page.getByRole('navigation', { name: 'Main' }).evaluate((n) => n.scrollWidth <= n.clientWidth), path).toBe(true);
    await noSideways(page);
  }
  await hydrated(page, 'nav-more');
  await page.getByTestId('nav-more').tap();
  await expect(page.getByTestId('more-admin')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('more-settings')).toBeVisible();
  await expect(page.getByTestId('more-sign-out')).toBeVisible();
});

test('C7-10 a toast ends above the bottom bar at 390 and at 900 px', async ({ page }) => {
  await signUpFresh(page);
  await page.route('**/api/disks/create', (r) => r.abort());
  for (const width of [390, 900]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/library');
    // createAdf's own wait (e2e/helpers.ts): a click before hydration opens nothing.
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="create-adf"]');
      return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
    });
    await page.getByTestId('create-adf').click();
    await page.getByTestId('create-adf-size-dd').click();
    await page.getByTestId('create-adf-fs-ffs').click();
    await page.getByTestId('create-adf-submit').click();
    const shown = page.locator('[data-sonner-toast]').filter({ hasText: 'Could not reach the server' }).first();
    await expect(shown).toBeVisible();
    // A CSS locator, not getByRole: the create dialog is still open behind the toast, and a modal dialog makes the
    // rest of the page aria-hidden, which getByRole skips.
    const bar = page.locator('nav[aria-label="Main"]').locator('xpath=../..');   // nav -> clamp -> fixed bar
    await expect.poll(async () => {
      const t = (await shown.boundingBox())!;
      const b = (await bar.boundingBox())!;
      return Math.round(b.y - (t.y + t.height));
    }, { message: `toast bottom vs bar top at ${width}` }).toBeGreaterThanOrEqual(0);
  }
});
