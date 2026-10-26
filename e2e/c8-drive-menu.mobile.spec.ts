import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { signUpFresh, runTag } from './helpers';
import { pairDevice, seedDisk, addDisk, authHeader, cleanupSeeded, hydrated } from './device-helpers';

/**
 * Phase C8 on a phone (spec §8, §9.5 C8-12, C8-13): the `mobile` project (390 x 844, touch). Touch never hovers, so
 * nothing here asserts a hover style. The DB is the live one: every assertion is about rows the test made.
 */
test.afterAll(cleanupSeeded);

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function onlineBoard(page: Page, request: APIRequestContext, name: string) {
  const board = await pairDevice(page, request, name);
  await getDb().update(devices).set({ name, lastSeenAt: new Date() }).where(eq(devices.id, board.deviceId));
  return board;
}

async function loadedBoard(page: Page, request: APIRequestContext, orgId: string, name: string, disks = 2) {
  const board = await onlineBoard(page, request, name);
  const tag = runTag();
  const title = `C8 ${name} ${tag.slice(-5)}`;
  const s1 = sha(`c8m-${tag}-1`);
  const { gameId, diskId } = await seedDisk(orgId, { title, diskNo: 1, sha256: s1 });
  for (let n = 2; n <= disks; n++) await addDisk(orgId, gameId, { diskNo: n, sha256: sha(`c8m-${tag}-${n}`) });
  const res = await page.request.post(`/api/devices/${board.deviceId}/mount`, { data: { diskId } });
  expect(res.status()).toBe(200);
  const { version } = await res.json();
  expect((await request.post('/api/device/status', {
    headers: authHeader(board.token), data: { mountedSha256: s1, mountedDiskId: diskId, version },
  })).status()).toBe(204);
  return { ...board, title };
}

const noSideways = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
/** The fixed bottom bar: nav -> clamp -> bar (C7). */
const bar = (page: Page) => page.getByRole('navigation', { name: 'Main' }).locator('xpath=../..');

async function openCompact(page: Page) {
  await hydrated(page, 'drives-compact');
  await page.getByTestId('drives-compact').tap();
  await expect(page.getByTestId('drives-compact-menu')).toBeVisible();
}

test('C8-12 one board at 390: the compact control is the board\'s chip; the panel fits, stops above the bar, 44 px targets', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const b = await loadedBoard(page, request, orgId, 'C8 Phone board', 2);
  await page.goto('/library');
  const compact = page.getByTestId('drives-compact');
  await expect(page.getByTestId('drives-compact-name')).toHaveText('C8 Phone board');
  await expect(page.getByTestId('drives-compact-disk')).toHaveText(b.title);
  await expect(page.getByTestId('drives-compact-wp')).toHaveText('WP');
  expect((await compact.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  await openCompact(page);
  const p = page.getByTestId('drives-compact-menu');
  await expect.poll(async () => {
    const box = (await p.boundingBox())!;
    return box.width <= 358.5 && box.x >= 15.5 && box.x + box.width <= 390 - 15.5;
  }, { message: 'panel inside the 16 px gutters' }).toBe(true);
  const barTop = (await bar(page).boundingBox())!.y;
  const pb = (await p.boundingBox())!;
  expect(pb.y + pb.height, 'the panel ends above the tab bar').toBeLessThanOrEqual(barTop + 0.5);
  for (const id of ['drive-panel-manage', `drive-protect-${b.deviceId}`, `drive-next-${b.deviceId}`,
    `drive-eject-${b.deviceId}`, `drive-settings-${b.deviceId}`]) {
    await expect.poll(async () => (await page.getByTestId(id).boundingBox())!.height, { message: id }).toBeGreaterThanOrEqual(44);
  }
  expect((await page.getByTestId(`drive-settings-${b.deviceId}`).boundingBox())!.width).toBeGreaterThanOrEqual(44);
  await noSideways(page);
});

test('C8-13 two boards at 390: "Drives 2", two cards under one head row, and the panel scrolls inside itself when short', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 560 });
  const { orgId } = await signUpFresh(page);
  const a = await loadedBoard(page, request, orgId, 'C8 Phone A', 2);
  const b = await loadedBoard(page, request, orgId, 'C8 Phone B', 2);
  await page.goto('/library');
  const compact = page.getByTestId('drives-compact');
  await expect(compact).toContainText('Drives');
  await expect(compact).toContainText('2');
  await expect(page.getByTestId('drives-compact-name')).toHaveCount(0);
  await openCompact(page);
  const p = page.getByTestId('drives-compact-menu');
  await expect(p.getByTestId('drive-panel-manage')).toHaveCount(1);
  await expect(p.locator('section[data-testid^="drive-entry-"]')).toHaveCount(2);
  for (const id of [a.deviceId, b.deviceId]) await expect(p.getByTestId(`drive-entry-${id}`)).toBeAttached();
  expect(await p.evaluate((el) => el.scrollHeight > el.clientHeight), 'taller than the room: it scrolls').toBe(true);
  const barTop = (await bar(page).boundingBox())!.y;
  const pb = (await p.boundingBox())!;
  expect(pb.y + pb.height).toBeLessThanOrEqual(barTop + 0.5);
  await p.getByTestId(`drive-eject-${b.deviceId}`).scrollIntoViewIfNeeded();
  await expect(p.getByTestId(`drive-eject-${b.deviceId}`)).toBeInViewport();
  await noSideways(page);
});

test('C8-18 a long title at 390: the title truncates, "disk n of N" stays whole on the disk line', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const board = await onlineBoard(page, request, 'C8 Phone long');
  const tag = runTag();
  const s1 = sha(`c8m18-${tag}`);
  const { gameId, diskId } = await seedDisk(orgId, { title: `A very long title that cannot fit a phone panel ${tag.slice(-5)}`, diskNo: 1, sha256: s1 });
  await addDisk(orgId, gameId, { diskNo: 2, sha256: sha(`c8m18-${tag}-2`) });
  const res = await page.request.post(`/api/devices/${board.deviceId}/mount`, { data: { diskId } });
  const { version } = await res.json();
  expect((await request.post('/api/device/status', {
    headers: authHeader(board.token), data: { mountedSha256: s1, mountedDiskId: diskId, version },
  })).status()).toBe(204);
  await page.goto('/library');
  await openCompact(page);
  const line = page.getByTestId(`drive-entry-disk-${board.deviceId}`);
  await expect(line).toContainText('disk 1 of 2');
  const m = await line.evaluate((el) => {
    const [title, count] = Array.from(el.children) as HTMLElement[];
    return { titleClipped: title.scrollWidth > title.clientWidth, countRight: count.getBoundingClientRect().right,
      countWidth: count.getBoundingClientRect().width, countScroll: count.scrollWidth, lineRight: el.getBoundingClientRect().right };
  });
  expect(m.titleClipped, 'the long title is what truncates').toBe(true);
  expect(m.countRight).toBeLessThanOrEqual(m.lineRight + 0.5);
  expect(m.countWidth).toBeGreaterThanOrEqual(m.countScroll - 0.5);
});

test('C8-21 one board at 320 with a long name and the WP tag: the compact face stays inside its own box (final review M1)', async ({ page, request }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const { orgId } = await signUpFresh(page);
  await loadedBoard(page, request, orgId, 'A rather long board name', 1);   // protected: the WP tag exists
  await page.goto('/library');
  const trigger = page.getByTestId('drives-compact');
  await expect(page.getByTestId('drives-compact-wp')).toBeVisible();
  const right = (await trigger.boundingBox())!;
  const spill = await trigger.evaluate((el) => {
    const r = el.getBoundingClientRect().right;
    return [...el.querySelectorAll<HTMLElement>('*')]
      .filter((c) => c.getClientRects().length > 0)
      .map((c) => c.getBoundingClientRect().right - r)
      .filter((d) => d > 0.5);
  });
  expect(spill, `children past the border at ${right.x + right.width}`).toEqual([]);
  await noSideways(page);
});
