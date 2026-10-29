import { test, expect, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { signUpFresh, runTag, createAdf, stagingReady, mintInviteCode } from './helpers';
import { revokeInvite } from '@/lib/invites';
import { signInAsSuperAdmin } from './admin-helpers';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { authHeader, cleanupSeeded, hydrated, pairDevice, seedDisk } from './device-helpers';

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
  for (const id of ['settings-link', 'sign-out']) await expect(page.getByTestId(id)).toBeHidden();
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
    ['/library', 'Library'], ['/devices', 'Devices'], ['/files', 'Files'], ['/help', 'More'], ['/settings', 'More'],
  ] as const) {
    await page.goto(path);
    await expect(tabs(page)).toHaveText(['Library', 'Devices', 'Files', 'More']);
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
  await expect(page).toHaveURL(/\/settings\/server$/);
  await expect(page.locator('#about-heading')).toBeInViewport();
  await open();
  // Only the more specific item is current on /settings/server (tabs 2026-10-28).
  await expect(page.getByTestId('more-about')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('more-settings')).not.toHaveAttribute('aria-current', 'page');
  await page.getByTestId('more-sign-out').tap();
  await expect(page).toHaveURL(/\/sign-in/);
});

test('C7-02d the More menu closes on Escape and on a tap outside it, and focus returns to the More tab, never <body>', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/library');
  await hydrated(page, 'nav-more');
  const more = page.getByTestId('nav-more');
  const menu = page.getByTestId('nav-more-menu');
  const open = async () => { await more.tap(); await expect(menu).toBeVisible(); };

  await open();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();

  await open();
  // Somewhere on the page body that is not a control: the top-left of the main area, below the header.
  await page.touchscreen.tap(8, 200);
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();
});

test('C7-02c the admin bar: four tabs that fit on every admin page, More current, Admin current in the menu', async ({ page }) => {
  test.setTimeout(90_000);
  await signInAsSuperAdmin(page);
  for (const path of ADMIN_PAGES) {
    await page.goto(path);
    await expect(tabs(page)).toHaveText(['Library', 'Devices', 'Files', 'More']);
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

// ---- About into Settings (spec §10, Rulings 20-25) ---------------------------------------------------------

test('C7-07 Settings at 390: the Server tab is About this server with its six groups; More and /about land on it', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/settings');
  const order = await page.evaluate(() => [...document.querySelectorAll('section[id]')].map((s) => s.id)
    .filter((id) => ['prefs', 'account', 'firmware', 'about', 'danger'].includes(id)));
  expect(order).toEqual(['prefs', 'account', 'firmware', 'danger']);
  await noSideways(page);
  await hydrated(page, 'nav-more');
  await page.getByTestId('nav-more').tap();
  await page.getByTestId('more-about').tap();
  await expect(page).toHaveURL(/\/settings\/server$/);
  await expect(page.locator('#about-heading')).toBeInViewport();
  for (const id of ['web-app', 'hosting', 'platform', 'firmware', 'library', 'about-webadf']) {
    await expect(page.getByTestId(`about-${id}`)).toBeAttached();
  }
  await page.goto('/about');
  await expect(page).toHaveURL(/\/settings\/server$/);
  await expect(page.locator('#about-heading')).toBeInViewport();
  await noSideways(page);
});

// ---- Search below sm (spec §2.4, Rulings 6, 7) -------------------------------------------------------------

test('C7-03 search at 390: the button opens the field focused, the panel sits under the row, a tap outside closes it, Cancel returns focus', async ({ page }) => {
  const u = await signUpFresh(page);
  const run = runTag();
  await seedDisk(u.orgId, { title: `Phone Search ${run}`, diskNo: 1, sha256: randomBytes(32).toString('hex') });
  await page.goto('/library');
  const open = page.getByTestId('search-open');
  const input = page.getByTestId('search-input');
  const ob = (await open.boundingBox())!;
  expect(ob.width).toBeGreaterThanOrEqual(44);
  expect(ob.height).toBeGreaterThanOrEqual(44);
  await expect(input).toBeHidden();
  await hydrated(page, 'search-open');
  await open.tap();
  await expect(input).toBeFocused();
  expect((await input.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByTestId('search-cancel')).toBeVisible();
  await input.fill(`Phone Search ${run}`);
  const panel = page.getByTestId('search-panel');
  await expect(panel).toBeVisible();
  const header = (await page.getByTestId('app-header').boundingBox())!;
  const p = (await panel.boundingBox())!;
  expect(p.y).toBeGreaterThanOrEqual(header.y + header.height);
  expect(p.x).toBeGreaterThanOrEqual(0);
  expect(p.x + p.width).toBeLessThanOrEqual(390);
  // The phone scrim is there and colourless (C5 deferred: iOS tap-away); a tap on it closes the panel.
  await expect(page.getByTestId('search-scrim')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const sb = (await page.getByTestId('search-scrim').boundingBox())!;
  await page.touchscreen.tap(sb.x + sb.width / 2, sb.y + (sb.height - 90) * 0.75);   // clear of the tab bar, which sits above the scrim
  await expect(panel).toBeHidden();
  // Cancel clears, closes the row, and hands focus back to the button.
  await input.tap();
  await page.getByTestId('search-cancel').tap();
  await expect(input).toBeHidden();
  await expect(open).toBeVisible();
  await expect(open).toBeFocused();
  await open.tap();
  await expect(input).toHaveValue('');
  await noSideways(page);
});

test('C7-03b search at 390: a tapped result navigates once, the row closes, focus is not on the body (Review Focus 2)', async ({ page }) => {
  const u = await signUpFresh(page);
  const run = runTag();
  const { gameId } = await seedDisk(u.orgId, { title: `Phone Result ${run}`, diskNo: 1, sha256: randomBytes(32).toString('hex') });
  await page.goto('/library');
  await hydrated(page, 'search-open');
  await page.getByTestId('search-open').tap();
  await page.getByTestId('search-input').fill(`Phone Result ${run}`);
  const result = page.locator(`[data-testid="search-result"][data-result-id="${gameId}"]`);
  await expect(result).toBeVisible();
  const before = await page.evaluate(() => history.length);
  await result.tap();
  await expect(page).toHaveURL(new RegExp(`/games/${gameId}`));
  expect(await page.evaluate(() => history.length)).toBe(before + 1);
  await expect(page.getByTestId('search-input')).toBeHidden();
  await expect(page.getByTestId('search-open')).toBeVisible();
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
});

// ---- Search, fix round 1 -----------------------------------------------------------------------------------

test('C7-03c the phone scrim sits under the tab bar: with the panel open, one tap on Devices navigates', async ({ page }) => {
  const u = await signUpFresh(page);
  const run = runTag();
  await seedDisk(u.orgId, { title: `Phone Bar ${run}`, diskNo: 1, sha256: randomBytes(32).toString('hex') });
  await page.goto('/library');
  await hydrated(page, 'search-open');
  await page.getByTestId('search-open').tap();
  await page.getByTestId('search-input').fill(`Phone Bar ${run}`);
  await expect(page.getByTestId('search-panel')).toBeVisible();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Devices' }).tap();
  await expect(page).toHaveURL(/\/devices/);
  await expect(page.getByTestId('search-panel')).toBeHidden();
});

test('C7-03g at 768 the search scrim also sits under the tab bar: one tap on Devices navigates', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  const u = await signUpFresh(page);
  const run = runTag();
  await seedDisk(u.orgId, { title: `Tablet Bar ${run}`, diskNo: 1, sha256: randomBytes(32).toString('hex') });
  await page.goto('/library');
  await hydrated(page, 'search-input', 'onChange');
  await page.getByTestId('search-input').fill(`Tablet Bar ${run}`);
  await expect(page.getByTestId('search-panel')).toBeVisible();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Devices' }).tap();
  await expect(page).toHaveURL(/\/devices/);
  await expect(page.getByTestId('search-panel')).toBeHidden();
});

test('C7-03d a tap on the scrim closes the panel and does not reach the link underneath', async ({ page }) => {
  const u = await signUpFresh(page);
  const run = runTag();
  for (let i = 0; i < 4; i++) {
    await seedDisk(u.orgId, { title: `Phone Under ${run} ${i}`, diskNo: 1, sha256: randomBytes(32).toString('hex') });
  }
  await page.goto('/library');
  await hydrated(page, 'search-open');
  await page.getByTestId('search-open').tap();
  await page.getByTestId('search-input').fill(`zzz-none-${run}`);
  const panel = page.getByTestId('search-panel');
  await expect(panel).toBeVisible();
  const pb = (await panel.boundingBox())!;
  // A page link whose centre lies below the panel, under the scrim.
  const target = await page.evaluate((minY) => {
    for (const a of Array.from(document.querySelectorAll('a[href^="/games/"]:not([data-testid="search-result"])'))) {
      const r = a.getBoundingClientRect();
      const cy = r.y + r.height / 2;
      if (cy > minY + 8 && cy < window.innerHeight - 80 && r.width > 0) return { x: r.x + r.width / 2, y: cy, href: a.getAttribute('href') };
    }
    return null;
  }, pb.y + pb.height);
  expect(target).not.toBeNull();
  const url = page.url();
  await page.touchscreen.tap(target!.x, target!.y);
  await expect(panel).toBeHidden();
  await page.waitForTimeout(500);
  expect(page.url()).toBe(url);
});

test('C7-03e the open row closes when the route changes', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/library');
  await hydrated(page, 'search-open');
  await page.getByTestId('search-open').tap();
  await expect(page.getByTestId('search-input')).toBeFocused();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Devices' }).tap();
  await expect(page).toHaveURL(/\/devices/);
  await expect(page.getByTestId('search-input')).toBeHidden();
  await expect(page.getByTestId('search-open')).toBeVisible();
});

test('C7-03f widening to sm closes the row; narrowing with the field focused moves focus to the button', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/library');
  await hydrated(page, 'search-open');
  await page.getByTestId('search-open').tap();
  await page.setViewportSize({ width: 800, height: 844 });
  await expect(page.getByTestId('search-input')).toBeVisible();
  await expect(page.getByTestId('search-open')).toBeHidden();
  await page.getByTestId('search-input').focus();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('search-input')).toBeHidden();
  await expect(page.getByTestId('search-open')).toBeVisible();
  await expect(page.getByTestId('search-open')).toBeFocused();
});

// ---- Touch targets (spec §3, §14.9, Rulings 12-14, 29) ------------------------------------------------------

/** Every control a finger presses -- outside prose, the "?" and aria-hidden -- whose hit area is under 44 px tall. */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const sel = 'button, a.btn-like, [role="radio"], [role="tab"], select, summary, [data-testid="auth-switch"] a';
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      if (el.matches('[data-testid^="help-tip-"]') || el.closest('p, [aria-hidden="true"], [data-sonner-toaster]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || getComputedStyle(el).visibility === 'hidden') continue;   // not shown
      // A ::before hit area (the "?", the firmware switch) counts: its negative insets grow the target.
      const b = getComputedStyle(el, '::before');
      const grow = b.position === 'absolute'
        ? Math.max(0, -(parseFloat(b.top) || 0)) + Math.max(0, -(parseFloat(b.bottom) || 0)) : 0;
      const h = r.height + grow;
      if (h < 43.5) {
        const name = el.dataset.testid ?? el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 32);
        out.push(`${name} (${Math.round(h)} px)`);
      }
    }
    return out;
  });
}

/** spec §14.9 on the page as it stands: no small control at 390, no sideways scroll at 360, 390 or 414. Soft, so one
 *  run lists every failure; ends at 390. */
async function touchSweep(page: Page, label: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  expect.soft(await smallTargets(page), `${label}: controls under 44 px`).toEqual([]);
  for (const width of [360, 390, 414]) {
    await page.setViewportSize({ width, height: 844 });
    expect.soft(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
      `${label} scrolls sideways at ${width}`).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
}

test('C7-09a touch targets and no sideways scroll: a title, its disk files, Settings, Help, sign-in, sign-up', async ({ page }) => {
  test.setTimeout(150_000);
  await signUpFresh(page);
  await createAdf(page, 'FFS');
  const title = await page.locator('a[href^="/games/"]').first().getAttribute('href');
  await page.goto(title!);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await touchSweep(page, 'title page');
  const files = await page.getByRole('link', { name: 'Files…' }).first().getAttribute('href');
  await page.goto(files!);
  await expect(page.getByTestId('disk-strip-right')).toBeVisible();
  await touchSweep(page, 'disk files');
  for (const path of ['/settings', '/settings/library', '/settings/server', '/help']) {
    await page.goto(path);
    await expect(page.locator('h1').first()).toBeVisible();
    await touchSweep(page, path);
  }
  await page.context().clearCookies();
  for (const path of ['/sign-in', '/sign-up']) {
    await page.goto(path);
    await expect(page.getByTestId('auth-switch')).toBeVisible();
    await touchSweep(page, path);
  }
});

test('C7-11 Help at 390: a /help#topic load leaves the topic at the top after the Topics list closes', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/help#second-drive');
  await expect(page.getByTestId('help-nav-toggle')).toHaveText('Topics · 19');
  await expect(page.locator('details:has([data-testid="help-nav-toggle"])')).not.toHaveAttribute('open');
  await expect.poll(async () => Math.round((await page.locator('#second-drive').boundingBox())!.y)).toBeLessThan(200);
  await expect(page.locator('#second-drive')).toBeInViewport();
});

// ---- Library (spec §4, Rulings 16, 17) ---------------------------------------------------------------------

/** A real finger via CDP (mobile.spec's touchDrag, in two dimensions): press, hold past the 250 ms delay, walk, lift. */
async function touchDragTo(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, holdMs: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
  await page.waitForTimeout(holdMs);
  for (const t of [0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }],
    });
    await page.waitForTimeout(40);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

const newCollection = async (page: Page, name: string) =>
  (await (await page.request.post('/api/collections', { data: { name } })).json()).id as string;
const chipOf = (page: Page, id: string) => page.locator(`[data-testid="collection-row"][data-collection-id="${id}"]`);

// Found in the Task 9 by-hand check: ROW's own max-md:bg-(--surface) beat CURRENT's max-md:bg-(--ink), so the current
// chip drew surface-coloured words on a surface background -- invisible.
test('C7-04f Library at 390: the current chip is an ink chip and its words are legible on it (Uncategorized, and a collection)', async ({ page }) => {
  await signUpFresh(page);
  const id = await newCollection(page, `Current ${runTag()}`);
  const bgText = (loc: ReturnType<Page['locator']>) => loc.evaluate((el) => {
    const name = el.querySelector('span.truncate, a span.truncate') as HTMLElement;
    return { bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(name).color };
  });
  await page.goto('/library');
  await hydrated(page, 'collections-new');
  const inbox = await bgText(page.getByTestId('collection-uncategorized'));
  expect(inbox.bg, 'Uncategorized chip bg vs words').not.toBe(inbox.fg);
  await page.goto(`/library?collection=${id}`);
  await hydrated(page, 'collections-new');
  const cur = await bgText(chipOf(page, id));
  expect(cur.bg, 'collection chip bg vs words').not.toBe(cur.fg);
});

test('C7-04 Library at 390: the collections are one row of 44 px chips, the current one in view with its ⋯; + New makes one', async ({ page }) => {
  await signUpFresh(page);
  const run = runTag();
  const ids: string[] = [];
  for (const n of ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']) ids.push(await newCollection(page, `${n} collection ${run}`));
  const last = ids[ids.length - 1];
  await page.goto(`/library?collection=${last}`);
  const rail = page.getByTestId('collection-rail');
  await hydrated(page, 'collections-new');   // measure the settled DOM, not the server's
  const chips = rail.locator('[data-testid="collection-uncategorized"], [data-testid="collection-row"], [data-testid="collection-all"], [data-testid="collections-new"]');
  await expect(chips).toHaveCount(ids.length + 3);
  const ys = new Set<number>();
  for (const c of await chips.all()) {
    const b = (await c.boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(44);
    ys.add(Math.round(b.y));
  }
  expect(ys.size, 'one line').toBe(1);
  await expect(chipOf(page, last)).toHaveAttribute('data-current', 'true');
  await expect(chipOf(page, last)).toBeInViewport();
  // Only the current collection shows its ⋯, 44 x 44, with today's Rename and Delete.
  await expect(page.getByTestId(`collection-menu-${ids[0]}`)).toBeHidden();
  const menu = page.getByTestId(`collection-menu-${last}`);
  const mb = (await menu.boundingBox())!;
  expect(mb.width).toBeGreaterThanOrEqual(44);
  expect(mb.height).toBeGreaterThanOrEqual(44);
  await hydrated(page, `collection-menu-${last}`);
  await menu.tap();
  await expect(page.getByTestId(`collection-rename-${last}`)).toBeVisible();
  await expect(page.getByTestId(`collection-delete-${last}`)).toBeVisible();
  await page.keyboard.press('Escape');
  // + New opens today's form under the row, focused; a create closes it and the chip appears.
  await expect(page.getByTestId('collection-create')).toBeHidden();
  await hydrated(page, 'collections-new');
  await page.getByTestId('collections-new').tap();
  const field = page.getByTestId('collection-create');
  await expect(field).toBeFocused();
  const fb = (await field.boundingBox())!;
  expect(fb.y).toBeGreaterThanOrEqual((await chipOf(page, last).boundingBox())!.y + 44);
  expect(fb.height).toBeGreaterThanOrEqual(44);
  await field.fill(`Foxtrot ${run}`);
  await field.press('Enter');
  await expect(rail.locator('[data-testid="collection-row"]').filter({ hasText: `Foxtrot ${run}` })).toHaveCount(1);
  await expect(page.getByTestId('collection-create')).toBeHidden();
  await expect(page.getByTestId('collections-new')).toBeFocused();
  await noSideways(page);
});

test('C7-04b Library at 390: Rename opens a field under the chip row; Enter saves and focus returns to the ⋯ (Review Focus 5)', async ({ page }) => {
  await signUpFresh(page);
  const run = runTag();
  const id = await newCollection(page, `Rename me ${run}`);
  await page.goto(`/library?collection=${id}`);
  await hydrated(page, `collection-menu-${id}`);
  await page.getByTestId(`collection-menu-${id}`).tap();
  await page.getByTestId(`collection-rename-${id}`).tap();
  const field = page.getByRole('textbox', { name: 'Collection name' });
  await expect(field).toBeFocused();
  const chip = (await chipOf(page, id).boundingBox())!;
  const f = (await field.boundingBox())!;
  expect(f.y).toBeGreaterThanOrEqual(chip.y + chip.height);
  expect(f.height).toBeGreaterThanOrEqual(44);
  await field.fill(`Renamed ${run}`);
  await field.press('Enter');
  await expect(chipOf(page, id).getByTestId('collection-name')).toHaveText(`Renamed ${run}`);
  await expect(page.getByTestId(`collection-menu-${id}`)).toBeFocused();
});

test('C7-04c Library at 390: a card held and dropped on a chip is filed into that collection', async ({ page }) => {
  test.setTimeout(60_000);
  const u = await signUpFresh(page);
  const run = runTag();
  await seedDisk(u.orgId, { title: `Drop ${run}`, diskNo: 1, sha256: randomBytes(32).toString('hex') });
  const id = await newCollection(page, `Target ${run}`);
  await page.goto('/library');
  const card = page.getByTestId('game-card').filter({ hasText: `Drop ${run}` });
  await expect(card).toBeVisible();
  await expect(chipOf(page, id)).toBeInViewport();
  const from = (await card.boundingBox())!;
  const to = (await chipOf(page, id).boundingBox())!;
  const filed = page.waitForResponse((r) => r.url().includes(`/api/collections/${id}/games`) && r.request().method() === 'POST');
  await touchDragTo(page, { x: from.x + from.width / 2, y: from.y + from.height / 2 },
    { x: to.x + to.width / 2, y: to.y + to.height / 2 }, 400);
  expect((await filed).status()).toBe(200);
});

test('C7-09b touch targets and no sideways scroll: the Library grid and table', async ({ page }) => {
  test.setTimeout(120_000);
  const u = await signUpFresh(page);
  const run = runTag();
  for (let i = 0; i < 3; i++) await seedDisk(u.orgId, { title: `Sweep ${run} ${i}`, diskNo: 1, sha256: randomBytes(32).toString('hex') });
  await newCollection(page, `Sweep set ${run}`);
  await page.goto('/library');
  await expect(page.getByTestId('game-card').first()).toBeVisible();
  await touchSweep(page, 'library grid');
  await page.getByLabel('Table view').tap();
  await expect(page.getByTestId('game-table')).toBeVisible();
  await touchSweep(page, 'library table');
});

test('C7-04d Library at 390: deleting a collection from its ⋯ by keyboard leaves focus on Uncategorized, not <body>', async ({ page }) => {
  await signUpFresh(page);
  const id = await newCollection(page, `Delete me ${runTag()}`);
  await page.goto(`/library?collection=${id}`);
  await hydrated(page, `collection-menu-${id}`);
  page.once('dialog', (d) => { void d.accept(); });
  await page.getByTestId(`collection-menu-${id}`).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId(`collection-delete-${id}`)).toBeVisible();
  await page.getByTestId(`collection-delete-${id}`).focus();
  await page.keyboard.press('Enter');
  await expect(chipOf(page, id)).toHaveCount(0);
  await expect(page.getByTestId('collection-uncategorized')).toBeFocused();
});

test('C7-04e Library at 390: a chip that is not current keeps 8 px of its own padding right of the count', async ({ page }) => {
  await signUpFresh(page);
  const run = runTag();
  const a = await newCollection(page, `Pad A ${run}`);
  const b = await newCollection(page, `Pad B ${run}`);
  await page.goto(`/library?collection=${b}`);
  await hydrated(page, 'collections-new');
  const chip = (await chipOf(page, a).boundingBox())!;
  const count = (await chipOf(page, a).getByTestId('collection-count').boundingBox())!;
  expect(chip.x + chip.width - (count.x + count.width)).toBeGreaterThanOrEqual(8);
  // The whole chip is the link: a tap on its left edge opens the collection.
  await chipOf(page, a).tap({ position: { x: 3, y: 22 } });
  await expect(chipOf(page, a)).toHaveAttribute('data-current', 'true');
});

// ---- Devices (spec §6, Ruling 18) --------------------------------------------------------------------------

/** One board with an NFC reader (so Write a Next-disk card shows), DF1-capable firmware and a disk in DF0. */
async function deviceWithDisk(page: Page, request: Parameters<typeof pairDevice>[1], orgId: string) {
  const { deviceId, token } = await pairDevice(page, request, 'C7 Devices');
  const sha = randomBytes(32).toString('hex');
  const { gameId, diskId } = await seedDisk(orgId, { title: `C7 Disk ${runTag()}`, diskNo: 1, sha256: sha });
  expect((await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: sha, nfcReader: 'present', preload: null, firmwareVersion: '1.21.1+gabc1234', secondDrive: 'off', driveVersion: 0 },
  })).status()).toBe(204);
  // devices-page.spec's setDevice: desired = mounted, so the card is converged and offers Eject.
  await getDb().update(devices).set({
    desiredGameId: gameId, desiredDiskId: diskId, desiredSha256: sha, desiredDiskNo: 1,
    mountedGameId: gameId, mountedDiskId: diskId, mountedSha256: sha, mountedDiskNo: 1,
    lastSeenAt: new Date(), desiredVersion: 1,
  }).where(eq(devices.id, deviceId));
  return deviceId;
}

test('C7-05 Devices at 390: the head buttons one line each and full width; Change second drive opens the radios; card controls 44 px', async ({ page, request }) => {
  const u = await signUpFresh(page);
  const id = await deviceWithDisk(page, request, u.orgId);
  await page.goto('/devices');
  await expect(page.getByTestId(`eject-${id}`)).toBeVisible();   // the page streams in: measure only what is there
  for (const tid of ['write-next-card', 'pair-device']) {
    const b = (await page.getByTestId(tid).boundingBox())!;
    expect(b.height, `${tid} one line`).toBeLessThanOrEqual(48);
    expect(b.height, tid).toBeGreaterThanOrEqual(44);
    expect(b.width, `${tid} full width`).toBeGreaterThan(300);
  }
  for (const tid of [`alias-edit-${id}`, `board-settings-${id}`, `display-toggle-${id}`, `device-protection-${id}`,
    `device-change-disk-${id}`, `eject-${id}`]) {
    const b = (await page.getByTestId(tid).boundingBox())!;
    expect(b.height, tid).toBeGreaterThanOrEqual(44);
    expect(b.x + b.width, tid).toBeLessThanOrEqual(390);
  }
  // DF1: closed, it says the mode in words; the button opens the radios in place, one per row, 44 px.
  const group = page.getByTestId(`second-drive-${id}`);
  await expect(group).toBeHidden();
  const change = page.getByTestId(`df1-change-${id}`);
  await expect(change).toHaveText('Change second drive');
  await hydrated(page, `df1-change-${id}`);
  await change.tap();
  await expect(change).toHaveAttribute('aria-expanded', 'true');
  await expect(change).toHaveText('Done');
  await expect(group).toBeVisible();
  for (const m of ['off', 'df1', 'net', 'any']) {
    expect((await page.getByTestId(`second-drive-${id}-${m}`).boundingBox())!.height, m).toBeGreaterThanOrEqual(44);
  }
  // A choice saves as today and does not close the group.
  const saved = page.waitForResponse((r) => r.url().includes(`/api/devices/${id}/second-drive`) && r.request().method() === 'PATCH');
  await page.getByTestId(`second-drive-${id}-net`).tap();
  expect((await saved).ok()).toBe(true);
  await expect(group).toBeVisible();
  await expect(page.getByTestId(`second-drive-${id}-net`)).toHaveAttribute('aria-checked', 'true');
  await noSideways(page);
});

test('C7-09c touch targets and no sideways scroll: Devices with a board holding a disk', async ({ page, request }) => {
  test.setTimeout(90_000);
  const u = await signUpFresh(page);
  await deviceWithDisk(page, request, u.orgId);
  await page.goto('/devices');
  await expect(page.getByTestId('pair-device')).toBeVisible();
  await touchSweep(page, 'devices');
});

// ---- Upload (spec §7, Ruling 19) ---------------------------------------------------------------------------

async function sendBoard(page: Page, request: Parameters<typeof pairDevice>[1]) {
  const { token } = await pairDevice(page, request, 'C7 Upload');
  await request.post('/api/device/status', { headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: '1.21.1+gabc1234', secondDrive: 'net', driveVersion: 0 } });
  await request.get('/api/device/poll?since=999999&xferAck=0&rx=c', { headers: authHeader(token) });
}

test('C7-06 Upload at 390: two 96 px tiles side by side; a tap opens its chooser; Staging starts on the first screen', async ({ page, request }) => {
  await signUpFresh(page);
  await sendBoard(page, request);
  await page.goto('/ingest');
  await stagingReady(page);
  const add = page.getByTestId('add-browse');
  const send = page.getByTestId('send-browse');
  const a = (await add.boundingBox())!;
  const s = (await send.boundingBox())!;
  expect(Math.abs(a.y - s.y)).toBeLessThan(1);
  expect(s.x).toBeGreaterThan(a.x + a.width - 1);
  for (const t of [a, s]) {
    expect(t.height).toBeGreaterThanOrEqual(96);
    expect(t.x).toBeGreaterThanOrEqual(0);
    expect(t.x + t.width).toBeLessThanOrEqual(390);
  }
  await hydrated(page, 'file-input', 'onChange');
  for (const [tile, input] of [[add, 'file-input'], [send, 'send-file-input']] as const) {
    const chooser = page.waitForEvent('filechooser');
    await tile.tap();
    expect(await (await chooser).element().getAttribute('data-testid')).toBe(input);
  }
  expect((await page.locator('#staging-heading').boundingBox())!.y).toBeLessThan(844);
  await noSideways(page);
});

test('C7-06b Upload at 390 with no board: the Send tile says Pair a board first, opens no chooser, and the hint says why (Review Focus 3)', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/ingest');
  await stagingReady(page);
  const tile = page.locator('[data-tile="Pair a board first"]');
  await expect(tile).toBeVisible();
  const a = (await page.getByTestId('add-browse').boundingBox())!;
  const t = (await tile.boundingBox())!;
  expect(Math.abs(a.y - t.y)).toBeLessThan(1);
  expect(t.height).toBeGreaterThanOrEqual(96);
  expect(await tile.evaluate((el) => getComputedStyle(el, '::before').content)).toBe('"Pair a board first"');
  let opened = false;
  page.on('filechooser', () => { opened = true; });
  await tile.tap();
  await page.waitForTimeout(300);
  expect(opened).toBe(false);
  await expect(page.getByTestId('send-no-board')).toBeVisible();
});

// Task 7 review carry: below sm the tiles' visible text is hidden and the name came only from ::before content.
test('C7-06d Upload at 390: each file input has an always-present name, and the disabled Send tile is hidden from assistive tech', async ({ page, request }) => {
  await signUpFresh(page);
  await sendBoard(page, request);
  await page.goto('/ingest');
  await stagingReady(page);
  await expect(page.getByLabel('Browse files')).toHaveAttribute('data-testid', 'file-input');
  await expect(page.getByLabel('Choose files')).toHaveAttribute('data-testid', 'send-file-input');
  // The computed name, not a text match: the visible words are display:none here and drop out of it.
  await expect(page.getByTestId('file-input')).toHaveAccessibleName('Browse files');
  await expect(page.getByTestId('send-file-input')).toHaveAccessibleName('Choose files');
});

test('C7-06e Upload at 390 with no board: the Pair a board first tile is aria-hidden', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/ingest');
  await stagingReady(page);
  await expect(page.locator('[data-tile="Pair a board first"]')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByLabel('Browse files')).toHaveAttribute('data-testid', 'file-input');
});

test('C7-09d touch targets and no sideways scroll: Upload with a board', async ({ page, request }) => {
  test.setTimeout(90_000);
  await signUpFresh(page);
  await sendBoard(page, request);
  await page.goto('/ingest');
  await stagingReady(page);
  await touchSweep(page, 'upload');
});

// Pre-flight ruling: the section is display:contents below sm; its region must stay in the accessibility tree and a
// drop must still reach it.
test('C7-06c Upload at 390: each card stays a named region and still takes a drop', async ({ page, request }) => {
  await signUpFresh(page);
  await sendBoard(page, request);
  await page.goto('/ingest');
  await stagingReady(page);
  await expect(page.getByRole('region', { name: 'Add disks to the library' })).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Send files to the Amiga' })).toHaveCount(1);
  await hydrated(page, 'send-dropzone', 'onDrop');
  await page.getByTestId('send-dropzone').evaluate((el) => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'c7-drop.txt', { type: 'text/plain' }));
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await expect(page.locator('[data-testid="staging-row"]', { hasText: 'c7-drop.txt' })).toHaveCount(1, { timeout: 15_000 });
});

// ---- Admin (spec §11, Rulings 8-10) ------------------------------------------------------------------------

test('C7-08 Admin at 390: no tab clipped, Invites rows stacked with Copy code / Copy link / Revoke 44 px in view, no sideways scroll', async ({ page }) => {
  test.setTimeout(120_000);
  const code = await mintInviteCode();
  try {
    await signInAsSuperAdmin(page);
    for (const path of ADMIN_PAGES) {
      await page.goto(path);
      const sections = page.getByTestId('admin-sections').getByRole('link');
      await expect(sections).toHaveCount(5);
      for (const s of await sections.all()) {
        const b = (await s.boundingBox())!;
        expect(b.x, path).toBeGreaterThanOrEqual(0);
        expect(b.x + b.width, path).toBeLessThanOrEqual(390);
        expect(b.height, path).toBeGreaterThanOrEqual(44);
      }
      for (const t of await tabs(page).all()) expect((await t.boundingBox())!.x + (await t.boundingBox())!.width).toBeLessThanOrEqual(390);
      await noSideways(page);
    }
    await page.goto('/admin/invites');
    await expect(page.getByTestId(`invite-${code}`)).toBeVisible();
    for (const id of [`invite-copy-code-${code}`, `invite-copy-link-${code}`, `revoke-${code}`]) {
      const b = (await page.getByTestId(id).boundingBox())!;
      expect(b.height, id).toBeGreaterThanOrEqual(44);
      expect(b.x, id).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width, id).toBeLessThanOrEqual(390);
    }
    expect(await page.locator('section[aria-label="Invite codes"] > div').first().evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(false);
    // Still a table to a screen reader.
    await expect(page.locator('section[aria-label="Invite codes"]').getByRole('row').first()).toBeAttached();
  } finally {
    await revokeInvite(code);
  }
});

test('C7-09e touch targets and no sideways scroll: the five admin pages', async ({ page }) => {
  test.setTimeout(150_000);
  await signInAsSuperAdmin(page);
  for (const path of ADMIN_PAGES) {
    await page.goto(path);
    await expect(page.getByTestId('admin-sections')).toBeVisible();
    await touchSweep(page, path);
  }
});
