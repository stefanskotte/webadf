import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { signUpFresh, runTag } from './helpers';
import { seedDisk, cleanupSeeded, hydrated } from './device-helpers';

// Library multi-select at 390 (spec §6, Ruling 20; §8 e2e 8). The mobile project emulates touch: tap, never hover.
test.describe.configure({ timeout: 120_000 });
test.afterAll(async () => { await cleanupSeeded(); });

const sha = (s: string) => createHash('sha256').update(`multisel-m-${s}`).digest('hex');
async function seedTitles(orgId: string, prefix: string, n: number) {
  const run = runTag();
  const out: { gameId: string; title: string }[] = [];
  for (let i = 1; i <= n; i++) {
    const title = `${prefix} ${String(i).padStart(2, '0')} ${run}`;
    const { gameId } = await seedDisk(orgId, { title, diskNo: 1, sha256: sha(`${run}-${prefix}-${i}`) });
    out.push({ gameId, title });
  }
  return out;
}
const noSideways = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
const box = async (page: Page, testId: string) => (await page.getByTestId(testId).boundingBox())!;

test('MS-M1 at 390: a 44 x 44 toggle the size of the view toggle, the bar on two lines with 44 px buttons, nothing sideways, a full-screen dialog', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const [a] = await seedTitles(orgId, 'Phone', 2);
  await page.goto('/library');
  await expect(page.getByTestId('library-select-toggle')).toBeVisible();
  const t = await box(page, 'library-select-toggle');
  // The C7 rule (.seg-item min-height 44 below sm) lifts the h-10 to 44, for ViewToggle too: the toggle matches it.
  const v = (await page.getByRole('link', { name: 'Grid view' }).boundingBox())!;
  expect([Math.round(t.width), Math.round(t.height)]).toEqual([44, 44]);
  expect([Math.round(v.width), Math.round(v.height)]).toEqual([44, 44]);

  await hydrated(page, 'library-select-toggle');
  await page.getByTestId('library-select-toggle').tap();
  await expect(page.getByTestId('library-selection-bar')).toBeVisible();
  const all = await box(page, 'library-select-page');
  const buttons = await Promise.all(['library-bulk-move', 'library-bulk-delete', 'library-selection-cancel'].map((id) => box(page, id)));
  for (const b of buttons) {
    expect(b.height).toBeGreaterThanOrEqual(44);
    expect(Math.round(b.y)).toBe(Math.round(buttons[0].y));   // one line of three
    expect(b.y).toBeGreaterThan(all.y + all.height);           // below "All on this page": the second line
  }
  const bar = await box(page, 'library-selection-bar');
  expect(bar.x).toBeGreaterThanOrEqual(16);
  expect(bar.x + bar.width).toBeLessThanOrEqual(390 - 16);
  await noSideways(page);

  // A tap on the card ticks it.
  await hydrated(page, 'select-title', 'onChange');
  const card = page.locator(`[data-testid="game-card"][data-game-id="${a.gameId}"]`);
  await card.tap();
  await expect(card).toHaveAttribute('data-selected', 'true');
  await expect(page.getByTestId('library-selection-count')).toHaveText('1 title selected');

  // The dialog is full screen below sm.
  await page.getByTestId('library-bulk-delete').tap();
  const d = await box(page, 'bulk-delete-dialog');
  expect([Math.round(d.x), Math.round(d.y), Math.round(d.width), Math.round(d.height)]).toEqual([0, 0, 390, 844]);
  const confirm = await box(page, 'bulk-delete-confirm');
  expect(confirm.height).toBeGreaterThanOrEqual(44);
  await page.getByTestId('bulk-delete-close').tap();
  await expect(page.getByTestId('bulk-delete-dialog')).toBeHidden();
  await noSideways(page);
});

test('MS-M2 at 390 the table row is four tracks with the box first; a tap ticks; the facts line stays', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const [a] = await seedTitles(orgId, 'PhoneRow', 2);
  await page.goto('/library?view=table');
  await hydrated(page, 'library-select-toggle');
  await page.getByTestId('library-select-toggle').tap();
  const row = page.locator(`[data-testid="game-row"][data-game-id="${a.gameId}"]`);
  await expect(row.locator('[data-meta]')).toBeVisible();
  const cols = await row.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  expect(cols).toBe(4);
  const rb = (await row.boundingBox())!;
  const bb = (await row.getByTestId('select-title').boundingBox())!;
  expect(bb.x - rb.x).toBeLessThan(28);
  expect(rb.height).toBeGreaterThanOrEqual(44);
  await hydrated(page, 'select-title', 'onChange');
  await row.tap();
  await expect(row).toHaveAttribute('data-selected', 'true');
  await noSideways(page);
});
