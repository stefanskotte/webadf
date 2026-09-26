import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { signUpFresh, runTag } from './helpers';
import { signInAsSuperAdmin } from './admin-helpers';
import { pairDevice, seedDisk, authHeader, cleanupSeeded } from './device-helpers';

/**
 * The header's drive chips (HANDOFF §4 backlog; src/components/shell/drive-chips.tsx).
 *
 * Every state is driven the way a real board drives it -- a mount through the
 * app's own route, then /api/device/status reporting what the board holds --
 * so "mounted" here means what it means in production: the board SAID so.
 * Only "online" and "offline" are written straight into the row, the same
 * shortcut devices-page.spec.ts takes, because waiting a real minute for a
 * board to go quiet proves nothing extra about the chip.
 */

test.afterAll(cleanupSeeded);

// LiveRefresh's 3 s tick plus a request and a re-render.
const LIVE = { timeout: 8_000 };

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function setDevice(deviceId: string, patch: Partial<typeof devices.$inferInsert>) {
  await getDb().update(devices).set(patch).where(eq(devices.id, deviceId));
}

/**
 * A paired board, online, carrying `name` as its alias. Register gives every
 * board the default "Device <MAC>" name whatever the pairing call asked for,
 * so the alias is written here, the way the rename route would.
 */
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

const chip = (page: Page, id: string) => page.getByTestId(`drive-chip-${id}`);
const menu = (page: Page, id: string) => page.getByTestId(`drive-chip-menu-${id}`);

test('a fresh org with no paired devices renders no chip and no Drives control', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/library');
  await expect(page.getByTestId('wordmark-home')).toBeVisible();
  await expect(page.getByTestId('drive-chips')).toHaveCount(0);
  await expect(page.getByTestId('drives-compact')).toHaveCount(0);
});

test('an empty board: the chip shows its name and "empty", and the menu is reachable by keyboard with every action off',
  async ({ page, request }) => {
    await signUpFresh(page);
    const { deviceId } = await onlineBoard(page, request, 'Bench');
    await page.goto('/library');

    const c = chip(page, deviceId);
    await expect(c).toBeVisible();
    await expect(page.getByTestId(`drive-chip-name-${deviceId}`)).toHaveText('Bench');
    await expect(page.getByTestId(`drive-chip-disk-${deviceId}`)).toHaveText('empty');
    await expect(c).toHaveAttribute('data-online', 'true');
    await expect(c).toHaveAttribute('title', /Bench/);
    await expect(c).toHaveAttribute('aria-haspopup', 'menu');
    await expect(c).toHaveAttribute('aria-expanded', 'false');

    // Keyboard: focus, Enter opens, Escape closes.
    await c.focus();
    await page.keyboard.press('Enter');
    await expect(menu(page, deviceId)).toBeVisible();
    await expect(c).toHaveAttribute('aria-expanded', 'true');
    // Both values in words at the top of the menu: the alias and online.
    await expect(page.getByTestId(`drive-entry-status-${deviceId}`)).toHaveText('Online');
    await expect(page.getByTestId(`drive-entry-disk-${deviceId}`)).toHaveText('Empty');
    for (const action of ['goto', 'protect', 'eject']) {
      await expect(page.getByTestId(`drive-${action}-${deviceId}`)).toHaveAttribute('data-disabled', '');
    }
    await page.keyboard.press('Escape');
    await expect(menu(page, deviceId)).toHaveCount(0);
    await expect(c).toHaveAttribute('aria-expanded', 'false');

    // Click outside closes it too.
    await c.click();
    await expect(menu(page, deviceId)).toBeVisible();
    await page.mouse.click(700, 500);
    await expect(menu(page, deviceId)).toHaveCount(0);
  });

test('a mount shows as loading until the board reports it, then the chip names the disk and Go to disk navigates',
  async ({ page, request }) => {
    const { orgId } = await signUpFresh(page);
    const board = await onlineBoard(page, request, 'Bench');
    const tag = runTag();
    const disk = { sha256: sha(`chip-mount-${tag}`), ...(await seedDisk(orgId, { title: `Chipgame ${tag.slice(-5)}`, diskNo: 1, sha256: sha(`chip-mount-${tag}`) })) };
    await page.goto('/library');
    await expect(chip(page, board.deviceId)).toHaveAttribute('data-phase', 'empty');

    // Asked, not yet held: pending, never an optimistic success.
    const res = await page.request.post(`/api/devices/${board.deviceId}/mount`, { data: { diskId: disk.diskId } });
    const { version } = await res.json();
    await expect(chip(page, board.deviceId)).toHaveAttribute('data-phase', 'loading', LIVE);
    await expect(page.getByTestId(`drive-chip-disk-${board.deviceId}`)).toHaveText('loading…');

    // The board reports it: now, and only now, the chip names the disk.
    expect((await request.post('/api/device/status', {
      headers: authHeader(board.token),
      data: { mountedSha256: disk.sha256, mountedDiskId: disk.diskId, version },
    })).status()).toBe(204);
    await expect(chip(page, board.deviceId)).toHaveAttribute('data-phase', 'loaded', LIVE);
    await expect(page.getByTestId(`drive-chip-disk-${board.deviceId}`)).toHaveText(`Chipgame ${tag.slice(-5)}`);
    // Seeded disks are protected by default: the tag says so in words.
    await expect(page.getByTestId(`drive-chip-wp-${board.deviceId}`)).toHaveText('WP');

    await chip(page, board.deviceId).click();
    await page.getByTestId(`drive-goto-${board.deviceId}`).click();
    await expect(page).toHaveURL(new RegExp(`/games/${disk.gameId}$`));
    await expect(page.getByTestId(`disk-${disk.diskId}`)).toBeVisible();
  });

test('the write-protect item flips the DISK between Protected and Writable', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const board = await onlineBoard(page, request, 'Bench');
  const tag = runTag();
  const s = sha(`chip-wp-${tag}`);
  const disk = { sha256: s, ...(await seedDisk(orgId, { title: `Wp ${tag.slice(-5)}`, diskNo: 1, sha256: s })) };
  await mountAndConverge(page, request, board, disk);
  await page.goto('/library');

  const wpTag = page.getByTestId(`drive-chip-wp-${board.deviceId}`);
  const item = page.getByTestId(`drive-protect-${board.deviceId}`);
  await expect(wpTag).toHaveText('WP');

  await chip(page, board.deviceId).click();
  await expect(item).toContainText('Disk is Protected');
  await expect(item).toHaveAttribute('data-protected', 'true');
  await item.click();
  await expect(wpTag).toHaveText('RW', LIVE);

  await chip(page, board.deviceId).click();
  await expect(item).toContainText('Disk is Writable');
  await expect(item).toHaveAttribute('data-protected', 'false');
  await item.click();
  await expect(wpTag).toHaveText('WP', LIVE);

  // It is the disk's own flag -- the game page's toggle agrees.
  await page.goto(`/games/${disk.gameId}`);
  await expect(page.getByTestId(`wp-${disk.diskId}`)).toHaveAttribute('data-protected', 'true');
});

test('eject reads "ejecting…" until the board reports the drive empty', async ({ page, request }) => {
  test.setTimeout(60_000);
  const { orgId } = await signUpFresh(page);
  const board = await onlineBoard(page, request, 'Bench');
  const tag = runTag();
  const s = sha(`chip-eject-${tag}`);
  const disk = { sha256: s, ...(await seedDisk(orgId, { title: `Ej ${tag.slice(-5)}`, diskNo: 1, sha256: s })) };
  await mountAndConverge(page, request, board, disk);
  await page.goto('/library');
  await expect(chip(page, board.deviceId)).toHaveAttribute('data-phase', 'loaded');

  await chip(page, board.deviceId).click();
  await page.getByTestId(`drive-eject-${board.deviceId}`).click();
  await expect(chip(page, board.deviceId)).toHaveAttribute('data-phase', 'ejecting', LIVE);
  await expect(page.getByTestId(`drive-chip-disk-${board.deviceId}`)).toHaveText('ejecting…');

  // Not optimistic: a couple of live ticks later, with the board silent, it
  // is STILL ejecting -- the drive is empty only when the board says so.
  await page.waitForTimeout(7_000);
  await expect(chip(page, board.deviceId)).toHaveAttribute('data-phase', 'ejecting');

  expect((await request.post('/api/device/status', {
    headers: authHeader(board.token), data: { mountedSha256: null, mountedDiskId: null },
  })).status()).toBe(204);
  await expect(chip(page, board.deviceId)).toHaveAttribute('data-phase', 'empty', LIVE);
  await expect(page.getByTestId(`drive-chip-disk-${board.deviceId}`)).toHaveText('empty');
});

test('an offline board is shown offline on the chip and in its menu, and can still be ejected', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const board = await onlineBoard(page, request, 'Attic');
  const tag = runTag();
  const s = sha(`chip-off-${tag}`);
  const disk = { sha256: s, ...(await seedDisk(orgId, { title: `Off ${tag.slice(-5)}`, diskNo: 1, sha256: s })) };
  await mountAndConverge(page, request, board, disk);
  // Well past STALE_AFTER_MS (60 s).
  await setDevice(board.deviceId, { lastSeenAt: new Date(Date.now() - 60 * 60_000) });
  await page.goto('/library');

  const c = chip(page, board.deviceId);
  await expect(c).toHaveAttribute('data-online', 'false');
  await expect(c).toHaveAttribute('title', /offline/);
  await expect(c.getByText('Offline')).toBeAttached(); // the screen-reader word beside the hollow ring
  await c.click();
  await expect(page.getByTestId(`drive-entry-status-${board.deviceId}`)).toHaveText('Offline');
  await expect(page.getByTestId(`drive-eject-${board.deviceId}`)).not.toHaveAttribute('data-disabled', '');
});

test('at 1280 the chips stay between the wordmark and the centred pill, and "+k" lists the boards without a chip',
  async ({ page, request }) => {
    test.setTimeout(60_000);
    await signUpFresh(page);
    // Long names on purpose: the widest a chip gets is what has to fit.
    const names = ['Alpha living room A1200', 'Bravo workbench A500', 'Charlie attic CDTV', 'Delta spare'];
    const ids: string[] = [];
    for (const n of names) ids.push((await onlineBoard(page, request, n)).deviceId);
    await page.goto('/library');

    // One chip at 1280 (measured, see chipSlots), the first by name.
    await expect(chip(page, ids[0])).toBeVisible();
    for (const id of ids.slice(1)) await expect(chip(page, id)).toBeHidden();
    const more = page.getByTestId('drive-chip-more');
    await expect(more).toBeVisible();
    // The number is CSS-switched per breakpoint; only this width's is shown.
    await expect(more.locator('span:visible')).toHaveText('+3');

    const wordmark = (await page.getByTestId('wordmark-home').boundingBox())!;
    const pill = (await page.locator('nav').boundingBox())!;
    const first = (await chip(page, ids[0]).boundingBox())!;
    const moreBox = (await more.boundingBox())!;
    expect(first.x).toBeGreaterThanOrEqual(wordmark.x + wordmark.width);
    expect(moreBox.x + moreBox.width).toBeLessThan(pill.x);

    await more.click();
    const list = page.getByTestId('drive-chip-more-menu');
    await expect(list).toBeVisible();
    for (const id of ids.slice(1)) await expect(page.getByTestId(`drive-entry-${id}`)).toBeVisible();
    await expect(page.getByTestId(`drive-entry-${ids[0]}`)).toHaveCount(0);
  });

/**
 * The chip group's gaps: wordmark-right to the first visible chip, and the
 * last visible chip (or "+k") to the pill's left edge.
 */
async function chipGaps(page: Page) {
  return page.evaluate(() => {
    const wm = document.querySelector('[data-testid=wordmark-home]')!.getBoundingClientRect();
    const pill = document.querySelector('header nav')!.getBoundingClientRect();
    const kids = [...document.querySelector('[data-testid=drive-chips]')!.children]
      .map((c) => c.getBoundingClientRect()).filter((r) => r.width > 0);
    return {
      left: Math.min(...kids.map((r) => r.left)) - wm.right,
      right: pill.left - Math.max(...kids.map((r) => r.right)),
    };
  });
}

test('the chips are centred between the wordmark and the pill, and stay centred when the pill changes width',
  async ({ page, request }) => {
    test.setTimeout(60_000);
    await signUpFresh(page);
    for (const n of ['Alpha living room A1200', 'Bravo workbench A500', 'Charlie attic CDTV', 'Delta spare']) {
      await onlineBoard(page, request, n);
    }
    for (const width of [1280, 1920]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/library');
      await expect(page.getByTestId('drive-chip-more')).toBeVisible();
      const g = await chipGaps(page);
      expect(Math.abs(g.left - g.right), `gaps at ${width}: ${JSON.stringify(g)}`).toBeLessThanOrEqual(4);
      expect(g.left).toBeGreaterThanOrEqual(16);
      expect(g.right).toBeGreaterThanOrEqual(16);
    }

    // The pill's width is MEASURED, not assumed: widen it (as the Admin item
    // or a longer label would) and the group re-centres on the new edge.
    const before = await chipGaps(page);
    await page.locator('header nav').evaluate((n: HTMLElement) => { n.style.paddingInline = '60px'; });
    await expect.poll(async () => {
      const g = await chipGaps(page);
      return Math.abs(g.left - g.right) <= 4 && g.right < before.right - 20;
    }).toBe(true);
  });

test('at 390px one Drives control on the top line lists every board, and nothing overflows', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signUpFresh(page);
  const a = await onlineBoard(page, request, 'Phone A');
  const b = await onlineBoard(page, request, 'Phone B');
  await page.goto('/library');

  // No chip in the fixed bottom bar, and no desktop chips at all.
  await expect(page.getByTestId('drive-chips')).toBeHidden();
  await expect(page.locator('nav [data-testid^=drive]')).toHaveCount(0);

  const compact = page.getByTestId('drives-compact');
  await expect(compact).toBeVisible();
  await expect(compact).toContainText('Drives');
  await expect(compact).toContainText('2');

  // On the wordmark's line, clear of it, and clear of the search box below.
  const wordmark = (await page.getByTestId('wordmark-home').boundingBox())!;
  const trigger = (await compact.boundingBox())!;
  const search = (await page.locator('header input').boundingBox())!;
  expect(trigger.x).toBeGreaterThanOrEqual(wordmark.x + wordmark.width);
  expect(Math.abs((trigger.y + trigger.height / 2) - (wordmark.y + wordmark.height / 2))).toBeLessThan(8);
  expect(trigger.y + trigger.height).toBeLessThanOrEqual(search.y);

  await compact.click();
  const list = page.getByTestId('drives-compact-menu');
  await expect(list).toBeVisible();
  await expect(page.getByTestId(`drive-entry-${a.deviceId}`)).toBeVisible();
  await expect(page.getByTestId(`drive-entry-${b.deviceId}`)).toBeVisible();
  // Base UI does not clamp a popup back on screen (HANDOFF §3t): measured.
  const box = (await list.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  // An item is finger-sized -- polled, because the popup opens with a
  // zoom-in-95 animation and a box read mid-animation is 95% of the truth.
  await expect.poll(async () => (await page.getByTestId(`drive-eject-${a.deviceId}`).boundingBox())!.height)
    .toBeGreaterThanOrEqual(32);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('the admin plane never renders the chips', async ({ page, request }) => {
  await signInAsSuperAdmin(page);
  const { deviceId } = await onlineBoard(page, request, 'Admin bench');
  await page.goto('/library');
  await expect(chip(page, deviceId)).toBeVisible();

  await page.goto('/admin');
  await expect(page).toHaveURL(/\/admin/);
  await expect(page.locator('[data-testid^=drive-chip]')).toHaveCount(0);
  await expect(page.getByTestId('drives-compact')).toHaveCount(0);
});
