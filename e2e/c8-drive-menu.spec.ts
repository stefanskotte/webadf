import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { signUpFresh, runTag } from './helpers';
import { signInAsSuperAdmin } from './admin-helpers';
import { pairDevice, seedDisk, addDisk, authHeader, cleanupSeeded, hydrated } from './device-helpers';

/**
 * Phase C8 (spec 2026-10-26-phase-c8-drive-menu-design.md §9.5): the header drive chip and its panel, measured.
 * Every state is driven the way a real board drives it (a mount through the app, then /api/device/status); only
 * online/offline is written into the row, as drive-chips.spec does. The DB is the live one: every assertion is about
 * rows the test made. Names are C8-NN so batches can select them with -g.
 */
test.afterAll(cleanupSeeded);

// LiveRefresh's 3 s tick plus a request and a re-render.
const LIVE = { timeout: 8_000 };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function setDevice(deviceId: string, patch: Partial<typeof devices.$inferInsert>) {
  await getDb().update(devices).set(patch).where(eq(devices.id, deviceId));
}

/** A paired board, online, carrying `name` as its alias (register names every board "Device <MAC>"). */
async function onlineBoard(page: Page, request: APIRequestContext, name: string) {
  const board = await pairDevice(page, request, name);
  await setDevice(board.deviceId, { name, lastSeenAt: new Date() });
  return board;
}

/** Mount through the app, then have the board report it holds the disk. */
async function mountAndConverge(
  page: Page, request: APIRequestContext,
  board: { deviceId: string; token: string }, disk: { diskId: string; sha256: string },
) {
  const res = await page.request.post(`/api/devices/${board.deviceId}/mount`, { data: { diskId: disk.diskId } });
  expect(res.status()).toBe(200);
  const { version } = await res.json();
  expect((await request.post('/api/device/status', {
    headers: authHeader(board.token),
    data: { mountedSha256: disk.sha256, mountedDiskId: disk.diskId, version },
  })).status()).toBe(204);
}

/** A board named `name`, online, that reported holding disk 1 of a `disks`-disk title (protected, seedDisk's default). */
async function loadedBoard(page: Page, request: APIRequestContext, orgId: string, name: string, disks = 2) {
  const board = await onlineBoard(page, request, name);
  const tag = runTag();
  const title = `C8 ${name} ${tag.slice(-5)}`;
  const s1 = sha(`c8-${tag}-1`);
  const { gameId, diskId } = await seedDisk(orgId, { title, diskNo: 1, sha256: s1 });
  for (let n = 2; n <= disks; n++) await addDisk(orgId, gameId, { diskNo: n, sha256: sha(`c8-${tag}-${n}`) });
  await mountAndConverge(page, request, board, { diskId, sha256: s1 });
  return { ...board, title, gameId, diskId, sha256: s1 };
}

const chip = (page: Page, id: string) => page.getByTestId(`drive-chip-${id}`);
const panel = (page: Page, id: string) => page.getByTestId(`drive-chip-menu-${id}`);

// ---- The chip (spec §2, §2.1) ---------------------------------------------------------------------------------

test('C8-01a the chip at 1280: 40 px, the whole name at 14 px / 600, the disk in 13 px mono, the WP tag, no "n/N"', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const b = await loadedBoard(page, request, orgId, 'WifiFloppy1', 2);
  await page.goto('/library');
  const c = chip(page, b.deviceId);
  await expect(c).toHaveAttribute('data-phase', 'loaded');
  const box = (await c.boundingBox())!;
  expect(Math.abs(box.height - 40), `height ${box.height}`).toBeLessThanOrEqual(0.5);
  expect(box.width).toBeLessThanOrEqual(240.5);
  const name = page.getByTestId(`drive-chip-name-${b.deviceId}`);
  await expect(name).toHaveText('WifiFloppy1');
  await expect(name).toHaveCSS('font-size', '14px');
  await expect(name).toHaveCSS('font-weight', '600');
  // Whole, not "WifiFlop…" (spec §1: today's 3.5rem cap cut it).
  expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const disk = page.getByTestId(`drive-chip-disk-${b.deviceId}`);
  await expect(disk).toHaveText(b.title);
  await expect(disk).toHaveCSS('font-size', '13px');
  await expect(disk).toHaveClass(/font-mono/);
  const wp = page.getByTestId(`drive-chip-wp-${b.deviceId}`);
  await expect(wp).toHaveText('WP');
  await expect(wp).toHaveCSS('font-size', '11px');
  await expect(c).toContainText('write-protected');
  expect(await c.evaluate((el: HTMLElement) => el.innerText)).not.toMatch(/\d+\s*\/\s*\d+/);
});

test('C8-11 the super-admin with two boards: the compact control at 1280, one chip and "+k" from 1536', async ({ page, request }) => {
  test.setTimeout(90_000);
  await signInAsSuperAdmin(page);
  const ids: string[] = [];
  // The super-admin's org outlives this test: its boards go at the end of THIS test (cleanupSeeded removes disks).
  try {
    for (const n of ['Aaaa C8 admin one', 'Aaab C8 admin two']) ids.push((await onlineBoard(page, request, n)).deviceId);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/library');
    await expect(page.getByTestId('drives-compact')).toBeVisible();
    await expect(page.getByTestId('drive-chips')).toBeHidden();
    for (const id of ids) await expect(chip(page, id)).toBeHidden();
    await page.setViewportSize({ width: 1536, height: 800 });
    await page.goto('/library');
    await expect(page.getByTestId('drives-compact')).toBeHidden();
    await expect(chip(page, ids[0])).toBeVisible();
    await expect(page.getByTestId('drive-chip-more')).toBeVisible();
  } finally {
    if (ids.length) await getDb().delete(devices).where(inArray(devices.id, ids));
  }
});

// ---- The panel (spec §3-§7) ----------------------------------------------------------------------------------

async function openPanel(page: Page, id: string) {
  await hydrated(page, `drive-chip-${id}`);
  await chip(page, id).click();
  await expect(panel(page, id)).toBeVisible();
}

/** Count `method` requests whose path matches `path`, from now on. */
function countRequests(page: Page, method: string, path: RegExp) {
  const seen = { n: 0 };
  page.on('request', (r) => { if (r.method() === method && path.test(new URL(r.url()).pathname)) seen.n++; });
  return seen;
}

/** Hold every `method` request to `glob` for `ms`, so a second press lands while the first is in flight. */
async function slow(page: Page, glob: string, method: string, ms = 1_200) {
  await page.route(glob, async (route) => {
    if (route.request().method() !== method) return route.continue();
    await new Promise((r) => setTimeout(r, ms));
    await route.continue();
  });
}

/** A point in the header just right of the wordmark, where nothing focusable is (checked, not assumed). */
async function blankHeaderPoint(page: Page) {
  const wm = (await page.getByTestId('wordmark-home').boundingBox())!;
  const p = { x: Math.round(wm.x + wm.width + 6), y: Math.round(wm.y + wm.height / 2) };
  expect(await page.evaluate(({ x, y }) =>
    !document.elementFromPoint(x, y)?.closest('a,button,input,select,textarea,[tabindex]'), p), 'a blank point').toBe(true);
  return p;
}

test('C8-01b the panel at 1280: 440 px, "Controlling" and "Manage devices", and the board\'s card', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const b = await loadedBoard(page, request, orgId, 'WifiFloppy1', 2);
  await page.goto('/library');
  await openPanel(page, b.deviceId);
  const p = panel(page, b.deviceId);
  await expect(p).toHaveAttribute('role', 'dialog');
  await expect(p).toHaveAccessibleName('WifiFloppy1 drive');
  await expect(chip(page, b.deviceId)).toHaveAttribute('aria-haspopup', 'dialog');
  await expect.poll(async () => Math.round((await p.boundingBox())!.width)).toBe(440);
  await expect(p).toContainText('Controlling');
  const manage = page.getByTestId('drive-panel-manage');
  await expect(manage).toHaveText('Manage devices');
  await expect(manage).toHaveAttribute('href', '/devices');
  const entry = page.getByTestId(`drive-entry-${b.deviceId}`);
  await expect(entry).toHaveAccessibleName('WifiFloppy1 controls');
  await expect(entry.locator('svg').first()).toBeVisible();                      // the disk icon
  await expect(entry).toContainText('WifiFloppy1 · DF0');
  await expect(page.getByTestId(`drive-entry-disk-${b.deviceId}`)).toHaveText(`${b.title} · disk 1 of 2`);
  await expect(page.getByTestId(`drive-entry-status-${b.deviceId}`)).toHaveText('Online');
  await expect(page.getByTestId(`drive-protect-${b.deviceId}`)).toHaveAttribute('role', 'switch');
  await expect(page.getByTestId(`drive-next-${b.deviceId}`)).toHaveText('Next: disk 2');
  await expect(page.getByTestId(`drive-eject-${b.deviceId}`)).toHaveText('Eject');
  await expect(page.getByTestId(`drive-settings-${b.deviceId}`)).toHaveAccessibleName('WifiFloppy1 board settings');
  // Hover (desktop only: the mobile project never hovers): Manage devices underlines.
  await manage.hover();
  await expect(manage).toHaveCSS('text-decoration-line', 'underline');
  await manage.click();
  await expect(page).toHaveURL(/\/devices$/);
  await expect(p).toHaveCount(0);
});

test('C8-02 a one-disk title reads "disk 1 of 1", and offers no Next', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const b = await loadedBoard(page, request, orgId, 'Single', 1);
  await page.goto('/library');
  await openPanel(page, b.deviceId);
  await expect(page.getByTestId(`drive-entry-disk-${b.deviceId}`)).toHaveText(`${b.title} · disk 1 of 1`);
  await expect(page.getByTestId(`drive-next-${b.deviceId}`)).toHaveCount(0);
});

test('C8-03 Write-protect: one PATCH on a double press, busy while it runs, flipped by the refresh, panel and focus kept', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const b = await loadedBoard(page, request, orgId, 'Bench', 1);
  await page.goto('/library');
  const patches = countRequests(page, 'PATCH', /^\/api\/disks\/[^/]+$/);
  await slow(page, '**/api/disks/*', 'PATCH');
  await openPanel(page, b.deviceId);
  const sw = page.getByTestId(`drive-protect-${b.deviceId}`);
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await sw.dblclick();
  await expect(sw).toHaveAttribute('aria-busy', 'true');
  await expect(sw).toHaveAttribute('aria-disabled', 'true');
  await expect(sw).toHaveAttribute('aria-checked', 'false', LIVE);
  await expect(sw).not.toHaveAttribute('aria-busy', 'true');
  expect(patches.n).toBe(1);
  await expect(panel(page, b.deviceId)).toBeVisible();
  await expect(sw).toBeFocused();
  await expect(page.getByTestId(`drive-chip-wp-${b.deviceId}`)).toHaveText('RW');
});

test('C8-04 Eject: "Ejecting…" while it runs, one POST on a double press, the panel stays, focus stays through empty', async ({ page, request }) => {
  test.setTimeout(60_000);
  const { orgId } = await signUpFresh(page);
  const b = await loadedBoard(page, request, orgId, 'Bench', 1);
  await page.goto('/library');
  const posts = countRequests(page, 'POST', /^\/api\/devices\/[^/]+\/eject$/);
  await slow(page, '**/api/devices/*/eject', 'POST');
  await openPanel(page, b.deviceId);
  const ej = page.getByTestId(`drive-eject-${b.deviceId}`);
  await ej.dblclick();
  await expect(ej).toHaveText('Ejecting…');
  await expect(ej).toHaveAttribute('aria-busy', 'true');
  await expect(chip(page, b.deviceId)).toHaveAttribute('data-phase', 'ejecting', LIVE);
  await expect(page.getByTestId(`drive-entry-disk-${b.deviceId}`)).toHaveText(`Ejecting ${b.title}…`);
  expect(posts.n).toBe(1);
  await expect(panel(page, b.deviceId)).toBeVisible();
  await expect(ej).toBeFocused();
  // The board reports the drive empty: Eject turns off under the focus, and the focus stays on it.
  expect((await request.post('/api/device/status', {
    headers: authHeader(b.token), data: { mountedSha256: null, mountedDiskId: null },
  })).status()).toBe(204);
  await expect(page.getByTestId(`drive-entry-disk-${b.deviceId}`)).toHaveText('Drive empty', LIVE);
  await expect(ej).toHaveAttribute('aria-disabled', 'true');
  await expect(ej).toBeFocused();
});

test('C8-05 Next: one POST on a double press; when the button goes with the loading refresh, focus is on Eject', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const b = await loadedBoard(page, request, orgId, 'Bench', 2);
  await page.goto('/library');
  const posts = countRequests(page, 'POST', /^\/api\/devices\/[^/]+\/next$/);
  await slow(page, '**/api/devices/*/next', 'POST');
  await openPanel(page, b.deviceId);
  const next = page.getByTestId(`drive-next-${b.deviceId}`);
  await expect(next).toHaveAccessibleName('Next: disk 2 of 2');
  await next.dblclick();
  await expect(next).toHaveText('Switching…');
  await expect(next).toHaveCount(0, LIVE);
  await expect(page.getByTestId(`drive-entry-disk-${b.deviceId}`)).toHaveText(`Loading ${b.title}…`);
  expect(posts.n).toBe(1);
  await expect(page.getByTestId(`drive-eject-${b.deviceId}`)).toBeFocused();
});

test('C8-06 a dropped connection: the toast, and neither Eject nor Write-protect is left busy (Review Focus 5)', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const b = await loadedBoard(page, request, orgId, 'Bench', 1);
  await page.goto('/library');
  await page.route('**/api/devices/*/eject', (r) => r.abort());
  await page.route('**/api/disks/*', (r) => (r.request().method() === 'PATCH' ? r.abort() : r.continue()));
  await openPanel(page, b.deviceId);
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'Could not reach the server' });
  const ej = page.getByTestId(`drive-eject-${b.deviceId}`);
  await ej.click();
  await expect(toast.first()).toBeVisible();
  await expect(ej).toHaveText('Eject');
  await expect(ej).not.toHaveAttribute('aria-busy', 'true');
  await expect(ej).not.toHaveAttribute('aria-disabled', 'true');
  const sw = page.getByTestId(`drive-protect-${b.deviceId}`);
  await sw.click();
  await expect(toast).toHaveCount(2);
  await expect(sw).not.toHaveAttribute('aria-busy', 'true');
  await expect(sw).not.toHaveAttribute('aria-disabled', 'true');
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect(panel(page, b.deviceId)).toBeVisible();
});

test('C8-08 focus: open -> the popup; Escape and a blank press -> the chip; the search field keeps its focus; Tab past the gear closes', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId } = await onlineBoard(page, request, 'Bench');
  await page.goto('/library');
  const c = chip(page, deviceId);
  const p = panel(page, deviceId);
  await hydrated(page, `drive-chip-${deviceId}`);

  await c.click();
  await expect(p).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(p).toHaveCount(0);
  await expect(c).toBeFocused();

  await c.click();
  const pt = await blankHeaderPoint(page);
  await page.mouse.click(pt.x, pt.y);
  await expect(p).toHaveCount(0);
  await expect(c).toBeFocused();

  // Review Focus 2: a press on the search field closes the panel and leaves the caret there.
  await c.click();
  await expect(p).toBeVisible();
  await page.getByTestId('search-input').click();
  await expect(p).toHaveCount(0);
  await expect(page.getByTestId('search-input')).toBeFocused();

  // Keyboard: Enter opens on the popup too; Tab walks the panel to the gear, and one more Tab leaves and closes it.
  await c.focus();
  await page.keyboard.press('Enter');
  await expect(p).toBeFocused();
  const gear = page.getByTestId(`drive-settings-${deviceId}`);
  for (let i = 0; i < 10 && !(await gear.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(gear).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(p).toHaveCount(0);
  expect(await page.evaluate(() => {
    const a = document.activeElement;
    return !!a && a !== document.body && !a.closest('[data-drive-panel]');
  })).toBe(true);
});

test('C8-09 live: the board goes offline under an open panel -> "Offline" and the line, panel open, focus unchanged', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const b = await loadedBoard(page, request, orgId, 'Attic', 1);
  await page.goto('/library');
  await openPanel(page, b.deviceId);
  await expect(panel(page, b.deviceId)).toBeFocused();
  await setDevice(b.deviceId, { lastSeenAt: new Date(Date.now() - 60 * 60_000) });
  await expect(page.getByTestId(`drive-entry-status-${b.deviceId}`)).toHaveText('Offline', LIVE);
  await expect(page.getByTestId(`drive-entry-offline-${b.deviceId}`))
    .toHaveText(/^Offline, last seen \d+[smhd] ago\. Changes reach it when it reconnects\.$/);
  await expect(panel(page, b.deviceId)).toBeVisible();
  await expect(panel(page, b.deviceId)).toBeFocused();
});

test('C8-10 two boards at 1280: the chip\'s panel is its board\'s card only; "+1" holds the other under one head row', async ({ page, request }) => {
  await signUpFresh(page);
  const a = await onlineBoard(page, request, 'Aa C8 first');
  const b = await onlineBoard(page, request, 'Ab C8 second');
  await page.goto('/library');
  await expect(chip(page, b.deviceId)).toBeHidden();
  const more = page.getByTestId('drive-chip-more');
  await expect(more.locator('span:visible')).toHaveText('+1');
  await openPanel(page, a.deviceId);
  await expect(panel(page, a.deviceId).locator('section[data-testid^="drive-entry-"]')).toHaveCount(1);
  await expect(panel(page, a.deviceId).getByTestId(`drive-entry-${a.deviceId}`)).toBeVisible();
  await page.keyboard.press('Escape');
  await hydrated(page, 'drive-chip-more');
  await more.click();
  const list = page.getByTestId('drive-chip-more-menu');
  await expect(list).toHaveAccessibleName('Drives');
  await expect(list.getByTestId('drive-panel-manage')).toHaveCount(1);
  await expect(list.locator('section[data-testid^="drive-entry-"]')).toHaveCount(1);
  await expect(list.getByTestId(`drive-entry-${b.deviceId}`)).toBeVisible();
});

test('C8-14 an offline board: every action allowed, and Eject sends its request', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const b = await loadedBoard(page, request, orgId, 'Attic', 2);
  await setDevice(b.deviceId, { lastSeenAt: new Date(Date.now() - 60 * 60_000) });
  await page.goto('/library');
  await openPanel(page, b.deviceId);
  for (const id of ['protect', 'next', 'eject']) {
    await expect(page.getByTestId(`drive-${id}-${b.deviceId}`)).not.toHaveAttribute('aria-disabled', 'true');
  }
  const posts = countRequests(page, 'POST', /^\/api\/devices\/[^/]+\/eject$/);
  await page.getByTestId(`drive-eject-${b.deviceId}`).click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Eject requested' }).first()).toBeVisible();
  expect(posts.n).toBe(1);
});

test('C8-16 the board is deleted while its panel is open: focus lands on the wordmark, not <body> (Review Focus 3)', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId } = await onlineBoard(page, request, 'Doomed');
  await page.goto('/library');
  await openPanel(page, deviceId);
  await expect(panel(page, deviceId)).toBeFocused();
  await getDb().delete(devices).where(eq(devices.id, deviceId));
  await expect(chip(page, deviceId)).toHaveCount(0, LIVE);
  await expect(page.getByTestId('wordmark-home')).toBeFocused();
});

test('C8-17 a live update that removes Next leaves focus on the popup, not on Eject (spec 6/7: live updates never move focus)', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const b = await loadedBoard(page, request, orgId, 'Bench', 2);
  await page.goto('/library');
  await openPanel(page, b.deviceId);
  await expect(panel(page, b.deviceId)).toBeFocused();
  await expect(page.getByTestId(`drive-next-${b.deviceId}`)).toBeVisible();
  expect((await page.request.post(`/api/devices/${b.deviceId}/eject`)).status()).toBeLessThan(300);
  await expect(page.getByTestId(`drive-next-${b.deviceId}`)).toHaveCount(0, LIVE);
  await expect(page.getByTestId(`drive-entry-disk-${b.deviceId}`)).toContainText('Ejecting');
  await page.waitForTimeout(500);
  await expect(page.getByTestId(`drive-eject-${b.deviceId}`)).not.toBeFocused();
  await expect(panel(page, b.deviceId)).toBeFocused();
});

test('C8-07 the gear opens the board\'s Board settings on /devices, strips the URL, works again from /devices, and a foreign id opens nothing', async ({ page, request }) => {
  test.setTimeout(60_000);
  await signUpFresh(page);
  const { deviceId } = await onlineBoard(page, request, 'Bench');
  await page.goto('/library');
  await openPanel(page, deviceId);
  const gear = page.getByTestId(`drive-settings-${deviceId}`);
  await expect(gear).toHaveAttribute('href', `/devices?settings=${deviceId}`);
  await gear.click();
  const dialog = page.getByTestId('board-settings-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('data-device-id', deviceId);
  await expect(page).toHaveURL(new RegExp(`/devices#device-${deviceId}$`));
  expect(page.url()).not.toContain('settings=');
  await page.getByTestId('board-settings-cancel').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId(`board-settings-${deviceId}`)).toBeFocused();

  // Review Focus 1: the same gear again, from /devices, after the strip.
  await openPanel(page, deviceId);
  await page.getByTestId(`drive-settings-${deviceId}`).click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('data-device-id', deviceId);
  expect(page.url()).not.toContain('settings=');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId(`board-settings-${deviceId}`)).toBeFocused();

  // An id that is not this org's: nothing opens and the parameter goes.
  await page.goto('/devices?settings=dev_not_this_orgs');
  await expect(page).toHaveURL(/\/devices$/);
  await page.waitForTimeout(1_000);
  await expect(dialog).toHaveCount(0);
});

/** Where the header's pieces sit at this width: the clamp is the pill's scroll box (the nav's parent). */
async function headerMetrics(page: Page) {
  return page.evaluate(() => {
    const header = document.querySelector<HTMLElement>('[data-testid="app-header"]')!;
    const nav = header.querySelector('nav')!;
    const clamp = nav.parentElement!.getBoundingClientRect();
    const search = header.querySelector('[data-testid="search-input"]')!.getBoundingClientRect();
    const trigger = header.querySelector('[data-testid="drives-compact"]');
    const compact = trigger?.getBoundingClientRect() ?? null;
    const tabs = [...nav.querySelectorAll('a')].filter((a) => a.offsetWidth > 0).map((a) => a.getBoundingClientRect());
    // The compact face: every visible child (and its visible descendants) ends inside the trigger's border box.
    const spill = trigger && compact
      ? [trigger, ...trigger.querySelectorAll('*')].filter((el) => el !== trigger && (el as HTMLElement | SVGElement).getBoundingClientRect().width > 0
          && getComputedStyle(el).display !== 'none' && !el.classList.contains('sr-only'))
          .map((el) => (el as Element).getBoundingClientRect().right - compact.right).filter((d) => d > 0.5)
      : [];
    return {
      clampL: clamp.left, clampR: clamp.right, searchL: search.left, compactR: compact?.right ?? 0, compactW: compact?.width ?? 0,
      clipped: tabs.filter((t) => t.left < clamp.left - 0.5 || t.right > clamp.right + 0.5).length,
      navFits: nav.scrollWidth <= nav.clientWidth && clamp.width >= nav.scrollWidth - 0.5, navW: nav.scrollWidth, clampW: clamp.width, spill,
      chevronR: trigger?.querySelector('svg')?.getBoundingClientRect().right ?? 0,
    };
  });
}

test('C8-17 one board, long name and title, protected, at 1024 with a 15 px classic scrollbar (a 1009 px layout), 1024 and 1180: the compact chip leaves the pill whole, clear of search, and its face stays inside its own box', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  await loadedBoard(page, request, orgId, 'A rather long board name', 1);   // protected: the WP tag exists
  for (const [width, scrollbar] of [[1024, 15], [1024, 0], [1180, 0]] as const) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/library');
    await expect(page.getByTestId('drives-compact-name')).toBeVisible();
    // A classic scrollbar takes 15 px of the layout width but leaves the media query at 1024; headless draws overlay
    // scrollbars, so the same layout is made by narrowing the root (the header is sticky/in flow, not fixed).
    if (scrollbar) await page.addStyleTag({ content: `html { width: ${1024 - scrollbar}px; }` });
    if (scrollbar) expect(await page.evaluate(() => document.querySelector('[data-testid="app-header"]')!.getBoundingClientRect().width)).toBe(1024 - scrollbar);
    await page.waitForTimeout(150);   // HeaderStart's ResizeObserver settles on the real pill
    const m = await headerMetrics(page);
    const note = `${width} (scrollbar ${scrollbar}): ${JSON.stringify(m)}`;
    expect(m.clampR, `pill under the search box ${note}`).toBeLessThanOrEqual(m.searchL + 0.5);
    expect(m.clampL, `pill into the chip ${note}`).toBeGreaterThanOrEqual(m.compactR - 0.5);
    expect(m.clipped, `a tab is clipped ${note}`).toBe(0);
    expect(m.navFits, `the nav scrolls ${note}`).toBe(true);
    expect(m.chevronR, `the chevron past the border ${note}`).toBeLessThanOrEqual(m.compactR + 0.5);
    expect(m.spill, `a visible child past the border ${note}`).toEqual([]);
    // Between lg and xl the face is the dot, the name and the chevron: no disk text, no tag.
    await expect(page.getByTestId('drives-compact-disk')).toBeHidden();
    await expect(page.getByTestId('drives-compact-wp')).toBeHidden();
  }
});

test('C8-17 the super-admin with one board at 1100 and 1180: the pill with Admin does not overflow and clears search', async ({ page, request }) => {
  await signInAsSuperAdmin(page);
  await pairDevice(page, request, 'Admin one');
  for (const width of [1100, 1180]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/library');
    await expect(page.getByRole('link', { name: 'Admin' })).toHaveCount(1);
    await page.waitForTimeout(150);
    const m = await headerMetrics(page);
    const note = `${width}: ${JSON.stringify(m)}`;
    expect(m.clampR, `pill under the search box ${note}`).toBeLessThanOrEqual(m.searchL + 0.5);
    expect(m.navFits, `the nav scrolls ${note}`).toBe(true);
    expect(m.clipped, `a tab is clipped ${note}`).toBe(0);
  }
});
