import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { signUpFresh, runTag } from './helpers';
import { signInAsSuperAdmin } from './admin-helpers';
// `hydrated`, `LIVE` and `panel` are for the panel tests of Tasks 3 and 5 (they add them to this file).
/* eslint-disable @typescript-eslint/no-unused-vars */
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

/* eslint-enable @typescript-eslint/no-unused-vars */
